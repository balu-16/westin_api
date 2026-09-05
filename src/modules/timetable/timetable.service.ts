import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DatabaseService } from '../../database/database.service';
import { CacheService } from '../../common/cache/cache.service';
import { kolkataNow } from '../../common/util/time';
import { fixedSlotError, isFixedSlot } from './fixed-periods';

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

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function toMinutes(t: string): number {
  const v = String(t ?? '').trim();
  if (!TIME_RE.test(v)) throw new BadRequestException(`Invalid time "${t}" (expected HH:MM 00:00-23:59)`);
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

function assertFixedSlot(startTime: string, endTime: string) {
  // Normalize "9:00" -> "09:00" before comparing so Excel/client variants still match.
  const s = String(startTime ?? '').trim().padStart(5, '0');
  const e = String(endTime ?? '').trim().padStart(5, '0');
  if (!isFixedSlot(s, e)) throw new BadRequestException(fixedSlotError());
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
    if (!sectionId) throw new BadRequestException('sectionId is required');
    if (day !== undefined && (!Number.isInteger(day) || day < 0 || day > 5)) {
      throw new BadRequestException('day must be an integer 0 (Monday) .. 5 (Saturday)');
    }
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
    this.assertDay(input.day);
    assertFixedSlot(input.startTime, input.endTime);
    // Serialize overlapping writes: check + insert atomically so two
    // concurrent admins cannot double-book the same room/faculty/section.
    const row = await this.db.tx(async (client) => {
      await client.query(`lock table timetable_slots in share row exclusive mode`);
      await this.validateRefs(input);
      if (toMinutes(input.endTime) <= toMinutes(input.startTime)) {
        throw new BadRequestException('endTime must be after startTime');
      }
      const conflicts = await this.findConflictsTx(client, input);
      if (conflicts.length) throw new ConflictException(conflicts.map((c) => c.message).join('; '));
      try {
        const r = await client.query(
          `insert into timetable_slots (section_id, day, start_time, end_time, subject_id, faculty_id, room_id)
           values ($1, $2, $3::time, $4::time, $5, $6, $7) returning id`,
          [input.sectionId, input.day, input.startTime, input.endTime, input.subjectId, input.facultyId, input.roomId],
        );
        return r.rows[0];
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException('This section already has a period at this time.');
        throw e;
      }
    });
    this.cache.invalidate('timetable');
    return { id: row.id, ...input };
  }

  async updateSlot(id: string, input: Partial<SlotInput>) {
    const updated = await this.db.tx(async (client) => {
      await client.query(`lock table timetable_slots in share row exclusive mode`);
      const ex = await client.query(`select * from timetable_slots where id = $1`, [id]);
      const existing = ex.rows[0];
      if (!existing) throw new NotFoundException('Slot not found');
      // pg `time` columns come back as "HH:MM:SS" — trim to HH:MM for validation/merge.
      const hhmm = (v: unknown) => String(v ?? '').slice(0, 5);
      const merged: SlotInput = {
        sectionId: input.sectionId ?? existing.section_id,
        day: input.day ?? existing.day,
        startTime: input.startTime ?? hhmm(existing.start_time),
        endTime: input.endTime ?? hhmm(existing.end_time),
        subjectId: input.subjectId ?? existing.subject_id,
        facultyId: input.facultyId ?? existing.faculty_id,
        roomId: input.roomId ?? existing.room_id,
      };
      this.assertDay(merged.day);
      assertFixedSlot(merged.startTime, merged.endTime);
      await this.validateRefs(merged);
      if (toMinutes(merged.endTime) <= toMinutes(merged.startTime)) {
        throw new BadRequestException('endTime must be after startTime');
      }
      const conflicts = await this.findConflictsTx(client, merged, id);
      if (conflicts.length) throw new ConflictException(conflicts.map((c) => c.message).join('; '));

      try {
        await client.query(
          `update timetable_slots set section_id = $1, day = $2, start_time = $3::time, end_time = $4::time,
                  subject_id = $5, faculty_id = $6, room_id = $7 where id = $8`,
          [merged.sectionId, merged.day, merged.startTime, merged.endTime, merged.subjectId, merged.facultyId, merged.roomId, id],
        );
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException('This section already has a period at this time.');
        throw e;
      }
      return merged;
    });
    this.cache.invalidate('timetable');
    return { id, ...updated };
  }

  async deleteSlot(id: string) {
    const existing = await this.db.queryOne(`select id from timetable_slots where id = $1`, [id]);
    if (!existing) throw new NotFoundException('Slot not found');
    await this.db.query(`delete from timetable_slots where id = $1`, [id]);
    this.cache.invalidate('timetable');
    return { deleted: true };
  }

  private assertDay(day: number) {
    if (!Number.isInteger(day) || day < 0 || day > 5) {
      throw new BadRequestException('day must be an integer 0 (Monday) .. 5 (Saturday)');
    }
  }

  private async validateRefs(input: SlotInput) {
    const refs = await this.db.queryOne<{ s: number; f: number; r: number; sub: number }>(`
      select (select count(*) from sections where id = $1)::int as s,
             (select count(*) from faculty_profiles where user_id = $2)::int as f,
             (select count(*) from rooms where id = $3)::int as r,
             (select count(*) from subjects where id = $4)::int as sub
    `, [input.sectionId, input.facultyId, input.roomId, input.subjectId]);
    if (!refs || refs.s === 0) throw new BadRequestException('Unknown section');
    if (refs.f === 0) throw new BadRequestException('Unknown faculty');
    if (refs.r === 0) throw new BadRequestException('Unknown room');
    if (refs.sub === 0) throw new BadRequestException('Unknown subject');
  }

  /** Who is free at a fixed slot: free/busy faculty + rooms and section clash.
   *  Powers the admin "empty faculty / empty classroom" dropdowns so admins
   *  never have to manually cross-check the week grid. */
  async availability(sectionId: string, day: number, startTime: string, endTime: string) {
    this.assertDay(day);
    assertFixedSlot(startTime, endTime);
    if (!sectionId) throw new BadRequestException('sectionId is required');
    const cacheKey = `timetable:avail:${sectionId}:${day}:${startTime}-${endTime}`;
    return this.cache.wrap(cacheKey, 15_000, async () => {
      const busy = await this.db.query<any>(
        `select t.faculty_id as "facultyId", t.room_id as "roomId",
                sec.label as section, to_char(t.start_time,'HH24:MI') as "startTime",
                to_char(t.end_time,'HH24:MI') as "endTime",
                u.display_name as faculty, r.name as room
           from timetable_slots t
           join sections sec on sec.id = t.section_id
           join faculty_profiles f on f.user_id = t.faculty_id
           join users u on u.id = f.user_id
           join rooms r on r.id = t.room_id
          where t.day = $1 and t.start_time < $3::time and t.end_time > $2::time`,
        [day, startTime, endTime],
      );
      const busyFaculty = new Map<string, string>();
      const busyRoom = new Map<string, string>();
      let sectionBusy: string | null = null;
      for (const b of busy) {
        const reason = `${b.section} (${b.startTime}-${b.endTime})`;
        if (!busyFaculty.has(b.facultyId)) busyFaculty.set(b.facultyId, `${b.faculty} busy in ${reason}`);
        if (!busyRoom.has(b.roomId)) busyRoom.set(b.roomId, `${b.room} booked by ${reason}`);
      }
      const sectionRows = await this.db.query<any>(
        `select sub.code, to_char(t.start_time,'HH24:MI') as "startTime", to_char(t.end_time,'HH24:MI') as "endTime"
           from timetable_slots t join subjects sub on sub.id = t.subject_id
          where t.section_id = $1 and t.day = $2 and t.start_time < $4::time and t.end_time > $3::time`,
        [sectionId, day, startTime, endTime],
      );
      if (sectionRows.length) {
        const c = sectionRows[0];
        sectionBusy = `Section already has ${c.code} ${c.startTime}-${c.endTime}`;
      }
      const [faculty, rooms] = await Promise.all([
        this.db.query<any>(`select f.user_id as id, u.display_name as name from faculty_profiles f join users u on u.id = f.user_id where u.is_active is distinct from false order by u.display_name`),
        this.db.query<any>(`select id, name from rooms order by name`),
      ]);
      const freeFaculty = faculty.filter((f: any) => !busyFaculty.has(f.id));
      const freeRooms = rooms.filter((r: any) => !busyRoom.has(r.id));
      return {
        day,
        startTime,
        endTime,
        sectionBusy,
        freeFaculty,
        busyFaculty: [...busyFaculty.entries()].map(([id, reason]) => ({ id, reason })),
        freeRooms,
        busyRooms: [...busyRoom.entries()].map(([id, reason]) => ({ id, reason })),
        counts: { freeFaculty: freeFaculty.length, freeRooms: freeRooms.length },
      };
    });
  }

  /** Tx variant used inside create/update/import so check+write are atomic. */
  private async findConflictsTx(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, input: SlotInput, excludeSlotId?: string) {
    const r = await client.query(
      `${this.conflictSql()}`,
      [input.sectionId, input.day, input.startTime, input.endTime, input.roomId, input.facultyId, excludeSlotId ?? null],
    );
    return r.rows;
  }

  private conflictSql(): string {
    return `
      with i as (
        select $1::uuid as section_id, $2::int as day, $3::time as start_t, $4::time as end_t,
               $5::uuid as room_id, $6::uuid as faculty_id, $7::uuid as exclude_id
      )`;
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

    const parsed: Array<SlotInput & { line: number }> = [];
    dto.rows.forEach((row, i) => {
      const line = i + 1;
      const sectionId = sectionByLabel.get(String(row.section ?? '').trim().toLowerCase());
      if (!sectionId) { errors.push({ row: line, message: `Unknown section "${row.section}"` }); return; }

      const day = parseDay(row.day);
      if (day === null) { errors.push({ row: line, message: `Unknown day "${row.day}"` }); return; }

      const times = parseTimeSlot(row.timeSlot);
      if (!times) { errors.push({ row: line, message: `Invalid time slot "${row.timeSlot}" (expected "HH:MM - HH:MM")` }); return; }
      if (toMinutes(times.end) <= toMinutes(times.start)) {
        errors.push({ row: line, message: `End time must be after start time in "${row.timeSlot}"` }); return;
      }
      if (!isFixedSlot(times.start, times.end)) {
        errors.push({ row: line, message: `${fixedSlotError()} (row has "${row.timeSlot}")` }); return;
      }

      const subjectId = subjectByKey.get(String(row.subject ?? '').trim().toLowerCase());
      if (!subjectId) { errors.push({ row: line, message: `Unknown subject "${row.subject}"` }); return; }

      const facultyId = facultyByKey.get(String(row.faculty ?? '').trim().toLowerCase());
      if (!facultyId) { errors.push({ row: line, message: `Unknown faculty "${row.faculty}"` }); return; }

      const roomId = roomByName.get(String(row.room ?? '').trim().toLowerCase());
      if (!roomId) { errors.push({ row: line, message: `Unknown room "${row.room}"` }); return; }

      parsed.push({ sectionId, day, startTime: times.start, endTime: times.end, subjectId, facultyId, roomId, line });
    });

    // Intra-file interval-overlap detection (not just exact start equality):
    // same section overlap, same room overlap (any section), same faculty overlap.
    const overlap = (a: SlotInput, b: SlotInput) =>
      a.day === b.day && toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime);
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const a = parsed[i];
        const b = parsed[j];
        if (!overlap(a, b)) continue;
        if (a.sectionId === b.sectionId) errors.push({ row: b.line, message: `Duplicate slot for section/day/time in file (overlaps row ${a.line})` });
        else if (a.roomId === b.roomId) errors.push({ row: b.line, message: `Room double-booked in file (overlaps row ${a.line})` });
        else if (a.facultyId === b.facultyId) errors.push({ row: b.line, message: `Faculty double-booked in file (overlaps row ${a.line})` });
      }
    }

    if (errors.length) {
      throw new BadRequestException({ message: 'Import validation failed', errors });
    }

    const inserted = await this.db.tx(async (client) => {
      await client.query(`lock table timetable_slots in share row exclusive mode`);
      if (dto.mode === 'replace') {
        // Delete only affected section+day pairs (not whole sections), then
        // validate remaining DB clashes (faculty/room vs untouched sections).
        const pairs = [...new Set(parsed.map((p) => `${p.sectionId}|${p.day}`))];
        for (const pair of pairs) {
          const [sid, d] = pair.split('|');
          await client.query(`delete from timetable_slots where section_id = $1 and day = $2::int`, [sid, Number(d)]);
        }
      }
      // Validate every row against the DB state inside the same Tx (atomic).
      for (const p of parsed) {
        const conflicts = await this.findConflictsTx(client, p);
        conflicts.forEach((c) => errors.push({ row: p.line, message: c.message }));
      }
      if (errors.length) {
        throw new BadRequestException({ message: 'Import validation failed', errors });
      }
      let count = 0;
      for (const p of parsed) {
        try {
          await client.query(
            `insert into timetable_slots (section_id, day, start_time, end_time, subject_id, faculty_id, room_id)
             values ($1, $2, $3::time, $4::time, $5, $6, $7)`,
            [p.sectionId, p.day, p.startTime, p.endTime, p.subjectId, p.facultyId, p.roomId],
          );
          count++;
        } catch (e: any) {
          if (e?.code === '23505') throw new BadRequestException({ message: 'Import validation failed', errors: [{ row: p.line, message: 'Duplicate slot for section/day/time' }] });
          throw e;
        }
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
  const m = String(value ?? '').match(/^\s*(\d{1,2}:\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}:\d{2})\s*$/i);
  if (!m) return null;
  const norm = (t: string) => t.padStart(5, '0');
  const start = norm(m[1]);
  const end = norm(m[2]);
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return null;
  return { start, end };
}
