// status.mjs
// 指定日(既定は今日, JST)の営業状態を計算する。
// - まず overrides(臨時) を見て、無ければ regular(曜日固定) を使う
// - 休業日なら次の営業日を最大14日先まで前方探索して返す

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_JA = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Date を JST の年月日・曜日インデックスに変換
function jstParts(date) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date); // "2026-07-10"

  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', weekday: 'short',
  }).format(date).toLowerCase().slice(0, 3); // "fri"

  const dow = DOW_KEYS.indexOf(short);
  const [y, m, d] = ymd.split('-').map(Number);
  return { ymd, dow, y, m, d };
}

// その日の営業時間オブジェクト(またはnull=休業)を返す
function hoursFor(schedule, ymd, dowKey) {
  if (Object.prototype.hasOwnProperty.call(schedule.overrides || {}, ymd)) {
    return schedule.overrides[ymd]; // null か {open,close,note}
  }
  return schedule.regular[dowKey] ?? null;
}

export function getStatus(schedule, baseDate = new Date()) {
  const today = jstParts(baseDate);
  const todayHours = hoursFor(schedule, today.ymd, DOW_KEYS[today.dow]);
  const isOpen = !!todayHours;

  const result = {
    shopName: schedule.shopName,
    location: schedule.location || '',
    date: today.ymd,
    dateLabel: `${today.m}/${today.d}`,
    weekdayJa: DOW_JA[today.dow],
    isOpen,
    hours: todayHours || null,          // {open, close, note?}
    note: todayHours?.note || '',
    nextOpen: null,                     // 休業日だけ埋める
  };

  if (!isOpen) {
    for (let i = 1; i <= 14; i++) {
      const d = new Date(baseDate.getTime() + i * 86400000);
      const p = jstParts(d);
      const h = hoursFor(schedule, p.ymd, DOW_KEYS[p.dow]);
      if (h) {
        result.nextOpen = {
          date: p.ymd,
          dateLabel: `${p.m}/${p.d}`,
          weekdayJa: DOW_JA[p.dow],
          hours: h,
        };
        break;
      }
    }
  }

  return result;
}

export { jstParts };
