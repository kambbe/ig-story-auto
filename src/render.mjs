// render.mjs
// schedule.json → 今日の状態を計算 → template.html に流し込み → 1080x1920 PNG を出力
//
//   node src/render.mjs                → 今日の分を out/story.png に出力
//   node src/render.mjs 2026-07-15     → 指定日でテスト出力
//
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { getStatus } from './status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const HEIC_EXT = ['.heic', '.heif'];               // iPhone写真。内部でJPEGに変換して使う
const ALL_EXT = [...IMG_EXT, ...HEIC_EXT];

// backgrounds/ から日替わりで1枚選ぶ。
// 経過日数ベースの巡回：連続する日は必ず次の1枚へ進み、全部使い切ってから最初に戻る（抜け・重複なし）。同じ日は同じ画像。
async function pickBackground(dateStr) {
  const dir = path.join(ROOT, 'backgrounds');
  if (!existsSync(dir)) return null;

  const all = await readdir(dir);
  const files = all.filter((f) => ALL_EXT.includes(path.extname(f).toLowerCase())).sort();

  if (files.length === 0) {
    const others = all.filter((f) => !f.startsWith('.') && !f.endsWith('.txt'));
    if (others.length) {
      console.warn(`[bg] 対応外の形式のみ: ${others.join(', ')}  → .jpg / .png / .webp / .heic に対応`);
    }
    return null;
  }

  // 1970-01-01 からの経過日数。連続する日は +1 されるので、名前順に1枚ずつ巡回する。
  const dayIndex = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000);
  const file = files[((dayIndex % files.length) + files.length) % files.length];
  return path.join(dir, file);
}

// ブラウザで読める画像ファイルのパスを返す。HEICはJPEGに変換して out/ に書き出す。
async function prepareBackground(filePath, outDir) {
  const ext = path.extname(filePath).toLowerCase();
  if (HEIC_EXT.includes(ext)) {
    const convert = (await import('heic-convert')).default;
    const jpeg = await convert({ buffer: await readFile(filePath), format: 'JPEG', quality: 0.9 });
    const dest = path.join(outDir, '_bg.jpg');
    await writeFile(dest, jpeg);
    return dest;
  }
  return path.resolve(filePath);
}

function fmt(t) { return t; } // "11:00" のまま。加工したければここで。

function fill(tpl, map) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (map[k] ?? ''));
}

// ---- Googleスプレッドシート（公開CSV）から臨時休業/時間変更を読む ----
// 列: A=日付(YYYY-MM-DD) / B=営業時間(例 14:00-18:00) / C=備考(任意の一言)
//   営業時間が空 → 臨時休業 / 「14:00-18:00」→ 時間変更 / 備考はストーリーに表示
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normDate(s) {
  const m = String(s).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}

async function fetchSheetOverrides(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  const out = {};
  for (const r of rows) {
    const date = normDate(r[0] || '');
    if (!date) continue; // ヘッダーや空行はスキップ
    const hours = (r[1] || '').trim();
    const note = (r[2] || '').trim();
    if (!hours) {                                        // 空 → 臨時休業
      out[date] = note ? { closed: true, note } : null;
      continue;
    }
    const p = hours.split(/[-–—〜～~]/).map((x) => x.trim());
    if (p.length >= 2 && p[0] && p[1]) {
      out[date] = note ? { open: p[0], close: p[1], note } : { open: p[0], close: p[1] };
    } else {
      out[date] = note ? { closed: true, note } : null;
    }
  }
  return out;
}

async function main() {
  const arg = process.argv[2]; // 任意: YYYY-MM-DD
  const baseDate = arg ? new Date(`${arg}T12:00:00+09:00`) : new Date();

  const schedule = JSON.parse(await readFile(path.join(ROOT, 'schedule.json'), 'utf8'));

  // スプレッドシートの臨時休業/時間変更を取り込む（失敗してもJSONのoverridesで継続）
  if (schedule.overridesSheetCsvUrl) {
    try {
      const sheet = await fetchSheetOverrides(schedule.overridesSheetCsvUrl);
      schedule.overrides = { ...(schedule.overrides || {}), ...sheet };
      console.log(`[sheet] 臨時設定を読み込み: ${Object.keys(sheet).length}件`);
    } catch (e) {
      console.warn(`[sheet] 読み込み失敗（JSONのoverridesで継続）: ${e.message}`);
    }
  }

  const s = getStatus(schedule, baseDate);

  const outDir = path.join(ROOT, 'out');
  await mkdir(outDir, { recursive: true });

  // 定休日は投稿しない（postClosedDays=false）。ただし臨時休業は告知したいので投稿する。
  if (!s.isOpen && !s.temporaryClosure && schedule.postClosedDays === false) {
    const skipPath = path.join(outDir, arg ? `story-${s.date}.png` : 'story.png');
    await rm(skipPath, { force: true }).catch(() => {});
    console.log(`[skip] ${s.date}(${s.weekdayJa}) は定休日のため投稿しません`);
    return null;
  }

  // 背景画像を用意して file:// URL にする
  const bgSrc = await pickBackground(s.date);
  let bodyStyle = '';
  if (bgSrc) {
    const bgFile = await prepareBackground(bgSrc, outDir);
    bodyStyle = `--bg-url: url('${pathToFileURL(bgFile).href}');`;
    console.log(`[bg] using ${path.basename(bgSrc)}`);
  } else {
    console.log('[bg] 背景画像なし（黒背景）');
  }

  // theme（色）を :root 上書きCSSにする。設定が無ければ既定色のまま。
  const t = schedule.theme || {};
  const themeCss = `:root{${t.accent ? `--accent:${t.accent};` : ''}${t.background ? `--bg:${t.background};` : ''}}`;

  const map = {
    BODY_CLASS: s.isOpen ? 'is-open' : 'is-closed',
    BODY_STYLE: bodyStyle,
    THEME: themeCss,
    SHOP_NAME: schedule.shopName,
    LOCATION: schedule.location || '',
    DATE_LABEL: s.dateLabel,
    WEEKDAY: s.weekdayJa,
    // open
    OPEN: s.hours ? fmt(s.hours.open) : '',
    CLOSE: s.hours ? fmt(s.hours.close) : '',
    NOTE: s.note || '',
    // closed
    NEXT_DATE: s.nextOpen ? s.nextOpen.dateLabel : '',
    NEXT_WEEKDAY: s.nextOpen ? s.nextOpen.weekdayJa : '',
    NEXT_OPEN: s.nextOpen ? fmt(s.nextOpen.hours.open) : '',
    NEXT_CLOSE: s.nextOpen ? fmt(s.nextOpen.hours.close) : '',
  };

  let html = await readFile(path.join(__dirname, 'template.html'), 'utf8');
  html = fill(html, map);
  // 備考が無い日は空のnote要素を消す（余白が出ないように）
  if (!s.note) html = html.replace(/<div class="note[^"]*">\s*<\/div>/g, '');

  const outName = arg ? `story-${s.date}.png` : 'story.png';
  const outPath = path.join(outDir, outName);

  // 差し込み後のHTMLを書き出し、そのファイルをブラウザで開く（file://origin なので画像が読める）
  const htmlPath = outPath.replace(/\.png$/, '.html');
  await writeFile(htmlPath, html, 'utf8');
  if (process.env.EMIT_ONLY === '1') { console.log(`[emit] ${htmlPath}`); return htmlPath; }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });

  // Webフォントと背景画像の描画完了を待ってから撮影
  await page.evaluate(async () => {
    await document.fonts.ready;
    const el = document.querySelector('.bg');
    const bg = el && getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
    if (m) { const img = new Image(); img.src = m[1]; try { await img.decode(); } catch {} }
  });
  await page.waitForTimeout(150);

  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
  await browser.close();

  console.log(`[render] ${s.isOpen ? 'OPEN' : 'CLOSED'}  ${s.date}(${s.weekdayJa}) -> ${outPath}`);
  if (!s.isOpen && s.nextOpen) {
    console.log(`         next open: ${s.nextOpen.dateLabel}(${s.nextOpen.weekdayJa}) ${s.nextOpen.hours.open}-${s.nextOpen.hours.close}`);
  }
  return outPath;
}

main().catch((e) => { console.error(e); process.exit(1); });
