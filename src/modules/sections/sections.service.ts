import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CacheService } from '../../common/cache/cache.service';

@Injectable()
export class SectionsService {
  constructor(
    private db: DatabaseService,
    private cache: CacheService,
  ) {}

  list() {
    return this.cache.wrap('sections:all', 60_000, () =>
      this.db.query(`
        select s.id, s.label, s.department, s.year, s.class_teacher_id as "classTeacherId",
               u.display_name as "classTeacherName", s.max_strength as "maxStrength",
               (select count(*)::int from student_profiles sp where sp.section_id = s.id) as "studentCount"
          from sections s
          left join users u on u.id = s.class_teacher_id
         order by s.label
      `),
    );
  }

  async findOne(id: string) {
    const row = await this.db.queryOne<any>(`
      select s.id, s.label, s.department, s.year, s.class_teacher_id as "classTeacherId",
             u.display_name as "classTeacherName", s.max_strength as "maxStrength",
             (select count(*)::int from student_profiles sp where sp.section_id = s.id) as "studentCount"
        from sections s
        left join users u on u.id = s.class_teacher_id
       where s.id = $1
    `, [id]);
    if (!row) throw new NotFoundException('Section not found');
    return row;
  }

  async create(dto: { label: string; department: string; year: number; classTeacherId?: string; maxStrength?: number }) {
    const dup = await this.db.queryOne(`select 1 from sections where lower(label) = lower($1)`, [dto.label.trim()]);
    if (dup) throw new ConflictException(`Section ${dto.label} already exists`);
    const row = await this.db.queryOne<any>(`
      insert into sections (label, department, year, class_teacher_id, max_strength)
      values ($1, $2, $3, $4, $5)
      returning id
    `, [dto.label, dto.department, dto.year, dto.classTeacherId ?? null, dto.maxStrength ?? 40]);
    this.cache.invalidate('sections');
    return this.findOne(row.id);
  }

  async update(id: string, dto: Partial<{ label: string; department: string; year: number; classTeacherId: string | null; maxStrength: number }>) {
    await this.findOne(id);
    if (dto.label !== undefined) {
      const dup = await this.db.queryOne(`select 1 from sections where lower(label) = lower($1) and id <> $2`, [String(dto.label).trim(), id]);
      if (dup) throw new ConflictException(`Section ${dto.label} already exists`);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const map: Record<string, string> = {
      label: 'label', department: 'department', year: 'year',
      classTeacherId: 'class_teacher_id', maxStrength: 'max_strength',
    };
    for (const [key, col] of Object.entries(map)) {
      if (dto[key as keyof typeof dto] !== undefined) {
        params.push(dto[key as keyof typeof dto]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length) {
      params.push(id);
      await this.db.query(`update sections set ${sets.join(', ')} where id = $${params.length}`, params);
    }
    this.cache.invalidate('sections');
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    const refs = await this.db.queryOne<{ students: number; slots: number; sessions: number; reports: number }>(
      `select (select count(*) from student_profiles where section_id = $1)::int as students,
              (select count(*) from timetable_slots where section_id = $1)::int as slots,
              (select count(*) from attendance_sessions where section_id = $1)::int as sessions,
              (select count(*) from daily_reports where section_id = $1)::int as reports`,
      [id],
    );
    if (refs && refs.students > 0) {
      throw new ConflictException(`Section still has ${refs.students} students — move them first`);
    }
    if (refs && (refs.slots > 0 || refs.sessions > 0 || refs.reports > 0)) {
      throw new ConflictException(`Section still has timetable/attendance/report history — delete those first`);
    }
    await this.db.query(`delete from sections where id = $1`, [id]);
    this.cache.invalidate('sections');
    return { deleted: true };
  }

  async moveStudent(sectionId: string, studentId: string) {
    const result = await this.db.tx(async (client) => {
      const sec = await client.query(`select id, label, max_strength from sections where id = $1 for update`, [sectionId]);
      if (sec.rows.length === 0) throw new NotFoundException('Section not found');
      const student = await client.query(`select user_id from student_profiles where user_id = $1`, [studentId]);
      if (student.rows.length === 0) throw new NotFoundException('Student not found');
      const cnt = await client.query(`select count(*)::int as count from student_profiles where section_id = $1`, [sectionId]);
      const count = cnt.rows[0]?.count ?? 0;
      const max = sec.rows[0].max_strength ?? 40;
      if (count >= max) throw new BadRequestException(`Section ${sec.rows[0].label} is at max strength ${max}`);
      // Roll number unique per section: retry on collision (concurrent moves).
      const prefix = String(sec.rows[0].label ?? 'S').replace(/-\d+$/, '');
      for (let attempt = 0; attempt < 5; attempt++) {
        const c = await client.query(`select count(*)::int as count from student_profiles where section_id = $1`, [sectionId]);
        const next = (c.rows[0]?.count ?? 0) + 1 + attempt;
        const rollNo = `${prefix}-${String(next).padStart(2, '0')}`;
        const clash = await client.query(`select 1 from student_profiles where section_id = $1 and roll_no = $2`, [sectionId, rollNo]);
        if (clash.rows.length === 0) {
          await client.query(`update student_profiles set section_id = $1, roll_no = $2 where user_id = $3`, [sectionId, rollNo, studentId]);
          return { studentId, sectionId, rollNo };
        }
      }
      throw new ConflictException('Could not assign a unique roll number — retry');
    });
    this.cache.invalidate('sections');
    this.cache.invalidate('students');
    return result;
  }
}
