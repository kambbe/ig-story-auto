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

// その日の設定オブジェクトを返す。
//   {open,close,note?} = 営業 / null = 休業 / {closed:true,note} = 休業＋一言
function hoursFor(schedule, ymd, dowKey) {
  if (Object.prototype.hasOwnProperty.call(schedule.overrides || {}, ymd)) {
    return schedule.overrides[ymd];
  }
  return schedule.regular[dowKey] ?? null;
}

// 「営業」とみなせる値だけ返す（open がある場合のみ）。休業系は null。
function openVal(v) {
  return (v && v.open) ? v : null;
}

export function getStatus(schedule, baseDate = new Date()) {
  const today = jstParts(baseDate);
  const todayVal = hoursFor(schedule, today.ymd, DOW_KEYS[today.dow]);
  const todayHours = openVal(todayVal);
  const isOpen = !!todayHours;
  // 臨時休業＝「普段は開けている日を、その日だけ閉める」。元々定休日の日は含めない（投稿しない）。
  const overrideExists = Object.prototype.hasOwnProperty.call(schedule.overrides || {}, today.ymd);
  const regularOpenToday = !!(schedule.regular[DOW_KEYS[today.dow]]);
  const temporaryClosure = !isOpen && overrideExists && regularOpenToday;

  const result = {
    shopName: schedule.shopName,
    location: schedule.location || '',
    date: today.ymd,
    dateLabel: `${today.m}/${today.d}`,
    weekdayJa: DOW_JA[today.dow],
    isOpen,
    temporaryClosure,                   // true = 臨時休業（告知したい）/ false = 定休日
    hours: todayHours,                  // {open, close, note?} or null
    note: todayVal?.note || '',         // 営業日・休業日どちらの一言も拾う
    nextOpen: null,                     // 休業日だけ埋める
  };

  if (!isOpen) {
    for (let i = 1; i <= 14; i++) {
      const d = new Date(baseDate.getTime() + i * 86400000);
      const p = jstParts(d);
      const h = openVal(hoursFor(schedule, p.ymd, DOW_KEYS[p.dow]));
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
