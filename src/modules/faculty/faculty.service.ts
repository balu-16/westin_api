import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { kolkataNow } from '../../common/util/time';

@Injectable()
export class FacultyService {
  constructor(private db: DatabaseService) {}

  private toMinutes(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  async dashboard(facultyId: string) {
    const { todayDow, minutes } = kolkataNow();

    const todaySlots = await this.db.query<any>(`
      select t.id, to_char(t.start_time, 'HH24:MI') as "startTime",
             to_char(t.end_time, 'HH24:MI') as "endTime",
             sub.name as subject, sub.code, u.display_name as faculty, r.name as room,
             sec.label as section, sec.id as "sectionId", sub.id as "subjectId",
             exists (
               select 1 from attendance_sessions a
                where a.section_id = t.section_id
                  and a.subject_id = t.subject_id
                  and a.session_date = current_date
             ) as marked
        from timetable_slots t
        join subjects sub on sub.id = t.subject_id
        join faculty_profiles f on f.user_id = t.faculty_id join users u on u.id = f.user_id
        join rooms r on r.id = t.room_id join sections sec on sec.id = t.section_id
       where t.faculty_id = $1 and t.day = $2
       order by t.start_time
    `, [facultyId, todayDow]);

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

    const [sectionsCount, markedToday, announcements] = await Promise.all([
      this.db.queryOne<{ count: number }>(`
        select count(distinct section_id)::int as count from timetable_slots where faculty_id = $1
      `, [facultyId]),
      this.db.queryOne<{ count: number }>(`
        select count(*)::int as count from attendance_sessions
         where marked_by = $1 and session_date = current_date
      `, [facultyId]),
      this.db.query<any>(`
        select id, title, message, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as date, category
          from announcements order by created_at desc limit 5
      `),
    ]);

    const classesCompleted = sessions.filter((s) => s.status === 'completed').length;
    const pendingReports = todaySlots
      .filter((row) => !row.marked && minutes >= this.toMinutes(row.startTime))
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        section: row.section,
        subject: row.subject,
        date: new Date().toISOString().slice(0, 10),
        topic: `Attendance pending for ${row.startTime}`,
      }));

    return {
      stats: {
        classesToday: sessions.length,
        classesCompleted,
        sections: sectionsCount?.count ?? 0,
        pendingReports: pendingReports.length,
        attendanceMarked: markedToday?.count ?? 0,
      },
      pendingReports,
      todaySessions: sessions,
      announcements,
    };
  }

  async mySections(facultyId: string) {
    return this.db.query<any>(`
      select sec.id, sec.label, sec.department, sec.year,
             (select count(*)::int from student_profiles sp where sp.section_id = sec.id) as "studentCount",
             (sec.class_teacher_id = $1) as "isClassTeacher",
             coalesce((
               select array_agg(distinct sub.name)
                 from timetable_slots t2 join subjects sub on sub.id = t2.subject_id
                where t2.section_id = sec.id and t2.faculty_id = $1
             ), '{}') as subjects
        from sections sec
       where exists (
         select 1 from timetable_slots t where t.section_id = sec.id and t.faculty_id = $1
       ) or sec.class_teacher_id = $1
       order by sec.label
    `, [facultyId]);
  }

  async sectionStudents(sectionId: string) {
    const section = await this.db.queryOne(`select id from sections where id = $1`, [sectionId]);
    if (!section) throw new NotFoundException('Section not found');
    return this.db.query<any>(`
      select u.id, sp.student_id as "studentId", sp.roll_no as "rollNo",
             u.display_name as name, u.email, u.status,
             coalesce((
               select round(100.0 * sum(case when r.status = 'present' then 1 else 0 end) / nullif(count(*),0))::int
                 from attendance_records r where r.student_id = u.id
             ), 0) as attendance
        from student_profiles sp join users u on u.id = sp.user_id
       where sp.section_id = $1
       order by sp.roll_no
    `, [sectionId]);
  }
}
