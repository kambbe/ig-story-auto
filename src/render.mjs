// render.mjs
// schedule.json → 今日の状態を計算 → テンプレに流し込み → 1080x1920 PNG を出力
//
//   node src/render.mjs                    → 今日の営業案内を out/story.png に出力（今までどおり）
//   node src/render.mjs 2026-07-15         → 指定日でテスト出力 out/story-2026-07-15.png
//   node src/render.mjs --calendar 2026-12 → カレンダーの試し出し out/calendar-2026-12.png（投稿しない）
//                                            2026-12-04 のように日まで書くと、その日に「今日」の印
//   node src/render.mjs --blog 145         → ブログ更新カードの試し出し out/blog-145.png（投稿しない）
//                                            ID を省くといちばん新しい記事。日付を足すとその日の背景で出す
//   試し出しに --bg photo / --bg solid を付けると背景を切り替えて出す（out/…-photo.png など）
//
//   STATE_DIR=state node src/render.mjs    → 本番（ワークフロー用）。
//     state/ の記録（last_posted.txt・last_calendar.txt・last_blog_post.txt）を見て、
//     その朝に出すものだけ作る：out/story.png → out/calendar.png → out/blog-1.png・blog-2.png
//     投稿する順に out/posts.tsv（画像 / 記録ファイル / 記録する値）、
//     投稿せず記録だけするもの（初回）を out/records.tsv に書く
//
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { getStatus, jstParts } from './status.mjs';
import {
  isPostingDay, firstPostingDay, calendarMap,
  fetchLatestPosts, fetchPost, postsSince, blogMap,
} from './cards.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const BLOG_MAX = 2;          // 1回に出すブログ更新カードの上限（新しいほうから）
const CARD_BG = 'solid';     // 追加カードの背景：'solid'（--bg の単色）/ 'photo'（営業案内と同じ写真）

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
    const timeRe = /^\d{1,2}:\d{2}$/; // HH:MM
    if (p.length === 2 && timeRe.test(p[0]) && timeRe.test(p[1])) {
      out[date] = note ? { open: p[0], close: p[1], note } : { open: p[0], close: p[1] };
    } else {
      // 「-18:00」「18:00」「12-18」など不正な値 → 事故防止でこの行は無視（休業にしない）＋警告
      console.warn(`[sheet] ${date} の営業時間「${hours}」が不正 → 行を無視（休業にはしません）。休業にしたい場合は営業時間を空欄に、時間変更は「12:00-18:00」の形で。`);
    }
  }
  return out;
}

async function loadSchedule() {
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
  return schedule;
}

// 見た目の共通部分：theme（色）の上書きCSSと、その日の背景写真
async function lookFor(schedule, dateStr) {
  // theme（色）を :root 上書きCSSにする。設定が無ければ既定色のまま。
  const t = schedule.theme || {};
  const theme = `:root{${t.accent ? `--accent:${t.accent};` : ''}${t.background ? `--bg:${t.background};` : ''}}`;

  // 背景画像を用意して file:// URL にする
  const bgSrc = await pickBackground(dateStr);
  let bgStyle = '';
  if (bgSrc) {
    const bgFile = await prepareBackground(bgSrc, OUT);
    bgStyle = `--bg-url: url('${pathToFileURL(bgFile).href}');`;
    console.log(`[bg] using ${path.basename(bgSrc)}`);
  } else {
    console.log('[bg] 背景画像なし（黒背景）');
  }
  return { theme, bgStyle };
}

// 追加カードの背景。'solid' なら写真を敷かず --bg の単色にする
function cardLook(look, mode = CARD_BG) {
  return mode === 'solid'
    ? { THEME: look.theme, BODY_STYLE: '', BG_CLASS: 'no-photo' }
    : { THEME: look.theme, BODY_STYLE: look.bgStyle, BG_CLASS: look.bgStyle ? 'has-photo' : 'no-photo' };
}

// テンプレ → HTML → Playwright で撮る。1回の実行でブラウザは1つだけ立ち上げて使い回す
function createShooter() {
  let browser = null;
  return {
    async shoot(templateFile, map, outPath, tweak = (h) => h) {
      const html = tweak(fill(await readFile(path.join(__dirname, templateFile), 'utf8'), map));

      // 差し込み後のHTMLを書き出し、そのファイルをブラウザで開く（file://origin なので画像が読める）
      const htmlPath = outPath.replace(/\.png$/, '.html');
      await writeFile(htmlPath, html, 'utf8');
      if (process.env.EMIT_ONLY === '1') { console.log(`[emit] ${htmlPath}`); return htmlPath; }

      browser ??= await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
      try {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });

        // Webフォントと背景画像・<img> の描画完了を待ってから撮影。<img> が読めなければ失敗にする
        const broken = await page.evaluate(async () => {
          await document.fonts.ready;
          const el = document.querySelector('.bg');
          const bg = el && getComputedStyle(el).backgroundImage;
          const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
          if (m) { const img = new Image(); img.src = m[1]; try { await img.decode(); } catch {} }
          const imgs = [...document.images];
          await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
          return imgs.filter((i) => !i.naturalWidth).map((i) => i.src);
        });
        if (broken.length) throw new Error(`画像が読み込めない: ${broken.join(', ')}`);
        await page.waitForTimeout(150);

        await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
      } finally {
        await page.close();
      }
      return outPath;
    },
    async close() { await browser?.close(); },
  };
}

// ---- 3種類のカード ----

async function shootStory(shooter, schedule, s, look, outPath) {
  const map = {
    BODY_CLASS: s.isOpen ? 'is-open' : 'is-closed',
    BODY_STYLE: look.bgStyle,
    THEME: look.theme,
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
  // 備考が無い日は空のnote要素を消す（余白が出ないように）
  const tweak = (html) => (s.note ? html : html.replace(/<div class="note[^"]*">\s*<\/div>/g, ''));
  await shooter.shoot('template.html', map, outPath, tweak);

  console.log(`[render] ${s.isOpen ? 'OPEN' : 'CLOSED'}  ${s.date}(${s.weekdayJa}) -> ${outPath}`);
  if (!s.isOpen && s.nextOpen) {
    console.log(`         next open: ${s.nextOpen.dateLabel}(${s.nextOpen.weekdayJa}) ${s.nextOpen.hours.open}-${s.nextOpen.hours.close}`);
  }
}

async function shootCalendar(shooter, schedule, ym, todayYmd, look, outPath, bgMode) {
  const map = { ...cardLook(look, bgMode), ...calendarMap(schedule, ym, todayYmd) };
  // 曜日ごとに営業時間が違う店は「いつもの営業時間」の行を出さない
  const tweak = (html) => (map.BASE_HOURS ? html : html.replace(/<div class="base">[\s\S]*?<\/div>/, ''));
  await shooter.shoot('template-calendar.html', map, outPath, tweak);
  console.log(`[render] CALENDAR ${ym}（今日の印 ${todayYmd}） -> ${outPath}`);
}

async function shootBlog(shooter, post, look, outPath, bgMode) {
  const map = { ...cardLook(look, bgMode), ...blogMap(post) };
  // タイトルはアイキャッチ画像に入っているので消す。アイキャッチが無い記事は、画像の枠を消してタイトルを出す
  const tweak = (html) =>
    post.image
      ? html.replace(/<h1 class="title">[\s\S]*?<\/h1>/, '')
      : html.replace(/<figure class="eyecatch">[\s\S]*?<\/figure>/, '');
  await shooter.shoot('template-blog.html', map, outPath, tweak);
  console.log(`[render] BLOG #${post.id}「${post.title}」 -> ${outPath}`);
}

// ---- 実行モード ----

function parseArgs(argv) {
  const a = { date: null, calendar: null, blog: null, bg: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
    if (v === '--calendar') { a.calendar = next ?? ''; if (next) i++; }
    else if (v === '--blog') { a.blog = next ?? ''; if (next) i++; }
    else if (v === '--bg') { a.bg = next; if (next) i++; }
    else a.date = v;
  }
  if (a.bg && !['photo', 'solid'].includes(a.bg)) throw new Error('--bg は photo か solid');
  return a;
}

function baseDateOf(args) {
  return args.date ? new Date(`${args.date}T12:00:00+09:00`) : new Date();
}

// 今まで：その日の営業案内だけ
async function storyOnly(schedule, args, shooter) {
  const s = getStatus(schedule, baseDateOf(args));
  const outPath = path.join(OUT, args.date ? `story-${s.date}.png` : 'story.png');

  // 定休日は投稿しない（postClosedDays=false）。ただし臨時休業は告知したいので投稿する。
  if (!isPostingDay(schedule, s)) {
    await rm(outPath, { force: true }).catch(() => {});
    console.log(`[skip] ${s.date}(${s.weekdayJa}) は定休日のため投稿しません`);
    return;
  }
  await shootStory(shooter, schedule, s, await lookFor(schedule, s.date), outPath);
}

// 試し出し：カレンダー
async function trialCalendar(schedule, args, shooter) {
  const m = (args.calendar || jstParts(new Date()).ymd.slice(0, 7)).match(/^(\d{4}-\d{2})(?:-(\d{2}))?$/);
  if (!m) throw new Error('--calendar は 2026-12 か 2026-12-04 の形で');
  const ym = m[1];
  // 日を省いたら、その月で実際にカレンダーが出る朝（最初に投稿する日）に印
  const today = m[2] ? `${ym}-${m[2]}` : (firstPostingDay(schedule, ym) ?? `${ym}-01`);
  const look = await lookFor(schedule, today);
  const outPath = path.join(OUT, `calendar-${ym}${args.bg ? `-${args.bg}` : ''}.png`);
  await shootCalendar(shooter, schedule, ym, today, look, outPath, args.bg ?? CARD_BG);
}

// 試し出し：ブログ更新カード
async function trialBlog(schedule, args, shooter) {
  if (!schedule.blogUrl) throw new Error('schedule.json の blogUrl が空');
  const post = args.blog
    ? await fetchPost(schedule.blogUrl, args.blog)
    : (await fetchLatestPosts(schedule.blogUrl, 1))[0];
  if (!post) throw new Error('公開記事が見つからない');
  // 日付（2026-12-01 など）を一緒に渡すと、その日の営業案内と同じ背景で出す
  const look = await lookFor(schedule, args.date ?? jstParts(new Date()).ymd);
  const outPath = path.join(OUT, `blog-${post.id}${args.bg ? `-${args.bg}` : ''}.png`);
  await shootBlog(shooter, post, look, outPath, args.bg ?? CARD_BG);
}

async function readState(dir) {
  const read = async (f) => {
    try { return (await readFile(path.join(dir, f), 'utf8')).trim() || null; } catch { return null; }
  };
  return {
    lastPosted: await read('last_posted.txt'),
    lastCalendar: await read('last_calendar.txt'),
    lastBlog: await read('last_blog_post.txt'),
  };
}

// GitHub Actions の画面に黄色い注意として出す（ローカルではただのログ）
function warn(msg) {
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `[warn] ${msg}`);
}

// 本番：記録を見て、その朝に出すものだけ作る
async function daily(schedule, args, shooter) {
  const s = getStatus(schedule, baseDateOf(args));
  const state = await readState(process.env.STATE_DIR);
  const posts = [];    // [画像, 記録ファイル, 値]：投稿に成功したら記録する
  const records = [];  // [記録ファイル, 値]：投稿せず記録だけ（初回）

  for (const f of ['story.png', 'calendar.png', 'blog-1.png', 'blog-2.png', 'posts.tsv', 'records.tsv']) {
    await rm(path.join(OUT, f), { force: true });
  }

  if (!isPostingDay(schedule, s)) {
    console.log(`[skip] ${s.date}(${s.weekdayJa}) は定休日のため投稿しません`);
  } else {
    const look = await lookFor(schedule, s.date);
    const storyDue = state.lastPosted !== s.date;

    // 1) 営業案内
    if (storyDue) {
      await shootStory(shooter, schedule, s, look, path.join(OUT, 'story.png'));
      posts.push(['story.png', 'last_posted.txt', s.date]);
    } else {
      console.log(`[story] ${s.date} は投稿済み`);
    }

    // 2) 営業カレンダー：その月で最初に投稿する朝に1回
    if (schedule.calendar) {
      const ym = s.date.slice(0, 7);
      if (!state.lastCalendar) {
        records.push(['last_calendar.txt', ym]);
        console.log(`[calendar] 初回：${ym} はカードにせず記録だけ（来月から出す）`);
      } else if (state.lastCalendar === ym) {
        console.log(`[calendar] ${ym} は投稿済み`);
      } else {
        try {
          await shootCalendar(shooter, schedule, ym, s.date, look, path.join(OUT, 'calendar.png'));
          posts.push(['calendar.png', 'last_calendar.txt', ym]);
        } catch (e) {
          warn(`カレンダーを作れなかった（次の実行でまた試す）: ${e.message}`);
        }
      }
    }

    // 3) ブログ更新：前回カードにした記事より新しい公開記事を、新しい2本まで。古い順に出す
    if (schedule.blogUrl) {
      try {
        if (!state.lastBlog) {
          const [latest] = await fetchLatestPosts(schedule.blogUrl, 1);
          if (latest) records.push(['last_blog_post.txt', latest.id]);
          console.log(`[blog] 初回：今ある記事はカードにせず、最新 #${latest?.id ?? '-'} を記録だけ`);
        } else {
          const { posts: fresh, resetTo } = await postsSince(schedule.blogUrl, state.lastBlog);
          if (resetTo) {
            records.push(['last_blog_post.txt', resetTo]);
            warn(`前回の記事 #${state.lastBlog} が見つからない → 最新 #${resetTo} で記録し直す`);
          }
          // 営業案内を出したあとの実行（予備のスケジュールなど）では、その日に公開された記事は次の投稿の朝に回す
          const due = (storyDue ? fresh : fresh.filter((p) => p.dateJst < s.date)).slice(0, BLOG_MAX).reverse();
          if (!fresh.length) console.log('[blog] 新しい記事なし');
          else if (!due.length) console.log('[blog] 今日公開の記事は、次の投稿の朝に出す');
          for (const [i, post] of due.entries()) {
            const file = `blog-${i + 1}.png`;
            await shootBlog(shooter, post, look, path.join(OUT, file));
            posts.push([file, 'last_blog_post.txt', post.id]);
          }
        }
      } catch (e) {
        // 通信失敗など → ブログ更新カードだけ出さず、ほかは続ける（記録しないので次の実行でまた試す）
        warn(`ブログ更新カードを作れなかった（ほかは続ける）: ${e.message}`);
      }
    }
  }

  await writeFile(path.join(OUT, 'posts.tsv'), posts.map((r) => r.join('\t') + '\n').join(''), 'utf8');
  await writeFile(path.join(OUT, 'records.tsv'), records.map((r) => r.join('\t') + '\n').join(''), 'utf8');
  console.log(`[plan] 投稿 ${posts.length}枚: ${posts.map((r) => r[0]).join(' → ') || 'なし'}`);
  if (records.length) console.log(`[plan] 記録だけ: ${records.map((r) => `${r[0]}=${r[1]}`).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const schedule = await loadSchedule();
  await mkdir(OUT, { recursive: true });

  const shooter = createShooter();
  try {
    if (args.calendar !== null) await trialCalendar(schedule, args, shooter);
    else if (args.blog !== null) await trialBlog(schedule, args, shooter);
    else if (process.env.STATE_DIR) await daily(schedule, args, shooter);
    else await storyOnly(schedule, args, shooter);
  } finally {
    await shooter.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
