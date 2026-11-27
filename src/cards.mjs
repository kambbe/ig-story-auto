// cards.mjs
// 営業案内のあとに続ける追加カード（営業カレンダー・ブログ更新）の中身を作る。
// 撮影（テンプレ → HTML → PNG）は render.mjs が受け持つ。ここは「何を載せるか」だけ。
import { getStatus, jstParts } from './status.mjs';

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// render.mjs と同じ基準の「その朝に営業案内を投稿する日か」。
// 定休日は出さない（postClosedDays=false）。臨時休業は告知するので出す。
export function isPostingDay(schedule, s) {
  return s.isOpen || s.temporaryClosure || schedule.postClosedDays !== false;
}

function dayDate(ym, d) {
  return new Date(`${ym}-${String(d).padStart(2, '0')}T12:00:00+09:00`);
}

function daysIn(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// その月で営業案内を最初に投稿する日（YYYY-MM-DD）。無ければ null
export function firstPostingDay(schedule, ym) {
  for (let d = 1; d <= daysIn(ym); d++) {
    const s = getStatus(schedule, dayDate(ym, d));
    if (isPostingDay(schedule, s)) return s.date;
  }
  return null;
}

function sameHours(a, b) {
  return !!a && !!b && a.open === b.open && a.close === b.close;
}

// 週の固定営業時間がすべて同じならその時間。曜日で違うなら null（＝営業日は全部時間を出す）
function baseHours(schedule) {
  const vals = DOW_KEYS.map((k) => schedule.regular[k]).filter((v) => v && v.open);
  if (!vals.length) return null;
  return vals.every((v) => sameHours(v, vals[0])) ? { open: vals[0].open, close: vals[0].close } : null;
}

// ---- 営業カレンダー ----
// 日ごとに getStatus で 営業／休業／時間変更 を出す（スプレッドシートの臨時設定も反映済みの schedule を渡す）
export function calendarMap(schedule, ym, todayYmd) {
  const [y, m] = ym.split('-').map(Number);
  const base = baseHours(schedule);
  const cells = [];

  const lead = jstParts(dayDate(ym, 1)).dow; // 日曜始まり
  for (let i = 0; i < lead; i++) cells.push('<div class="day is-blank"></div>');

  for (let d = 1; d <= daysIn(ym); d++) {
    const s = getStatus(schedule, dayDate(ym, d));
    const cls = ['day'];
    let sub = '';
    if (!s.isOpen) {
      cls.push('is-closed');
      sub = 'CLOSED';
    } else if (!sameHours(s.hours, base)) {
      cls.push('is-changed');
      sub = `${s.hours.open}<span class="sep">–</span>${s.hours.close}`;
    }
    if (s.date === todayYmd) cls.push('is-today');
    cells.push(`<div class="${cls.join(' ')}"><span class="num">${d}</span><span class="sub">${sub}</span></div>`);
  }

  return {
    YEAR: String(y),
    MONTH_NAME: MONTHS[m - 1],
    CELLS: cells.join('\n'),
    BASE_HOURS: base ? `${base.open}<span class="sep">–</span>${base.close}` : '',
  };
}

// ---- ブログ更新 ----
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function apiBase(blogUrl) {
  return `${blogUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts`;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function toPost(p) {
  const media = p._embedded?.['wp:featuredmedia']?.[0];
  return {
    id: String(p.id),
    dateGmt: p.date_gmt,                                   // "2026-11-23T10:53:54"（比較用）
    dateJst: jstParts(new Date(`${p.date_gmt}Z`)).ymd,     // 公開日（JST）
    title: decodeEntities(String(p.title?.rendered ?? '').replace(/<[^>]*>/g, '')).trim(),
    image: media?.source_url || '',
  };
}

// 公開記事の新しい順（WordPress の既定の並び＝公開日の新しい順）
export async function fetchLatestPosts(blogUrl, perPage = 5) {
  const list = await getJson(`${apiBase(blogUrl)}?_embed&per_page=${perPage}`);
  return list.map(toPost);
}

export async function fetchPost(blogUrl, id) {
  return toPost(await getJson(`${apiBase(blogUrl)}/${encodeURIComponent(id)}?_embed`));
}

// lastId（前回カードにした記事）より新しい公開記事を、新しい順で返す。
// 記事 ID は公開順とは限らないので、並び順（公開日）で比べる。
// 戻り値 { posts, resetTo }：resetTo があるときは前回の記事が消えていたので、その ID で記録し直す
export async function postsSince(blogUrl, lastId) {
  const latest = await fetchLatestPosts(blogUrl);
  const idx = latest.findIndex((p) => p.id === String(lastId));
  if (idx >= 0) return { posts: latest.slice(0, idx) };

  // 新しい記事が5本より多い、または前回の記事が見つからない → 前回の記事の公開日で比べる
  try {
    const last = await fetchPost(blogUrl, lastId);
    return { posts: latest.filter((p) => p.dateGmt > last.dateGmt) };
  } catch (e) {
    if (e.status === 404 || e.status === 401 || e.status === 403) {
      // 前回の記事が非公開・削除された。古い記事を出し直さないよう、いまの最新で記録し直す
      return { posts: [], resetTo: latest[0]?.id ?? null };
    }
    throw e;
  }
}

export function blogMap(post) {
  return {
    IMAGE_URL: escapeHtml(post.image),
    TITLE: escapeHtml(post.title),
  };
}
