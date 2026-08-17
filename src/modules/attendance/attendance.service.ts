import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { kolkataNow, monthEnd, monthShift, monthStart } from '../../common/util/time';

const VALID_STATUSES = new Set(['present', 'absent', 'leave']);

@Injectable()
export class AttendanceService {
  constructor(private db: DatabaseService) {}

  /** Faculty-facing roster with any existing marks for the slot. */
  async roster(sectionId: string, date: string, period: string) {
    const section = await this.db.queryOne(`select id from sections where id = $1`, [sectionId]);
    if (!section) throw new NotFoundException('Section not found');

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

    return { sessionExists: !!session, marks, students };
  }

  /** Bulk mark: upsert session + all records in one transaction. */
  async mark(facultyId: string, dto: { sectionId: string; date: string; period: string; subjectId?: string; records: { studentId: string; status: string }[] }) {
    if (!Array.isArray(dto.records) || dto.records.length === 0) {
      throw new BadRequestException('records must not be empty');
    }
    for (const r of dto.records) {
      if (!VALID_STATUSES.has(r.status)) {
        throw new BadRequestException(`Invalid status "${r.status}" (present|absent|leave)`);
      }
    }

    return this.db.tx(async (client) => {
      const session = await client.query(
        `insert into attendance_sessions (section_id, subject_id, session_date, period, marked_by)
         values ($1, $2, $3::date, $4, $5)
         on conflict (section_id, session_date, period)
         do update set marked_by = $5, subject_id = coalesce($2, attendance_sessions.subject_id)
         returning id`,
        [dto.sectionId, dto.subjectId ?? null, dto.date, dto.period, facultyId],
      );
      const sessionId = session.rows[0].id;

      const counts = { present: 0, absent: 0, leave: 0 };
      const studentIds: string[] = [];
      const statuses: string[] = [];
      for (const r of dto.records) {
        counts[r.status as keyof typeof counts]++;
        studentIds.push(r.studentId);
        statuses.push(r.status);
      }

      // One multi-row upsert instead of N single-row statements.
      await client.query(
        `insert into attendance_records (session_id, student_id, status)
         select $1, u.sid, u.st
           from unnest($2::uuid[], $3::attendance_status[]) as u(sid, st)
         on conflict (session_id, student_id)
         do update set status = excluded.status, marked_at = now()`,
        [sessionId, studentIds, statuses],
      );
      return { counts };
    });
  }

  /** Full student attendance page payload. */
  async myAttendance(studentId: string, month?: string) {
    const monthPattern = /^\d{4}-\d{2}$/;
    const now = kolkataNow();
    const target = month && monthPattern.test(month) ? month : now.ym;

    // Plain date parameters (sargable — no computed expressions on columns).
    const calStart = monthStart(target);                  // requested month, day 1
    const calEnd = monthEnd(target);                      // requested month, last day
    const thisStart = monthStart(now.ym);                 // current Kolkata month
    const nextStart = monthStart(monthShift(now.ym, 1));  // first day of next month
    const lastStart = monthStart(now.lastYm);             // previous Kolkata month

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
          left join subjects sub on sub.id = s.subject_id
         where r.student_id = $1
         group by sub.id, sub.code, sub.name
         order by sub.code
      `, [studentId]),
      this.db.query<any>(`
        with days as (
          select generate_series($2::date, $3::date, interval '1 day')::date as d
        )
        select to_char(days.d, 'YYYY-MM-DD') as date,
               case
                 when cnt.total = 0 then 'none'
                 when cnt.present = cnt.total then 'present'
                 when cnt.present = 0 then 'absent'
                 else 'mixed'
               end as status
          from days
          left join (
            select s.session_date,
                   count(*) as total,
                   sum(case when r.status = 'present' then 1 else 0 end) as present
              from attendance_records r
              join attendance_sessions s on s.id = r.session_id
             where r.student_id = $1
               and s.session_date between $2::date and $3::date
             group by s.session_date
          ) cnt on cnt.session_date = days.d
      `, [studentId, calStart, calEnd]),
      this.db.queryOne<any>(`
        select
          coalesce(round(100.0 * (sum(case when r.status = 'present' then 1 else 0 end)
               filter (where s.session_date >= $2::date and s.session_date < $3::date))
               / nullif(count(*) filter (where s.session_date >= $2::date and s.session_date < $3::date), 0)), 0)::int as "thisMonth",
          coalesce(round(100.0 * (sum(case when r.status = 'present' then 1 else 0 end)
               filter (where s.session_date >= $4::date and s.session_date < $2::date))
               / nullif(count(*) filter (where s.session_date >= $4::date and s.session_date < $2::date), 0)), 0)::int as "lastMonth",
          coalesce(round(100.0 * sum(case when r.status = 'present' then 1 else 0 end)
               / nullif(count(*), 0)), 0)::int as "semesterAvg"
        from attendance_records r
        join attendance_sessions s on s.id = r.session_id
       where r.student_id = $1
      `, [studentId, thisStart, nextStart, lastStart]),
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
      calendar: calendar.map((c: any) => ({ date: c.date, status: c.status ?? 'none' })),
      quickStats: {
        thisMonth: quick?.thisMonth ?? 0,
        lastMonth: quick?.lastMonth ?? 0,
        semesterAvg: quick?.semesterAvg ?? 0,
        required: 75,
      },
    };
  }
}
