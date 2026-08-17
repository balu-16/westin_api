import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { kolkataNow } from '../../common/util/time';

@Injectable()
export class StudentsService {
  constructor(private db: DatabaseService) {}

  private toMinutes(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  async dashboard(studentId: string) {
    const student = await this.db.queryOne<any>(`
      select sp.section_id, sec.label as section_label
        from student_profiles sp left join sections sec on sec.id = sp.section_id
       where sp.user_id = $1
    `, [studentId]);
    if (!student) throw new NotFoundException('Student profile not found');
    const sectionId = student.section_id;

    const { todayDow, minutes } = kolkataNow();

    const todaySlots = sectionId
      ? await this.db.query<any>(`
          select t.id, to_char(t.start_time, 'HH24:MI') as "startTime", to_char(t.end_time, 'HH24:MI') as "endTime",
                 sub.name as subject, sub.code, u.display_name as faculty, r.name as room, sec.label as section
            from timetable_slots t
            join subjects sub on sub.id = t.subject_id
            join faculty_profiles f on f.user_id = t.faculty_id join users u on u.id = f.user_id
            join rooms r on r.id = t.room_id join sections sec on sec.id = t.section_id
           where t.section_id = $1 and t.day = $2
           order by t.start_time
        `, [sectionId, todayDow])
      : [];

    const sessions = todaySlots.map((row) => ({
      id: row.id,
      subject: row.subject,
      code: row.code,
      faculty: row.faculty,
      startTime: row.startTime,
      endTime: row.endTime,
      room: row.room,
      section: row.section,
      status: minutes >= this.toMinutes(row.endTime) ? 'completed'
        : minutes >= this.toMinutes(row.startTime) ? 'in-progress' : 'upcoming',
    }));

    const [counts, attendance, subjects, announcements] = await Promise.all([
      this.db.queryOne<any>(`
        select count(*) filter (where t.section_id = $1 and t.day = $2)::int as "classesToday",
               (select count(distinct t2.subject_id)::int from timetable_slots t2 where t2.section_id = $1) as subjects
          from timetable_slots t
      `, [sectionId, todayDow]),
      this.db.queryOne<any>(`
        select coalesce(round(100.0 * sum(case when r.status = 'present' then 1 else 0 end) / nullif(count(*), 0)), 0)::int as overall
          from attendance_records r where r.student_id = $1
      `, [studentId]),
      this.db.query<any>(`
        select sub.name as subject, sub.code,
               count(*)::int as total,
               sum(case when r.status = 'present' then 1 else 0 end)::int as attended,
               coalesce(round(100.0 * sum(case when r.status = 'present' then 1 else 0 end) / nullif(count(*), 0)), 0)::int as percentage
          from attendance_records r
          join attendance_sessions s on s.id = r.session_id
          left join subjects sub on sub.id = s.subject_id
         where r.student_id = $1
         group by sub.name, sub.code
         order by sub.code
      `, [studentId]),
      this.db.query<any>(`
        select id, title, message, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as date, category
          from announcements
         where audience in ('all', 'students')
         order by created_at desc
         limit 5
      `),
    ]);

    const classesCompleted = sessions.filter((s) => s.status === 'completed').length;

    return {
      stats: {
        classesToday: counts?.classesToday ?? 0,
        classesCompleted,
        overallAttendance: attendance?.overall ?? 0,
        subjects: counts?.subjects ?? 0,
        pendingAssignments: 0,
      },
      todaySessions: sessions,
      subjectAttendance: subjects,
      announcements,
    };
  }

  async getSettings(studentId: string) {
    const row = await this.db.queryOne<any>(`
      select push, email, announcements, reminders, theme
        from user_settings where user_id = $1
    `, [studentId]);
    return row ?? { push: true, email: true, announcements: true, reminders: true, theme: 'light' };
  }

  async updateSettings(studentId: string, dto: Partial<{ push: boolean; email: boolean; announcements: boolean; reminders: boolean; theme: string }>) {
    const current = await this.getSettings(studentId);
    const merged = { ...current, ...dto };
    await this.db.query(`
      insert into user_settings (user_id, push, email, announcements, reminders, theme)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id) do update set push = $2, email = $3, announcements = $4, reminders = $5, theme = $6, updated_at = now()
    `, [studentId, merged.push, merged.email, merged.announcements, merged.reminders, merged.theme]);
    return merged;
  }
}
