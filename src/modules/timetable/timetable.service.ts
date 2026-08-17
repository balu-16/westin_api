import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DatabaseService } from '../../database/database.service';
import { CacheService } from '../../common/cache/cache.service';
import { kolkataNow } from '../../common/util/time';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type SlotInput = {
  sectionId: string;
  day: number;
  startTime: string;
  endTime: string;
  subjectId: string;
  facultyId: string;
  roomId: string;
};

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) throw new BadRequestException(`Invalid time "${t}" (expected HH:MM)`);
  return h * 60 + m;
}

@Injectable()
export class TimetableService {
  constructor(
    private db: DatabaseService,
    private cache: CacheService,
  ) {}

  // ---------- reads ----------

  rooms() {
    return this.db.query(`select id, name from rooms order by name`);
  }

  /** Slot rows shared by week()/facultyWeek(): the 5-way join is cached (all
   *  students of a section read identical rows); time-relative session
   *  statuses are computed fresh per request. */
  private slotRows(where: 'section' | 'faculty', id: string) {
    return this.cache.wrap<any[]>(`timetable:${where}:${id}`, 60_000, () =>
      this.db.query<any>(`
        select t.id, t.day, to_char(t.start_time, 'HH24:MI') as "startTime",
               to_char(t.end_time, 'HH24:MI') as "endTime",
               sub.name as subject, sub.code, sub.id as "subjectId",
               u.display_name as faculty, f.user_id as "facultyId",
               r.name as room, sec.label as section, sec.id as "sectionId"
          from timetable_slots t
          join subjects sub on sub.id = t.subject_id
          join faculty_profiles f on f.user_id = t.faculty_id
          join users u on u.id = f.user_id
          join rooms r on r.id = t.room_id
          join sections sec on sec.id = t.section_id
         where t.${where}_id = $1
         order by t.day, t.start_time
      `, [id]),
    );
  }

  /** Weekly view Mon-Sat for a section, with status computed vs Asia/Kolkata now. */
  async week(sectionId: string) {
    const rows = await this.slotRows('section', sectionId);

    const { todayDow, minutes } = this.kolkataNow();

    const sessions = rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      code: row.code,
      subjectId: row.subjectId,
      faculty: row.faculty,
      facultyId: row.facultyId,
      startTime: row.startTime,
      endTime: row.endTime,
      room: row.room,
      section: row.section,
      sectionId: row.sectionId,
      day: row.day,
      status: this.computeStatus(row.day, toMinutes(row.startTime), toMinutes(row.endTime), todayDow, minutes),
    }));

    return DAY_NAMES.map((dayName, day) => ({
      day,
      dayName,
      sessions: sessions.filter((s) => s.day === day),
    }));
  }

  /** Current weekday + minute-of-day in Asia/Kolkata. dow: 0=Mon..5=Sat, -1=Sunday. */
  private kolkataNow(): { todayDow: number; minutes: number } {
    const { todayDow, minutes } = kolkataNow();
    return { todayDow, minutes };
  }

  private computeStatus(day: number, start: number, end: number, todayDow: number, nowMinutes: number): string {
    if (day !== todayDow) return day < todayDow ? 'completed' : 'upcoming';
    if (nowMinutes >= end) return 'completed';
    if (nowMinutes >= start) return 'in-progress';
    return 'upcoming';
  }

  /** Weekly view of a faculty member's own classes. */
  async facultyWeek(facultyId: string) {
    const rows = await this.slotRows('faculty', facultyId);

    const { todayDow, minutes } = this.kolkataNow();

    const sessions = rows.map((row) => ({
      ...row,
      status: this.computeStatus(row.day, toMinutes(row.startTime), toMinutes(row.endTime), todayDow, minutes),
    }));
    return DAY_NAMES.map((dayName, day) => ({
      day,
      dayName,
      sessions: sessions.filter((s) => s.day === day),
    }));
  }

  /** Raw builder rows for one section+day. */
  async builderSlots(sectionId: string, day?: number) {
    return this.db.query<any>(`
      select t.id, t.day, to_char(t.start_time, 'HH24:MI') as "startTime",
             to_char(t.end_time, 'HH24:MI') as "endTime",
             sub.id as "subjectId", sub.name as subject, sub.code,
             f.user_id as "facultyId", u.display_name as faculty,
             r.id as "roomId", r.name as room
        from timetable_slots t
        join subjects sub on sub.id = t.subject_id
        join faculty_profiles f on f.user_id = t.faculty_id
        join users u on u.id = f.user_id
        join rooms r on r.id = t.room_id
       where t.section_id = $1 and ($2::int is null or t.day = $2::int)
       order by t.day, t.start_time
    `, [sectionId, day ?? null]);
  }

  // ---------- slot CRUD with conflict checks ----------

  async createSlot(input: SlotInput) {
    await this.validateRefs(input);
    if (toMinutes(input.endTime) <= toMinutes(input.startTime)) {
      throw new BadRequestException('endTime must be after startTime');
    }
    const conflicts = await this.findConflicts(input);
    if (conflicts.length) throw new ConflictException(conflicts.map((c) => c.message).join('; '));

    const row = await this.db.queryOne<any>(`
      insert into timetable_slots (section_id, day, start_time, end_time, subject_id, faculty_id, room_id)
      values ($1, $2, $3::time, $4::time, $5, $6, $7) returning id
    `, [input.sectionId, input.day, input.startTime, input.endTime, input.subjectId, input.facultyId, input.roomId]);
    this.cache.invalidate('timetable');
    return { id: row.id, ...input };
  }

  async updateSlot(id: string, input: Partial<SlotInput>) {
    const existing = await this.db.queryOne<any>(`select * from timetable_slots where id = $1`, [id]);
    if (!existing) throw new NotFoundException('Slot not found');
    const merged: SlotInput = {
      sectionId: input.sectionId ?? existing.section_id,
      day: input.day ?? existing.day,
      startTime: input.startTime ?? existing.start_time,
      endTime: input.endTime ?? existing.end_time,
      subjectId: input.subjectId ?? existing.subject_id,
      facultyId: input.facultyId ?? existing.faculty_id,
      roomId: input.roomId ?? existing.room_id,
    };
    await this.validateRefs(merged);
    if (toMinutes(merged.endTime) <= toMinutes(merged.startTime)) {
      throw new BadRequestException('endTime must be after startTime');
    }
    const conflicts = await this.findConflicts(merged, id);
    if (conflicts.length) throw new ConflictException(conflicts.map((c) => c.message).join('; '));

    await this.db.query(`
      update timetable_slots set section_id = $1, day = $2, start_time = $3::time, end_time = $4::time,
             subject_id = $5, faculty_id = $6, room_id = $7 where id = $8
    `, [merged.sectionId, merged.day, merged.startTime, merged.endTime, merged.subjectId, merged.facultyId, merged.roomId, id]);
    this.cache.invalidate('timetable');
    return { id, ...merged };
  }

  async deleteSlot(id: string) {
    const existing = await this.db.queryOne(`select id from timetable_slots where id = $1`, [id]);
    if (!existing) throw new NotFoundException('Slot not found');
    await this.db.query(`delete from timetable_slots where id = $1`, [id]);
    this.cache.invalidate('timetable');
    return { deleted: true };
  }

  private async validateRefs(input: SlotInput) {
    const refs = await this.db.queryOne<{ s: number; f: number; r: number }>(`
      select (select count(*) from sections where id = $1)::int as s,
             (select count(*) from faculty_profiles where user_id = $2)::int as f,
             (select count(*) from rooms where id = $3)::int as r
    `, [input.sectionId, input.facultyId, input.roomId]);
    if (!refs || refs.s === 0) throw new BadRequestException('Unknown section');
    if (refs.f === 0) throw new BadRequestException('Unknown faculty');
    if (refs.r === 0) throw new BadRequestException('Unknown room');
  }

  /** Section double-booking, room clash (any section), faculty clash (any section). */
  private async findConflicts(input: SlotInput, excludeSlotId?: string) {
    return this.db.query<any>(`
      with i as (
        select $1::uuid as section_id, $2::int as day, $3::time as start_t, $4::time as end_t,
               $5::uuid as room_id, $6::uuid as faculty_id, $7::uuid as exclude_id
      )
      select 'Section ' || sec.label || ' already has a class ' || to_char(t.start_time,'HH24:MI') || '-' || to_char(t.end_time,'HH24:MI') as message
        from timetable_slots t, sections sec, i
       where (i.exclude_id is null or t.id <> i.exclude_id) and sec.id = t.section_id
         and t.section_id = i.section_id and t.day = i.day
         and t.start_time < i.end_t and t.end_time > i.start_t
      union all
      select r.name || ' is already booked by section ' || sec.label || ' (' || to_char(t.start_time,'HH24:MI') || '-' || to_char(t.end_time,'HH24:MI') || ')' as message
        from timetable_slots t, rooms r, sections sec, i
       where (i.exclude_id is null or t.id <> i.exclude_id) and r.id = t.room_id and sec.id = t.section_id
         and t.room_id = i.room_id and t.day = i.day
         and t.start_time < i.end_t and t.end_time > i.start_t
      union all
      select 'Faculty ' || u.display_name || ' already teaches section ' || sec.label || ' (' || to_char(t.start_time,'HH24:MI') || '-' || to_char(t.end_time,'HH24:MI') || ')' as message
        from timetable_slots t, faculty_profiles f, users u, sections sec, i
       where (i.exclude_id is null or t.id <> i.exclude_id) and f.user_id = t.faculty_id and u.id = f.user_id and sec.id = t.section_id
         and t.faculty_id = i.faculty_id and t.day = i.day
         and t.start_time < i.end_t and t.end_time > i.start_t
    `, [
      input.sectionId, input.day, input.startTime, input.endTime,
      input.roomId, input.facultyId, excludeSlotId ?? null,
    ]);
  }

  // ---------- bulk import ----------

  async import(dto: { rows: ImportRow[]; mode: 'add' | 'replace' }) {
    const errors: { row: number; message: string }[] = [];

    const [sections, subjects, faculty, rooms] = await Promise.all([
      this.db.query(`select id, label from sections`),
      this.db.query(`select id, name, code from subjects`),
      this.db.query(`
        select f.user_id, u.display_name, f.faculty_id from faculty_profiles f join users u on u.id = f.user_id
      `),
      this.db.query(`select id, name from rooms`),
    ]);

    const sectionByLabel = new Map(sections.map((s: any) => [s.label.toLowerCase(), s.id]));
    const subjectByKey = new Map<string, string>();
    for (const s of subjects as any[]) {
      subjectByKey.set(s.name.toLowerCase(), s.id);
      subjectByKey.set(s.code.toLowerCase(), s.id);
    }
    const facultyByKey = new Map<string, string>();
    for (const f of faculty as any[]) {
      facultyByKey.set(f.display_name.toLowerCase(), f.user_id);
      facultyByKey.set(f.faculty_id.toLowerCase(), f.user_id);
    }
    const roomByName = new Map(rooms.map((r: any) => [r.name.toLowerCase(), r.id]));

    const parsed: SlotInput[] = [];
    dto.rows.forEach((row, i) => {
      const line = i + 1;
      const sectionId = sectionByLabel.get(String(row.section ?? '').trim().toLowerCase());
      if (!sectionId) { errors.push({ row: line, message: `Unknown section "${row.section}"` }); return; }

      const day = parseDay(row.day);
      if (day === null) { errors.push({ row: line, message: `Unknown day "${row.day}"` }); return; }

      const times = parseTimeSlot(row.timeSlot);
      if (!times) { errors.push({ row: line, message: `Invalid time slot "${row.timeSlot}" (expected "HH:MM - HH:MM")` }); return; }

      const subjectId = subjectByKey.get(String(row.subject ?? '').trim().toLowerCase());
      if (!subjectId) { errors.push({ row: line, message: `Unknown subject "${row.subject}"` }); return; }

      const facultyId = facultyByKey.get(String(row.faculty ?? '').trim().toLowerCase());
      if (!facultyId) { errors.push({ row: line, message: `Unknown faculty "${row.faculty}"` }); return; }

      const roomId = roomByName.get(String(row.room ?? '').trim().toLowerCase());
      if (!roomId) { errors.push({ row: line, message: `Unknown room "${row.room}"` }); return; }

      parsed.push({ sectionId, day, startTime: times.start, endTime: times.end, subjectId, facultyId, roomId });
    });

    // Intra-file duplicates (same section+day+start).
    const seen = new Set<string>();
    parsed.forEach((p, i) => {
      const key = `${p.sectionId}|${p.day}|${p.startTime}`;
      if (seen.has(key)) errors.push({ row: i + 1, message: `Duplicate slot for section/day/time in file` });
      seen.add(key);
    });

    if (dto.mode !== 'replace') {
      // add mode: check against existing DB slots.
      for (const p of parsed) {
        const conflicts = await this.findConflicts(p);
        conflicts.forEach((c) => errors.push({ row: 0, message: c.message }));
      }
    }

    if (errors.length) {
      throw new BadRequestException({ message: 'Import validation failed', errors });
    }

    const inserted = await this.db.tx(async (client) => {
      if (dto.mode === 'replace') {
        const sectionIds = [...new Set(parsed.map((p) => p.sectionId))];
        for (const sectionId of sectionIds) {
          await client.query(`delete from timetable_slots where section_id = $1`, [sectionId]);
        }
      }
      let count = 0;
      for (const p of parsed) {
        await client.query(
          `insert into timetable_slots (section_id, day, start_time, end_time, subject_id, faculty_id, room_id)
           values ($1, $2, $3::time, $4::time, $5, $6, $7)`,
          [p.sectionId, p.day, p.startTime, p.endTime, p.subjectId, p.facultyId, p.roomId],
        );
        count++;
      }
      return count;
    });
    this.cache.invalidate('timetable');

    return { inserted, errors: [] };
  }
}

/** One parsed XLSX row; properties must be decorated or ValidationPipe's
 *  whitelist strips them before the service sees the row. */
export class ImportRow {
  @IsString() @IsNotEmpty() section: string;
  @IsNotEmpty() day: string | number;
  @IsString() @IsNotEmpty() timeSlot: string;
  @IsString() @IsNotEmpty() subject: string;
  @IsString() @IsNotEmpty() faculty: string;
  @IsString() @IsNotEmpty() room: string;
}

function parseDay(value: string | number): number | null {
  if (typeof value === 'number') return value >= 0 && value <= 5 ? value : null;
  const idx = DAY_NAMES.findIndex((d) => d.toLowerCase() === String(value).trim().toLowerCase());
  return idx >= 0 ? idx : null;
}

function parseTimeSlot(value: string): { start: string; end: string } | null {
  const match = String(value ?? '').match(/(\d{1,2}:\d{2})\s*[-–to]+\s*(\d{1,2}:\d{2})/i);
  if (!match) return null;
  const norm = (t: string) => t.padStart(5, '0');
  return { start: norm(match[1]), end: norm(match[2]) };
}
