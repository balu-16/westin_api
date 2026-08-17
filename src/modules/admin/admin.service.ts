import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CacheService } from '../../common/cache/cache.service';
import { hashPassword } from '../../common/util/crypto';
import { pageParams, paginatedEnvelope } from '../../common/util/pagination';

const DEFAULT_PASSWORD = 'Password@123';

@Injectable()
export class AdminService {
  constructor(
    private db: DatabaseService,
    private cache: CacheService,
  ) {}

  // ---------- dashboard ----------

  async dashboard() {
    const [totalsRows, feed, upcoming] = await Promise.all([
      this.db.queryOne<any>(`
        select (select count(*)::int from users where role = 'faculty') as faculty,
               (select count(*)::int from users where role = 'student') as students,
               (select count(*)::int from events) as events,
               (select count(*)::int from daily_reports where report_date = current_date) as "reportsToday"
      `),
      this.db.query<any>(`
        (select 'login' as kind, u.display_name as actor, 'signed in' as action,
                coalesce(f.faculty_id, s.student_id, u.email) as target,
                to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as time, l.created_at as sort
           from login_logs l
           join users u on u.id = l.user_id
           left join faculty_profiles f on f.user_id = u.id
           left join student_profiles s on s.user_id = u.id
          order by l.created_at desc limit 4)
        union all
        (select 'report' as kind, u.display_name as actor, 'submitted report' as action,
                sec.label as target,
                to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as time, r.created_at as sort
           from daily_reports r
           join users u on u.id = r.faculty_id
           left join sections sec on sec.id = r.section_id
          order by r.created_at desc limit 2)
        union all
        (select 'event' as kind, coalesce(u.display_name, 'System') as actor, 'created event' as action,
                e.title as target,
                to_char(e.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as time, e.created_at as sort
           from events e left join users u on u.id = e.created_by
          order by e.created_at desc limit 2)
        order by sort desc
        limit 8
      `),
      this.db.query<any>(`
        select id, title, category, to_char(start_date, 'YYYY-MM-DD') as "startDate",
               to_char(end_date, 'YYYY-MM-DD') as "endDate", event_time as time,
               location, is_live as "isLive"
          from events
         where start_date >= current_date
         order by start_date
         limit 5
      `),
    ]);

    return {
      totals: {
        faculty: totalsRows?.faculty ?? 0,
        students: totalsRows?.students ?? 0,
        events: totalsRows?.events ?? 0,
        reportsToday: totalsRows?.reportsToday ?? 0,
      },
      activityFeed: feed.map((f) => ({
        id: `${f.kind}-${f.time}-${f.actor}`,
        actor: f.actor,
        action: f.action,
        target: f.target,
        time: f.time,
      })),
      upcomingEvents: upcoming,
    };
  }

  // ---------- teachers ----------

  listTeachers(page?: number | string, pageSize?: number | string) {
    const pg = pageParams(page, pageSize);
    return this.db
      .query<any>(`
        select u.id, f.faculty_id as "facultyId", u.display_name as name, u.email,
               f.designation, f.department, u.phone, u.status,
               coalesce((select array_agg(sub.code) from faculty_subjects fs
                          join subjects sub on sub.id = fs.subject_id
                         where fs.faculty_id = u.id), '{}') as subjects,
               count(*) over() as "__total"
          from users u join faculty_profiles f on f.user_id = u.id
         where u.role = 'faculty'
         order by f.faculty_id
         limit $1 offset $2
      `, [pg.limit, pg.offset])
      .then((rows) => paginatedEnvelope(rows, pg));
  }

  async createTeacher(dto: {
    name: string; email: string; facultyId?: string; designation?: string;
    department?: string; phone?: string; subjects?: string[];
  }) {
    const dup = await this.db.queryOne(`select 1 from users where lower(email) = lower($1)`, [dto.email]);
    if (dup) throw new ConflictException(`Email ${dto.email} already exists`);

    let facultyId = dto.facultyId;
    if (!facultyId) {
      const next = await this.db.queryOne<{ n: number }>(`
        select coalesce(max(nullif(regexp_replace(faculty_id, '\\D', '', 'g'), '')::int), 2024) + 1 as n
          from faculty_profiles where faculty_id like 'FAC-%'
      `);
      facultyId = `FAC-${new Date().getFullYear()}-${String(next?.n ?? 1).padStart(3, '0')}`;
    } else {
      const dupId = await this.db.queryOne(`select 1 from faculty_profiles where faculty_id = $1`, [facultyId]);
      if (dupId) throw new ConflictException(`Faculty id ${facultyId} already exists`);
    }

    return this.db.tx(async (client) => {
      const user = await client.query(
        `insert into users (role, email, password_hash, display_name, phone)
         values ('faculty', $1, null, $2, $3) returning id`,
        [dto.email.toLowerCase(), dto.name, dto.phone ?? null],
      );
      const userId = user.rows[0].id;
      await client.query(
        `insert into faculty_profiles (user_id, faculty_id, designation, department) values ($1, $2, $3, $4)`,
        [userId, facultyId, dto.designation ?? null, dto.department ?? null],
      );
      for (const subjectId of dto.subjects ?? []) {
        await client.query(`insert into faculty_subjects (faculty_id, subject_id) values ($1, $2)`, [userId, subjectId]);
      }
      return { id: userId, facultyId };
    });
  }

  async updateTeacher(id: string, dto: Partial<{ name: string; email: string; designation: string; department: string; phone: string; status: string; subjects: string[] }>) {
    const existing = await this.db.queryOne(
      `select u.id from users u join faculty_profiles f on f.user_id = u.id where u.id = $1`, [id],
    );
    if (!existing) throw new NotFoundException('Teacher not found');

    await this.db.tx(async (client) => {
      await client.query(`
        update users set display_name = coalesce($1, display_name),
                          email = coalesce($2, email),
                          phone = coalesce($3, phone),
                          status = coalesce($4::user_status, status),
                          updated_at = now()
         where id = $5
      `, [dto.name ?? null, dto.email?.toLowerCase() ?? null, dto.phone ?? null, dto.status ?? null, id]);
      await client.query(`
        update faculty_profiles set designation = coalesce($1, designation), department = coalesce($2, department)
         where user_id = $3
      `, [dto.designation ?? null, dto.department ?? null, id]);
      if (dto.subjects) {
        await client.query(`delete from faculty_subjects where faculty_id = $1`, [id]);
        for (const subjectId of dto.subjects) {
          await client.query(`insert into faculty_subjects (faculty_id, subject_id) values ($1, $2)`, [id, subjectId]);
        }
      }
    });
    return { id };
  }

  async deleteTeacher(id: string) {
    const existing = await this.db.queryOne(
      `select u.id from users u join faculty_profiles f on f.user_id = u.id where u.id = $1`, [id],
    );
    if (!existing) throw new NotFoundException('Teacher not found');
    await this.db.query(`delete from users where id = $1`, [id]);
    return { deleted: true };
  }

  // ---------- students ----------

  listStudents(sectionId?: string, search?: string, page?: number | string, pageSize?: number | string) {
    const pg = pageParams(page, pageSize);
    return this.db
      .query<any>(`
        select u.id, sp.student_id as "studentId", u.display_name as name, u.email,
               sec.label as section, sp.section_id as "sectionId", sp.year, sp.department,
               sp.roll_no as "rollNo", u.status,
               coalesce((
                 select round(100.0 * sum(case when r.status = 'present' then 1 else 0 end) / nullif(count(*), 0))::int
                   from attendance_records r where r.student_id = u.id
               ), 0) as attendance,
               count(*) over() as "__total"
          from users u
          join student_profiles sp on sp.user_id = u.id
          left join sections sec on sec.id = sp.section_id
         where u.role = 'student'
           and ($1::uuid is null or sp.section_id = $1::uuid)
           and ($2::text is null or u.display_name ilike '%' || $2::text || '%'
                or sp.student_id ilike '%' || $2::text || '%' or u.email ilike '%' || $2::text || '%')
         order by sec.label, sp.roll_no
         limit $3 offset $4
      `, [sectionId ?? null, search ?? null, pg.limit, pg.offset])
      .then((rows) => paginatedEnvelope(rows, pg));
  }

  /** Full student directory (same row shape as listStudents, unpaginated) in
   *  one query with a single grouped attendance aggregate — replaces the
   *  portals' page-walk over /api/admin/students, which re-ran the per-row
   *  attendance subquery once per page for every admin session. */
  directory() {
    return this.cache.wrap('students:directory', 60_000, () =>
      this.db.query(`
        select u.id, sp.student_id as "studentId", u.display_name as name, u.email,
               sec.label as section, sp.section_id as "sectionId", sp.year, sp.department,
               sp.roll_no as "rollNo", u.status,
               coalesce(a.pct, 0) as attendance
          from users u
          join student_profiles sp on sp.user_id = u.id
          left join sections sec on sec.id = sp.section_id
          left join (
            select student_id,
                   round(100.0 * sum(case when r.status = 'present' then 1 else 0 end) / nullif(count(*), 0))::int as pct
              from attendance_records r
             group by r.student_id
          ) a on a.student_id = u.id
         where u.role = 'student'
         order by sec.label, sp.roll_no
      `),
    );
  }

  async createStudent(dto: { name: string; email: string; sectionId: string; year: number; department?: string }) {
    const dup = await this.db.queryOne(`select 1 from users where lower(email) = lower($1)`, [dto.email]);
    if (dup) throw new ConflictException(`Email ${dto.email} already exists`);
    const section = await this.db.queryOne<{ id: string; label: string; max_strength: number; count: number }>(`
      select s.id, s.label, s.max_strength,
             (select count(*)::int from student_profiles sp where sp.section_id = s.id) as count
        from sections s where s.id = $1
    `, [dto.sectionId]);
    if (!section) throw new BadRequestException('Unknown section');
    if (section.count >= section.max_strength) {
      throw new ConflictException(`Section ${section.label} is at max strength`);
    }

    const next = await this.db.queryOne<{ n: number }>(`
      select coalesce(max(nullif(regexp_replace(student_id, '\\D', '', 'g'), '')::int), 2024999) + 1 as n
        from student_profiles where student_id like 'STU-%'
    `);
    const studentId = `STU-${new Date().getFullYear()}-${String((next?.n ?? 1) % 1000).padStart(3, '0')}`;
    const prefix = section.label.replace(/-\d+$/, '');
    const rollNo = `${prefix}-${String(section.count + 1).padStart(2, '0')}`;

    const created = await this.db.tx(async (client) => {
      const user = await client.query(
        `insert into users (role, email, password_hash, display_name)
         values ('student', $1, $2, $3) returning id`,
        [dto.email.toLowerCase(), hashPassword(DEFAULT_PASSWORD), dto.name],
      );
      const userId = user.rows[0].id;
      await client.query(
        `insert into student_profiles (user_id, student_id, section_id, year, department, roll_no)
         values ($1, $2, $3, $4, $5, $6)`,
        [userId, studentId, dto.sectionId, dto.year, dto.department ?? null, rollNo],
      );
      return { id: userId, studentId, rollNo };
    });
    this.cache.invalidate('students');
    this.cache.invalidate('sections');
    return created;
  }

  async updateStudent(id: string, dto: Partial<{ name: string; email: string; sectionId: string; year: number; department: string; status: string }>) {
    const existing = await this.db.queryOne(
      `select u.id from users u join student_profiles sp on sp.user_id = u.id where u.id = $1`, [id],
    );
    if (!existing) throw new NotFoundException('Student not found');
    await this.db.tx(async (client) => {
      await client.query(`
        update users set display_name = coalesce($1, display_name), email = coalesce($2, email),
                          status = coalesce($3::user_status, status), updated_at = now()
         where id = $4
      `, [dto.name ?? null, dto.email?.toLowerCase() ?? null, dto.status ?? null, id]);
      await client.query(`
        update student_profiles set section_id = coalesce($1, section_id), year = coalesce($2, year),
                                    department = coalesce($3, department)
         where user_id = $4
      `, [dto.sectionId ?? null, dto.year ?? null, dto.department ?? null, id]);
    });
    this.cache.invalidate('students');
    this.cache.invalidate('sections');
    return { id };
  }

  async deleteStudent(id: string) {
    const existing = await this.db.queryOne(
      `select u.id from users u join student_profiles sp on sp.user_id = u.id where u.id = $1`, [id],
    );
    if (!existing) throw new NotFoundException('Student not found');
    await this.db.query(`delete from users where id = $1`, [id]);
    this.cache.invalidate('students');
    this.cache.invalidate('sections');
    return { deleted: true };
  }

  // ---------- login logs ----------

  loginLogs(role: 'teacher' | 'student', limit = 10) {
    const userRole = role === 'teacher' ? 'faculty' : 'student';
    const capped = Math.min(Math.max(1, Math.floor(Number(limit)) || 10), 100);
    return this.db.query<any>(`
      select l.id, u.display_name as name,
             coalesce(f.faculty_id, s.student_id, u.email) as identifier,
             l.device, l.ip,
             to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as time
        from login_logs l
        join users u on u.id = l.user_id
        left join faculty_profiles f on f.user_id = u.id
        left join student_profiles s on s.user_id = u.id
       where u.role = $1::user_role
       order by l.created_at desc
       limit $2
    `, [userRole, capped]);
  }
}
