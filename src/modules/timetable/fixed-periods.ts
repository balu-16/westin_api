/** Single source of truth for the college bell schedule (12h display per product rule).
 *  Teaching slots are bookable; breaks/lunch are gaps and must never be booked.
 *  Times stored in DB as 24h HH:MM; frontend displays 12h.
 */
export interface FixedPeriod {
  id: string;
  /** 24h HH:MM for DB comparison */
  start24: string;
  end24: string;
  /** 12h display, e.g. "09:00 AM" */
  start12: string;
  end12: string;
  label: string;
}

export const FIXED_PERIODS: FixedPeriod[] = [
  { id: 'P1', start24: '09:00', end24: '10:00', start12: '09:00 AM', end12: '10:00 AM', label: 'Period 1 • 09:00 AM – 10:00 AM' },
  { id: 'P2', start24: '10:00', end24: '11:00', start12: '10:00 AM', end12: '11:00 AM', label: 'Period 2 • 10:00 AM – 11:00 AM' },
  // 11:00 AM – 11:15 AM break (non-bookable)
  { id: 'P3', start24: '11:15', end24: '12:30', start12: '11:15 AM', end12: '12:30 PM', label: 'Period 3 • 11:15 AM – 12:30 PM' },
  // 12:30 PM – 01:30 PM lunch (non-bookable)
  { id: 'P4', start24: '13:30', end24: '14:30', start12: '01:30 PM', end12: '02:30 PM', label: 'Period 4 • 01:30 PM – 02:30 PM' },
  { id: 'P5', start24: '14:30', end24: '15:30', start12: '02:30 PM', end12: '03:30 PM', label: 'Period 5 • 02:30 PM – 03:30 PM' },
  // 03:30 PM – 03:40 PM break (non-bookable)
  { id: 'P6', start24: '15:40', end24: '17:00', start12: '03:40 PM', end12: '05:00 PM', label: 'Period 6 • 03:40 PM – 05:00 PM' },
];

/** Non-bookable gaps rendered as grey rows in WeekOverview. */
export const FIXED_BREAKS = [
  { label: 'Break', start12: '11:00 AM', end12: '11:15 AM' },
  { label: 'Lunch Break', start12: '12:30 PM', end12: '01:30 PM' },
  { label: 'Break', start12: '03:30 PM', end12: '03:40 PM' },
];

const norm = (t: string) => t.trim().padStart(5, '0');

export function isFixedSlot(startTime: string, endTime: string): boolean {
  const s = norm(startTime);
  const e = norm(endTime);
  return FIXED_PERIODS.some((p) => p.start24 === s && p.end24 === e);
}

export function fixedSlotError(): string {
  const list = FIXED_PERIODS.map((p) => `${p.start12} – ${p.end12}`).join(', ');
  return `Time must match the fixed bell schedule: ${list}. Breaks/lunch cannot be booked.`;
}
