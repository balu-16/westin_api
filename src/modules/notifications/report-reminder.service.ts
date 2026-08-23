import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { kolkataNow } from '../../common/util/time';
import { NotificationsService } from './notifications.service';

/** Fire window per reminder — generous so event-loop drift can't skip a slot. */
const FIRE_WINDOW_MINUTES = 5;

/**
 * In-process scheduler for the daily-report reminder. The API is a single
 * long-running instance (no scheduler infra at this scale), so a 60s wall-clock
 * tick is enough: at 20:00 IST it warns "4 hours left", at 21:00 IST
 * "3 hours left" (deadline is midnight, matching the same-day rules for
 * attendance and daily reports). Faculty with every today-slot already
 * reported — or no slots at all (Sunday) — resolve to nobody and get nothing.
 */
const REMINDER_SLOTS: ReadonlyArray<{ minuteOfDay: number; hoursLeft: number }> = [
  { minuteOfDay: 20 * 60, hoursLeft: 4 },
  { minuteOfDay: 21 * 60, hoursLeft: 3 },
];

@Injectable()
export class ReportReminderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReportReminderService.name);
  private timer: NodeJS.Timeout | null = null;
  /** `${today}:${hoursLeft}` keys — each reminder fires at most once per day. */
  private readonly fired = new Set<string>();

  constructor(
    private db: DatabaseService,
    private notifications: NotificationsService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.tick(), 60_000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private tick() {
    try {
      const { todayDow, minutes, today } = kolkataNow();
      if (todayDow < 0) return; // Sunday — no timetable slots exist
      for (const slot of REMINDER_SLOTS) {
        const key = `${today}:${slot.hoursLeft}`;
        const inWindow = minutes >= slot.minuteOfDay && minutes < slot.minuteOfDay + FIRE_WINDOW_MINUTES;
        if (inWindow && !this.fired.has(key)) {
          this.fired.add(key);
          void this.remindPendingFaculty(slot.hoursLeft, todayDow, today).catch((err) =>
            this.logger.error(`daily-report reminder (${slot.hoursLeft}h) failed: ${(err as Error).message}`),
          );
        }
      }
      // Yesterday's guard entries are dead weight — drop them once the set grows.
      if (this.fired.size > REMINDER_SLOTS.length * 2) this.fired.clear();
    } catch (err) {
      this.logger.error(`reminder tick failed: ${(err as Error).message}`);
    }
  }

  /** Faculty (with their still-unreported subjects) for a given day — read-only. */
  async pendingFaculty(todayDow: number, today: string): Promise<Array<{ id: string; pending: string[] }>> {
    return this.db.query<{ id: string; pending: string[] }>(
      `select u.id, array_agg(distinct sub.name || ' (' || sec.label || ')') as pending
         from timetable_slots t
         join users u on u.id = t.faculty_id and u.role='faculty' and u.status='active'
         join subjects sub on sub.id = t.subject_id
         join sections sec on sec.id = t.section_id
        where t.day = $1
          and not exists (
            select 1 from daily_reports r
             where r.faculty_id = t.faculty_id
               and r.section_id = t.section_id
               and r.subject_id = t.subject_id
               and r.report_date = $2::date
          )
        group by u.id`,
      [todayDow, today],
    );
  }

  /** Push the reminder to every active faculty with at least one unreported slot today. */
  async remindPendingFaculty(hoursLeft: number, todayDow: number, today: string): Promise<number> {
    const rows = await this.pendingFaculty(todayDow, today);
    if (rows.length === 0) return 0;

    // One personalized send per faculty (their own pending subjects); this is a
    // background 8PM blast, so sequential sends are fine at this scale.
    for (const row of rows) {
      const listed = row.pending.slice(0, 3).join(', ') + (row.pending.length > 3 ? '…' : '');
      await this.notifications.sendSystem({
        kind: 'report_reminder',
        title: 'Daily Report Reminder',
        message:
          `Only ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} left to submit today's daily report` +
          `${listed ? ` (${listed})` : ''}. Please upload it before midnight.`,
        recipients: [{ id: row.id, role: 'faculty' }],
      });
    }
    this.logger.log(`daily-report reminder (${hoursLeft}h left) pushed to ${rows.length} faculty`);
    return rows.length;
  }
}
