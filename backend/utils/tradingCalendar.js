// utils/tradingCalendar.js
// ══════════════════════════════════════════════════════════════════════════
//  Official Indian exchange trading-holiday calendar. Used to tell an
//  ordinary weekend apart from a genuine "market closed" trading holiday
//  (Diwali, Holi, Republic Day, etc.) so that:
//    - marketDataService.isIndianMarketOpen() doesn't log/scan signals on a
//      holiday just because the clock+weekday check alone can't tell the
//      difference between "Tuesday, market open" and "Tuesday, Ram Navami".
//    - the admin "everyday accuracy" calendar can grey out real holidays
//      instead of showing them as blank/failed trading days.
//
//  Source: NSE circular NSE/CMTR/71775 (Dec 12, 2025), "Trading holidays for
//  the calendar year 2026". BSE equities observe the same weekday holidays.
//  MCX (commodity derivatives) publishes its own circular and occasionally
//  differs by a day or two around Diwali/Holi Muhurat sessions — until
//  MCX's own list is wired in separately, this same calendar is applied to
//  MCX_FO as the best available approximation.
//
//  IMPORTANT: this list is year-specific and must be refreshed every
//  December when the next calendar year's circular is published (NSE/BSE
//  and MCX both publish theirs on nseindia.com / mcxindia.com).
// ══════════════════════════════════════════════════════════════════════════

const TRADING_HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
  // Note: Nov 08, 2026 (Diwali Laxmi Pujan) falls on a Sunday and is not
  // listed here since it's already a non-trading day; Muhurat Trading that
  // evening is a special session outside the normal signal-scanning window.
];

const HOLIDAY_SET = new Set(TRADING_HOLIDAYS_2026);

/** Normalizes a Date object (interpreted as IST) or a 'YYYY-MM-DD' string
 *  into a plain 'YYYY-MM-DD' string for lookup/comparison. */
function toDateStr(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function isWeekend(dateStr) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return day === 0 || day === 6;
}

/** True for an ordinary trading day: not a Saturday/Sunday and not a
 *  published exchange holiday. */
function isTradingDay(d) {
  const dateStr = toDateStr(d);
  return !isWeekend(dateStr) && !HOLIDAY_SET.has(dateStr);
}

function isMarketHoliday(d) {
  return HOLIDAY_SET.has(toDateStr(d));
}

module.exports = { isTradingDay, isMarketHoliday, isWeekend, toDateStr, TRADING_HOLIDAYS_2026 };
