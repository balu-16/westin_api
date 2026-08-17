/**
 * In-process Kolkata (Asia/Kolkata) wall-clock helpers.
 *
 * Replaces the `now() at time zone 'Asia/Kolkata'` DB round-trips that used to
 * run on nearly every dashboard/timetable request. The formatter is created
 * once; formatting a Date is a pure CPU operation (~µs), so no result caching
 * is needed.
 */

export type KolkataNow = {
  /** 0=Mon..5=Sat, -1=Sunday — matches timetable_slots.day. */
  todayDow: number;
  /** Minute of day (0..1439) in Asia/Kolkata. */
  minutes: number;
  /** YYYY-MM-DD in Asia/Kolkata. */
  today: string;
  /** YYYY-MM of the current Kolkata month. */
  ym: string;
  /** YYYY-MM of the previous Kolkata month. */
  lastYm: string;
};

/** Mon=0..Sat=5, Sun=-1 — Postgres `dow` remapped to the timetable convention. */
const DOW_BY_WEEKDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: -1,
};

const kolkataFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function kolkataNow(date: Date = new Date()): KolkataNow {
  const parts = kolkataFormatter.formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const weekday = get('weekday');

  const ym = `${year}-${month}`;
  return {
    todayDow: DOW_BY_WEEKDAY[weekday] ?? -1,
    minutes: Number(hour) * 60 + Number(minute),
    today: `${year}-${month}-${day}`,
    ym,
    lastYm: monthShift(ym, -1),
  };
}

/** Shift a YYYY-MM string by `delta` months (delta may be negative). */
export function monthShift(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

/** First day (YYYY-MM-01) of a YYYY-MM month. */
export function monthStart(ym: string): string {
  return `${ym}-01`;
}

/** Last day (inclusive) of a YYYY-MM month as YYYY-MM-DD. */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(lastDay).padStart(2, '0')}`;
}
