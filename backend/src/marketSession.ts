/**
 * NSE cash/F&O session calendar in Asia/Kolkata (IST = UTC+05:30, no DST).
 * Normal market: 09:15-15:30 IST, Monday-Friday, excluding exchange holidays.
 * Holidays must come from the official NSE circular; years not listed here are
 * reported as "calendar not verified" so callers can treat them cautiously.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
export const SESSION_OPEN_MINUTES = 9 * 60 + 15;
export const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

export interface HolidayCalendar {
  year: number;
  source: string;
  sourceUrl: string;
  verifiedOn: string;
  holidays: Record<string, string>;
}

// Weekday trading holidays from NSE's official holiday master (CM segment;
// the FO list is identical). Weekend-dated entries are omitted because
// weekends are closed anyway. Special sessions (e.g. Muhurat trading on
// 2026-11-08 18:00-19:00 IST) are deliberately treated as closed for forecasting.
export const NSE_HOLIDAY_CALENDARS: HolidayCalendar[] = [
  {
    year: 2026,
    source: 'NSE trading holiday master (equity segment)',
    sourceUrl: 'https://www.nseindia.com/api/holiday-master?type=trading',
    verifiedOn: '2026-10-10',
    holidays: {
      '2026-01-15': 'Municipal Corporation election (Maharashtra)',
      '2026-01-26': 'Republic Day',
      '2026-03-03': 'Holi',
      '2026-03-26': 'Shri Ram Navami',
      '2026-03-31': 'Shri Mahavir Jayanti',
      '2026-04-03': 'Good Friday',
      '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
      '2026-05-01': 'Maharashtra Day',
      '2026-05-28': 'Bakri Id',
      '2026-06-26': 'Muharram',
      '2026-09-14': 'Ganesh Chaturthi',
      '2026-10-02': 'Mahatma Gandhi Jayanti',
      '2026-10-20': 'Dussehra',
      '2026-11-10': 'Diwali Balipratipada',
      '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
      '2026-12-25': 'Christmas'
    }
  }
];

export type SessionState = 'open' | 'pre-open' | 'post-close' | 'weekend' | 'holiday';

export interface MarketStatus {
  state: SessionState;
  open: boolean;
  dateKey: string;
  sessionOpenAt: number | null;
  sessionCloseAt: number | null;
  nextOpenAt: number | null;
  holidayName?: string;
  calendarVerified: boolean;
}

/** YYYY-MM-DD of the given instant in IST. */
export function istDateKey(time: number) {
  return new Date(time + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinutes(time: number) {
  const shifted = new Date(time + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60;
}

function weekday(dateKey: string) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Epoch ms for an IST wall-clock time on the given IST date. */
export function istTime(dateKey: string, minutes: number) {
  return Date.parse(`${dateKey}T00:00:00Z`) + minutes * 60 * 1000 - IST_OFFSET_MS;
}

export function calendarFor(dateKey: string, calendars = NSE_HOLIDAY_CALENDARS) {
  const year = Number(dateKey.slice(0, 4));
  return calendars.find((calendar) => calendar.year === year);
}

export function holidayName(dateKey: string, calendars = NSE_HOLIDAY_CALENDARS) {
  return calendarFor(dateKey, calendars)?.holidays[dateKey];
}

export function isTradingDay(dateKey: string, calendars = NSE_HOLIDAY_CALENDARS) {
  const day = weekday(dateKey);
  if (day === 0 || day === 6) return false;
  return !holidayName(dateKey, calendars);
}

export function sessionBounds(dateKey: string) {
  return { open: istTime(dateKey, SESSION_OPEN_MINUTES), close: istTime(dateKey, SESSION_CLOSE_MINUTES) };
}

export function nextTradingDay(dateKey: string, calendars = NSE_HOLIDAY_CALENDARS) {
  let candidate = addDays(dateKey, 1);
  for (let guard = 0; guard < 15 && !isTradingDay(candidate, calendars); guard += 1) candidate = addDays(candidate, 1);
  return candidate;
}

export function previousTradingDay(dateKey: string, calendars = NSE_HOLIDAY_CALENDARS) {
  let candidate = addDays(dateKey, -1);
  for (let guard = 0; guard < 15 && !isTradingDay(candidate, calendars); guard += 1) candidate = addDays(candidate, -1);
  return candidate;
}

export function marketStatus(time: number, calendars = NSE_HOLIDAY_CALENDARS): MarketStatus {
  const dateKey = istDateKey(time);
  const calendarVerified = Boolean(calendarFor(dateKey, calendars));
  const day = weekday(dateKey);
  const holiday = holidayName(dateKey, calendars);
  const base = { dateKey, calendarVerified };
  if (day === 0 || day === 6 || holiday) {
    const next = nextTradingDay(dateKey, calendars);
    return {
      ...base,
      state: holiday ? 'holiday' : 'weekend',
      open: false,
      sessionOpenAt: null,
      sessionCloseAt: null,
      nextOpenAt: sessionBounds(next).open,
      holidayName: holiday
    };
  }
  const bounds = sessionBounds(dateKey);
  const minutes = istMinutes(time);
  if (minutes < SESSION_OPEN_MINUTES) {
    return { ...base, state: 'pre-open', open: false, sessionOpenAt: bounds.open, sessionCloseAt: bounds.close, nextOpenAt: bounds.open };
  }
  if (minutes >= SESSION_CLOSE_MINUTES) {
    return {
      ...base,
      state: 'post-close',
      open: false,
      sessionOpenAt: bounds.open,
      sessionCloseAt: bounds.close,
      nextOpenAt: sessionBounds(nextTradingDay(dateKey, calendars)).open
    };
  }
  return { ...base, state: 'open', open: true, sessionOpenAt: bounds.open, sessionCloseAt: bounds.close, nextOpenAt: null };
}

export interface IntradayTarget {
  ok: true;
  targetAt: number;
  horizonMinutes: number;
  /** True when the nominal horizon was cut short by the session close. */
  truncatedAtClose: boolean;
}

export interface IntradaySkip {
  ok: false;
  reason: 'market-closed' | 'too-close-to-close' | 'calendar-unverified';
  detail: string;
}

/**
 * Intraday forecast target: now + horizon, capped at today's close. Never
 * rolls into the next session; returns a skip when too little time remains.
 */
export function intradayTarget(
  time: number,
  horizonMinutes: number,
  minimumMinutes: number,
  calendars = NSE_HOLIDAY_CALENDARS,
  /** Backtests replay real exchange candles, which already prove the day traded. */
  requireVerifiedCalendar = true
): IntradayTarget | IntradaySkip {
  const status = marketStatus(time, calendars);
  if (requireVerifiedCalendar && !status.calendarVerified) {
    return { ok: false, reason: 'calendar-unverified', detail: `No verified NSE holiday calendar for ${status.dateKey.slice(0, 4)}.` };
  }
  if (!status.open || status.sessionCloseAt == null) {
    return { ok: false, reason: 'market-closed', detail: `Market ${status.state}.` };
  }
  const nominal = time + horizonMinutes * 60 * 1000;
  const targetAt = Math.min(nominal, status.sessionCloseAt);
  const available = Math.floor((targetAt - time) / 60_000);
  if (available < minimumMinutes) {
    return { ok: false, reason: 'too-close-to-close', detail: `Only ${available} minutes remain before the close.` };
  }
  return { ok: true, targetAt, horizonMinutes: available, truncatedAtClose: targetAt < nominal };
}
