import { BadRequestException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { kolkataNow, monthEnd, monthShift, monthStart } from '../../common/util/time';

const VALID_STATUSES = new Set(['present', 'absent', 'leave']);
const VALID_PERIODS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private db: DatabaseService,
    private notifications: NotificationsService,
  ) {}

  /** Faculty-facing roster with any existing marks for the slot. */
  async roster(facultyId: string, sectionId: string, date: string, period: string) {
    if (!sectionId || !isUuid(sectionId)) throw new BadRequestException('sectionId must be a UUID');
    if (!DATE_RE.test(date) || isNaN(new Date(`${date}T00:00:00Z`).getTime())) throw new BadRequestException('date must be YYYY-MM-DD');
    if (!VALID_PERIODS.has(period)) throw new BadRequestException('period must be one of h1..h6');

    const section = await this.db.queryOne(`select id, label from sections where id = $1`, [sectionId]);
    if (!section) throw new NotFoundException('Section not found');

    // Faculty must be assigned to this section (class teacher or timetable slot)
    const assigned = await this.db.queryOne(
      `select 1 from sections sec
        where sec.id=$1 and (
          sec.class_teacher_id=$2
          or exists (select 1 from timetable_slots t where t.section_id=sec.id and t.faculty_id=$2)
        )`,
      [sectionId, facultyId],
    );
    if (!assigned) throw new NotFoundException('Section not found');

    const students = await this.db.query<any>(`
      select u.id, sp.student_id as "studentId", sp.roll_no as "rollNo", u.display_name as name
        from student_profiles sp join users u on u.id = sp.user_id
       where sp.section_id = $1
       order by sp.roll_no
    `, [sectionId]);

    const session = await this.db.queryOne<any>(`
      select id from attendance_sessions
       where section_id = $1 and session_date = $2::date and period = $3
    `, [sectionId, date, period]);

    const marks: Record<string, string> = {};
    if (session) {
      const rows = await this.db.query<any>(
        `select student_id, status from attendance_records where session_id = $1`,
        [session.id],
      );
      rows.forEach((r) => (marks[r.student_id] = r.status));
    }

    // Editable only on the class date (Asia/Kolkata) until midnight IST
    const todayRow = await this.db.queryOne<{ today: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text as today`);
    const kolkataToday = todayRow?.today ?? kolkataNow().today;
    const editable = date === kolkataToday;
    const editableUntil = editable ? `${kolkataToday}T23:59:59+05:30` : null;

    return { sessionExists: !!session, editable, editableUntil, marks, students };
  }

  /** Bulk mark: upsert session + all records in one transaction. Editable only on class date midnight IST. */
  async mark(facultyId: string, dto: { sectionId: string; date: string; period: string; subjectId?: string; records: { studentId: string; status: string }[] }) {
    if (!Array.isArray(dto.records) || dto.records.length === 0) {
      throw new BadRequestException('records must not be empty');
    }
    for (const r of dto.records) {
      if (!VALID_STATUSES.has(r.status)) {
        throw new BadRequestException(`Invalid status "${r.status}" (present|absent|leave)`);
      }
    }
    if (!isUuid(dto.sectionId)) throw new BadRequestException('sectionId must be a UUID');
    if (!DATE_RE.test(dto.date) || isNaN(new Date(`${dto.date}T00:00:00Z`).getTime())) throw new BadRequestException('date must be YYYY-MM-DD');
    if (!VALID_PERIODS.has(dto.period)) throw new BadRequestException('period must be one of h1..h6');
    if (dto.subjectId && !isUuid(dto.subjectId)) throw new BadRequestException('subjectId must be a UUID');
    // duplicate student check
    const seen = new Set<string>();
    for (const r of dto.records) {
      if (seen.has(r.studentId)) throw new BadRequestException(`Duplicate student ${r.studentId}`);
      seen.add(r.studentId);
    }

    const result = await this.db.tx(async (client) => {
      // Date cutoff — authoritative DB Asia/Kolkata date
      const todayRow = await client.query<{ today: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text as today`);
      const today = todayRow.rows[0]?.today;
      if (dto.date !== today) {
        throw new UnprocessableEntityException({
          code: 'ATTENDANCE_NOT_EDITABLE',
          message: 'Attendance can be marked or edited only on the class date before midnight IST.',
        });
      }

      // Section exists
      const section = await client.query(`select id from sections where id=$1`, [dto.sectionId]);
      if (section.rows.length === 0) throw new NotFoundException('Section not found');

      // Faculty assigned to section?
      const assigned = await client.query(
        `select 1 from sections sec
          where sec.id=$1 and (
            sec.class_teacher_id=$2
            or exists (select 1 from timetable_slots t where t.section_id=sec.id and t.faculty_id=$2)
          )`,
        [dto.sectionId, facultyId],
      );
      if (assigned.rows.length === 0) throw new NotFoundException('Section not found');

      // Subject exists if provided
      if (dto.subjectId) {
        const subj = await client.query(`select id from subjects where id=$1`, [dto.subjectId]);
        if (subj.rows.length === 0) throw new BadRequestException('Unknown subjectId');
      }

      // Every student must belong to this section
      const studentIdsParam = dto.records.map((r) => r.studentId);
      const belong = await client.query(
        `select user_id from student_profiles where section_id=$1 and user_id = any($2::uuid[])`,
        [dto.sectionId, studentIdsParam],
      );
      if (belong.rows.length !== dto.records.length) {
        throw new BadRequestException('One or more students do not belong to this section');
      }

      const session = await client.query(
        `insert into attendance_sessions (section_id, subject_id, session_date, period, marked_by)
         values ($1, $2, $3::date, $4, $5)
         on conflict (section_id, session_date, period)
         do update set marked_by = $5, subject_id = coalesce($2, attendance_sessions.subject_id)
         returning id`,
        [dto.sectionId, dto.subjectId ?? null, dto.date, dto.period, facultyId],
      );
      const sessionId = session.rows[0].id;

      // Prior statuses before the upsert overwrites them — only students who are
      // NEWLY absent (previously present/leave/unmarked) get a push, so editing
      // marks never re-spams an already-absent student.
      const priorRows = await client.query<{ student_id: string; status: string }>(
        `select student_id, status from attendance_records where session_id = $1`,
        [sessionId],
      );
      const prior = new Map(priorRows.rows.map((r) => [r.student_id, r.status]));

      const counts = { present: 0, absent: 0, leave: 0 };
      const studentIds: string[] = [];
      const statuses: string[] = [];
      for (const r of dto.records) {
        counts[r.status as keyof typeof counts]++;
        studentIds.push(r.studentId);
        statuses.push(r.status);
      }

      await client.query(
        `insert into attendance_records (session_id, student_id, status)
         select $1, u.sid, u.st
           from unnest($2::uuid[], $3::attendance_status[]) as u(sid, st)
         on conflict (session_id, student_id)
         do update set status = excluded.status, marked_at = now()`,
        [sessionId, studentIds, statuses],
      );

      const newlyAbsent = dto.records
        .filter((r) => r.status === 'absent' && prior.get(r.studentId) !== 'absent')
        .map((r) => r.studentId);
      return { counts, newlyAbsent };
    });

    // Push after the tx commits — a push outage must never roll back attendance.
    if (result.newlyAbsent.length > 0) {
      void this.notifyAbsentStudents(result.newlyAbsent, dto).catch((err) =>
        this.logger.warn(`absent push failed: ${(err as Error).message}`),
      );
    }
    return { counts: result.counts };
  }

  /** Tell newly-absent students they were marked absent (fire-and-forget). */
  private async notifyAbsentStudents(
    studentIds: string[],
    dto: { date: string; period: string; subjectId?: string },
  ) {
    let subject = 'a class';
    if (dto.subjectId) {
      const subj = await this.db.queryOne<{ name: string }>(`select name from subjects where id = $1`, [
        dto.subjectId,
      ]);
      if (subj?.name) subject = subj.name;
    }
    const periodNo = dto.period.startsWith('h') ? dto.period.slice(1) : dto.period;
    await this.notifications.sendSystem({
      kind: 'attendance_absent',
      title: 'Absent Marked',
      message: `You were marked absent for ${subject} on ${dto.date} (Period ${periodNo}). If this is a mistake, contact your class teacher.`,
      recipients: studentIds.map((id) => ({ id, role: 'student' as const })),
    });
    this.logger.log(`absent push → ${studentIds.length} students (${subject}, ${dto.date} P${periodNo})`);
  }

  /** Per-day drill-down for the student calendar: which periods/subjects. */
  async dayDetail(studentId: string, date: string) {
    if (!DATE_RE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const rows = await this.db.query<any>(
      `select s.period, r.status, sub.code, sub.name as subject,
              to_char(s.session_date, 'YYYY-MM-DD') as date
         from attendance_records r
         join attendance_sessions s on s.id = r.session_id
         left join subjects sub on sub.id = s.subject_id
        where r.student_id = $1 and s.session_date = $2::date
        order by s.period`,
      [studentId, date],
    );
    return { date, periods: rows };
  }

  /** Faculty history: last N sessions for a section+period (read-only browse). */
  async history(facultyId: string, sectionId: string, period: string, limit = 30) {
    if (!isUuid(sectionId)) throw new BadRequestException('sectionId must be a UUID');
    if (!VALID_PERIODS.has(period)) throw new BadRequestException('period must be one of h1..h6');
    const n = Math.min(Math.max(Number(limit) || 30, 1), 90);
    const assigned = await this.db.queryOne(
      `select 1 from sections sec
        where sec.id=$1 and (
          sec.class_teacher_id=$2
          or exists (select 1 from timetable_slots t where t.section_id=sec.id and t.faculty_id=$2)
        )`,
      [sectionId, facultyId],
    );
    if (!assigned) throw new NotFoundException('Section not found');
    return this.db.query<any>(
      `select s.id as "sessionId", to_char(s.session_date,'YYYY-MM-DD') as date, s.period,
              sub.code as subject,
              sum(case when r.status='present' then 1 else 0 end)::int as present,
              sum(case when r.status='absent' then 1 else 0 end)::int as absent,
              sum(case when r.status='leave' then 1 else 0 end)::int as "leave",
              count(*)::int as total
         from attendance_sessions s
         left join attendance_records r on r.session_id = s.id
         left join subjects sub on sub.id = s.subject_id
        where s.section_id = $1 and s.period = $2
        group by s.id, s.session_date, s.period, sub.code
        order by s.session_date desc
        limit $3`,
      [sectionId, period, n],
    );
  }

  /** Admin overview: section-wise attendance % + defaulters (<75%). */
  async adminOverview() {
    const sections = await this.db.query<any>(
      `select sec.id, sec.label,
              count(r.*)::int as total,
              coalesce(sum(case when r.status='present' then 1 else 0 end),0)::int as present,
              coalesce(round(100.0 * sum(case when r.status='present' then 1 else 0 end) / nullif(count(r.*),0)),0)::int as percentage
         from sections sec
         left join attendance_sessions s on s.section_id = sec.id
         left join attendance_records r on r.session_id = s.id
        group by sec.id, sec.label
        order by sec.label`,
    );
    const defaulters = await this.db.query<any>(
      `select u.display_name as name, sp.student_id as "studentId", sec.label as section,
              count(*)::int as total,
              sum(case when r.status='present' then 1 else 0 end)::int as present,
              round(100.0 * sum(case when r.status='present' then 1 else 0 end) / nullif(count(*),0))::int as percentage
         from attendance_records r
         join student_profiles sp on sp.user_id = r.student_id
         join users u on u.id = r.student_id
         join attendance_sessions s on s.id = r.session_id
         join sections sec on sec.id = s.section_id
        group by u.display_name, sp.student_id, sec.label
        having count(*) >= 3 and round(100.0 * sum(case when r.status='present' then 1 else 0 end) / nullif(count(*),0)) < 75
        order by percentage asc
        limit 100`,
    );
    return { sections, defaulters, required: 75 };
  }

  /** Full student attendance page payload. */
  async myAttendance(studentId: string, month?: string) {
    const monthPattern = /^\d{4}-\d{2}$/;
    const now = kolkataNow();
    const target = month && monthPattern.test(month) ? month : now.ym;

    // Plain date parameters (sargable — no computed expressions on columns).
    const calStart = monthStart(target);                  // requested month, day 1
    const calEnd = monthEnd(target);                      // requested month, last day
    const viewedStart = monthStart(target);               // viewed month (for "This Month" label)
    const viewedNext = monthStart(monthShift(target, 1)); // viewed month end
    const prevYm = monthShift(target, -1);
    const prevStart = monthStart(prevYm);
    const prevNext = monthStart(target);

    const [totals, subjects, calendar, quick] = await Promise.all([
      // Merged summary + overview: they used to be two identical full-history scans.
      this.db.queryOne<any>(`
        select coalesce(sum(case when r.status = 'present' then 1 else 0 end), 0)::int as present,
               coalesce(sum(case when r.status = 'absent' then 1 else 0 end), 0)::int as absent,
               coalesce(sum(case when r.status = 'leave' then 1 else 0 end), 0)::int as leave,
               count(*)::int as total
          from attendance_records r
         where r.student_id = $1
      `, [studentId]),
      this.db.query<any>(`
        select sub.id, sub.code, sub.name as subject,
               count(*)::int as held,
               sum(case when r.status = 'present' then 1 else 0 end)::int as attended,
               round(100.0 * sum(case when r.status = 'present' then 1 else 0 end) / nullif(count(*), 0))::int as percentage
          from attendance_records r
          join attendance_sessions s on s.id = r.session_id
          join subjects sub on sub.id = s.subject_id
         where r.student_id = $1 and s.subject_id is not null
         group by sub.id, sub.code, sub.name
         order by sub.code
      `, [studentId]),
      this.db.query<any>(`
        with days as (
          select generate_series($2::date, $3::date, interval '1 day')::date as d
        )
        select to_char(days.d, 'YYYY-MM-DD') as date,
               coalesce(cnt.total, 0)::int as classes,
               case
                 when coalesce(cnt.total, 0) = 0 then 'none'
                 when cnt.present = cnt.total then 'present'
                 when cnt.leaveonly = cnt.total then 'leave'
                 when cnt.present = 0 and cnt.leaveonly = 0 then 'absent'
                 else 'mixed'
               end as status
          from days
          left join (
            select s.session_date,
                   count(*) as total,
                   sum(case when r.status = 'present' then 1 else 0 end) as present,
                   sum(case when r.status = 'leave' then 1 else 0 end) as leaveonly
              from attendance_records r
              join attendance_sessions s on s.id = r.session_id
             where r.student_id = $1
               and s.session_date between $2::date and $3::date
             group by s.session_date
          ) cnt on cnt.session_date = days.d
         order by days.d
      `, [studentId, calStart, calEnd]),
      this.db.queryOne<any>(`
        select
          coalesce(round(100.0 * (sum(case when r.status = 'present' then 1 else 0 end)
               filter (where s.session_date >= $2::date and s.session_date < $3::date))
               / nullif(count(*) filter (where s.session_date >= $2::date and s.session_date < $3::date), 0)), 0)::int as "viewedMonth",
          coalesce(round(100.0 * (sum(case when r.status = 'present' then 1 else 0 end)
               filter (where s.session_date >= $4::date and s.session_date < $5::date))
               / nullif(count(*) filter (where s.session_date >= $4::date and s.session_date < $5::date), 0)), 0)::int as "prevMonth",
          coalesce(round(100.0 * sum(case when r.status = 'present' then 1 else 0 end)
               / nullif(count(*), 0)), 0)::int as "overallAvg"
        from attendance_records r
        join attendance_sessions s on s.id = r.session_id
       where r.student_id = $1
      `, [studentId, viewedStart, viewedNext, prevStart, prevNext]),
    ]);

    const total = totals?.total ?? 0;
    const present = totals?.present ?? 0;
    return {
      summary: {
        overall: total ? Math.round((present / total) * 100) : 0,
        present,
        absent: totals?.absent ?? 0,
        leave: totals?.leave ?? 0,
        total,
      },
      subjects: subjects.map((s: any) => ({ ...s, percentage: s.percentage ?? 0 })),
      overview: [
        { label: 'Present', value: totals?.present ?? 0 },
        { label: 'Absent', value: totals?.absent ?? 0 },
        { label: 'Leave', value: totals?.leave ?? 0 },
      ],
      calendar: calendar.map((c: any) => ({ date: c.date, status: c.status ?? 'none', classes: Number(c.classes ?? 0) })),
      quickStats: {
        viewedMonth: quick?.viewedMonth ?? 0,
        prevMonth: quick?.prevMonth ?? 0,
        overallAvg: quick?.overallAvg ?? 0,
        // Back-compat aliases for older frontends:
        thisMonth: quick?.viewedMonth ?? 0,
        lastMonth: quick?.prevMonth ?? 0,
        semesterAvg: quick?.overallAvg ?? 0,
        required: 75,
      },
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean { return UUID_RE.test(v); }
