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
    const dup = await this.db.queryOne(`select 1 from sections where label = $1`, [dto.label]);
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
    const students = await this.db.queryOne<{ count: number }>(
      `select count(*)::int as count from student_profiles where section_id = $1`, [id],
    );
    if (students && students.count > 0) {
      throw new ConflictException(`Section still has ${students.count} students — move them first`);
    }
    await this.db.query(`delete from sections where id = $1`, [id]);
    this.cache.invalidate('sections');
    return { deleted: true };
  }

  async moveStudent(sectionId: string, studentId: string) {
    await this.findOne(sectionId);
    const student = await this.db.queryOne<any>(`
      select sp.user_id, sp.roll_no, sec.label as prefix
        from student_profiles sp
        left join sections sec on sec.id = sp.section_id
       where sp.user_id = $1
    `, [studentId]);
    if (!student) throw new NotFoundException('Student not found');

    const section = await this.db.queryOne<{ label: string; max_strength: number; count: number }>(`
      select s.label, s.max_strength,
             (select count(*)::int from student_profiles sp where sp.section_id = s.id) as count
        from sections s where s.id = $1
    `, [sectionId]);
    if (section && section.count >= section.max_strength) {
      throw new BadRequestException(`Section ${section.label} is at max strength ${section.max_strength}`);
    }

    // Roll number = next sequence in target section (label digits or fallback count).
    const prefix = section?.label?.replace(/-\d+$/, '') ?? 'S';
    const next = (section?.count ?? 0) + 1;
    const rollNo = `${prefix}-${String(next).padStart(2, '0')}`;
    await this.db.query(
      `update student_profiles set section_id = $1, roll_no = $2 where user_id = $3`,
      [sectionId, rollNo, studentId],
    );
    this.cache.invalidate('sections');
    this.cache.invalidate('students');
    return { studentId, sectionId, rollNo };
  }
}
