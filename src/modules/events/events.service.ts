import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CacheService } from '../../common/cache/cache.service';
import { kolkataNow } from '../../common/util/time';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService, BUCKETS } from '../storage/storage.service';
import { CreateEventDto, UpdateEventDto } from './dto';

type EventRow = {
  id: string;
  title: string;
  category: string;
  start_date: string; // YYYY-MM-DD via to_char
  end_date: string | null;
  event_time: string | null;
  location: string | null;
  is_live: boolean;
  description: string | null;
  created_by: string | null;
  poster_path: string | null;
};

export type EventJson = {
  id: string;
  title: string;
  category: string;
  startDate: string;
  endDate: string | null;
  time: string | null;
  location: string | null;
  isLive: boolean;
  description: string | null;
  createdBy: string | null;
  posterPath: string | null;
  posterUrl: string | null;
};

export type EventImageRow = {
  id: string;
  event_id: string;
  storage_path: string;
  kind: string;
  uploaded_by: string | null;
  created_at: string;
};

export type EventImageJson = {
  id: string;
  eventId: string;
  storagePath: string;
  kind: string;
  uploadedBy: string | null;
  createdAt: string;
  url: string | null;
};

/** Guard against a runaway multi-year range when expanding calendar marks. */
const MAX_RANGE_DAYS = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private db: DatabaseService,
    private cache: CacheService,
    private notifications: NotificationsService,
    private storage: StorageService,
  ) {}

  /** Aggregated payload for the events page (any authenticated role).
   *  Rows are cached (identical for every user); the date-relative parts
   *  (upcoming/featured/marks) are recomputed per request so the payload
   *  rolls over correctly at midnight. */
  async list() {
    const rows = await this.cache.wrap<EventRow[]>('events:all', 60_000, () =>
      this.db.query<EventRow>(
        `select id, title, category,
                to_char(start_date, 'YYYY-MM-DD') as start_date,
                to_char(end_date, 'YYYY-MM-DD') as end_date,
                event_time, location, is_live, description, created_by, poster_path
           from events
          order by start_date asc, created_at asc`,
      ),
    );
    const today = kolkataNow().today;

    const upcomingRows = rows.filter((r) => r.start_date >= today);
    // Featured: a live event wins; otherwise the soonest upcoming; null if neither exists.
    const featuredRow = rows.find((r) => r.is_live) ?? upcomingRows[0] ?? null;

    // Calendar marks: every day covered by the featured + upcoming events.
    const marks = new Set<string>();
    if (featuredRow) addRange(marks, featuredRow.start_date, featuredRow.end_date);
    for (const r of upcomingRows) addRange(marks, r.start_date, r.end_date);

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    const categories = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

    const [featured, upcoming] = await Promise.all([
      featuredRow ? this.mapEvent(featuredRow) : Promise.resolve(null),
      Promise.all(upcomingRows.map((r) => this.mapEvent(r))),
    ]);

    return {
      featured,
      upcoming,
      calendarMarks: [...marks].sort(),
      categories,
    };
  }

  async create(dto: CreateEventDto, userId: string): Promise<EventJson> {
    const startDate = parseDate(dto.startDate, 'startDate');
    const endDate = dto.endDate ? parseDate(dto.endDate, 'endDate') : null;
    if (endDate && endDate < startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    if (dto.posterPath && dto.posterPath.length > 500) {
      throw new BadRequestException('posterPath too long');
    }
    const row = await this.db.queryOne<EventRow>(
      `insert into events (title, category, start_date, end_date, event_time, location, is_live, description, created_by, poster_path)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id, title, category,
                 to_char(start_date, 'YYYY-MM-DD') as start_date,
                 to_char(end_date, 'YYYY-MM-DD') as end_date,
                 event_time, location, is_live, description, created_by, poster_path`,
      [
        dto.title.trim(),
        dto.category,
        startDate,
        endDate,
        dto.time?.trim() || null,
        dto.location?.trim() || null,
        dto.isLive ?? false,
        dto.description?.trim() || null,
        userId,
        dto.posterPath?.trim() || null,
      ],
    );
    this.cache.invalidate('events');
    this.pushEvent('New Event', row!);
    return this.mapEvent(row!);
  }

  async update(id: string, dto: UpdateEventDto): Promise<EventJson> {
    const existing = await this.findOneRow(id);

    const startDate =
      dto.startDate !== undefined ? parseDate(dto.startDate, 'startDate') : existing.start_date;
    let endDate = existing.end_date;
    if (dto.endDate === null) endDate = null;
    else if (dto.endDate !== undefined) endDate = parseDate(dto.endDate, 'endDate');
    if (endDate && endDate < startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    // Dynamic SET built from fixed column names only; values stay parameterized.
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.title !== undefined) set('title', dto.title.trim());
    if (dto.category !== undefined) set('category', dto.category);
    if (dto.startDate !== undefined) set('start_date', startDate);
    if (dto.endDate !== undefined) set('end_date', endDate);
    if (dto.time !== undefined) set('event_time', dto.time?.trim() || null);
    if (dto.location !== undefined) set('location', dto.location?.trim() || null);
    if (dto.description !== undefined) set('description', dto.description?.trim() || null);
    if (dto.isLive !== undefined) set('is_live', dto.isLive);
    if (dto.posterPath !== undefined) set('poster_path', dto.posterPath?.trim() || null);

    const row = await this.db.queryOne<EventRow>(
      `update events set ${sets.join(', ')}
        where id = $1
        returning id, title, category,
                  to_char(start_date, 'YYYY-MM-DD') as start_date,
                  to_char(end_date, 'YYYY-MM-DD') as end_date,
                  event_time, location, is_live, description, created_by, poster_path`,
      params,
    );
    this.cache.invalidate('events');
    // Only schedule-relevant edits are worth a push — description/category/isLive
    // tweaks must not blast everyone again.
    const materialChange =
      (dto.title !== undefined && dto.title.trim() !== existing.title) ||
      (dto.startDate !== undefined && dto.startDate !== existing.start_date) ||
      (dto.endDate !== undefined && (dto.endDate ?? null) !== existing.end_date) ||
      (dto.time !== undefined && (dto.time?.trim() || null) !== existing.event_time) ||
      (dto.location !== undefined && (dto.location?.trim() || null) !== existing.location);
    if (materialChange) this.pushEvent('Event Updated', row!);
    return this.mapEvent(row!);
  }

  async remove(id: string) {
    const row = await this.findOneRow(id);
    // Delete gallery images from storage first (best-effort)
    const images = await this.db.query<{ storage_path: string }>(
      `select storage_path from event_images where event_id = $1`,
      [id],
    );
    await this.db.query(`delete from events where id = $1`, [id]);
    this.cache.invalidate('events');
    // Delete poster + gallery objects (fire-and-forget)
    const toDelete: string[] = [];
    if (row.poster_path) toDelete.push(row.poster_path);
    for (const img of images) toDelete.push(img.storage_path);
    for (const p of toDelete) {
      this.storage.deleteObject(BUCKETS.eventImages, p).catch((e) => this.logger.warn(`delete event image ${p} failed: ${(e as Error).message}`));
    }
    return { deleted: true };
  }

  // ---------- poster / gallery image helpers ----------

  async eventImageUploadUrl(dto: { name: string; contentType?: string; sizeBytes?: number }) {
    if (dto.sizeBytes && dto.sizeBytes > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image exceeds the 10 MB event-images limit');
    }
    if (dto.contentType && !dto.contentType.startsWith('image/')) {
      throw new BadRequestException('Only image/* uploads are allowed for events');
    }
    const path = `${Date.now()}-${slugify(dto.name)}`;
    const { url } = await this.storage.signedUploadUrl(BUCKETS.eventImages, path);
    return { path, url };
  }

  async listImages(eventId: string): Promise<{ images: EventImageJson[] }> {
    if (!UUID_RE.test(eventId)) throw new NotFoundException('Event not found');
    const exists = await this.db.queryOne(`select id from events where id = $1`, [eventId]);
    if (!exists) throw new NotFoundException('Event not found');
    const rows = await this.db.query<EventImageRow>(
      `select id, event_id, storage_path, kind, uploaded_by, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at
         from event_images where event_id = $1 order by created_at desc`,
      [eventId],
    );
    const images = await Promise.all(
      rows.map(async (r) => {
        let url: string | null = null;
        try {
          url = await this.storage.signedUrl(BUCKETS.eventImages, r.storage_path, 3600);
        } catch (e) {
          this.logger.warn(`sign failed for ${r.storage_path}: ${(e as Error).message}`);
        }
        return {
          id: r.id,
          eventId: r.event_id,
          storagePath: r.storage_path,
          kind: r.kind,
          uploadedBy: r.uploaded_by,
          createdAt: r.created_at,
          url,
        };
      }),
    );
    return { images };
  }

  async addImage(eventId: string, dto: { storagePath: string; kind?: string }, userId: string): Promise<EventImageJson> {
    if (!UUID_RE.test(eventId)) throw new NotFoundException('Event not found');
    const exists = await this.db.queryOne(`select id from events where id = $1`, [eventId]);
    if (!exists) throw new NotFoundException('Event not found');
    if (!dto.storagePath || dto.storagePath.length > 500) throw new BadRequestException('storagePath required');
    const kind = dto.kind && ['poster', 'gallery', 'reference'].includes(dto.kind) ? dto.kind : 'gallery';
    // Best-effort: verify object exists (HEAD), but don't fail if storage is eventually consistent
    try {
      const ok = await this.storage.objectExists(BUCKETS.eventImages, dto.storagePath);
      if (!ok) throw new BadRequestException('Uploaded object not found — re-upload the image');
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`objectExists check failed for ${dto.storagePath}: ${(e as Error).message}`);
    }
    const row = await this.db.queryOne<EventImageRow>(
      `insert into event_images (event_id, storage_path, kind, uploaded_by) values ($1, $2, $3, $4)
       returning id, event_id, storage_path, kind, uploaded_by, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at`,
      [eventId, dto.storagePath, kind, userId],
    );
    let url: string | null = null;
    try {
      url = await this.storage.signedUrl(BUCKETS.eventImages, row!.storage_path, 3600);
    } catch {}
    return {
      id: row!.id,
      eventId: row!.event_id,
      storagePath: row!.storage_path,
      kind: row!.kind,
      uploadedBy: row!.uploaded_by,
      createdAt: row!.created_at,
      url,
    };
  }

  async removeImage(imageId: string) {
    if (!UUID_RE.test(imageId)) throw new NotFoundException('Image not found');
    const row = await this.db.queryOne<EventImageRow>(
      `select id, event_id, storage_path from event_images where id = $1`,
      [imageId],
    );
    if (!row) throw new NotFoundException('Image not found');
    await this.db.query(`delete from event_images where id = $1`, [imageId]);
    this.storage.deleteObject(BUCKETS.eventImages, row.storage_path).catch((e) => this.logger.warn(`delete event image ${row.storage_path} failed: ${(e as Error).message}`));
    return { deleted: true };
  }

  /** Push a created/updated event to all active students + faculty (fire-and-forget). */
  private pushEvent(prefix: 'New Event' | 'Event Updated', e: EventRow) {
    void (async () => {
      const recipients = [
        ...(await this.notifications.activeFaculty()),
        ...(await this.notifications.activeStudents()),
      ];
      if (recipients.length === 0) return;
      const when =
        e.end_date && e.end_date !== e.start_date ? `${e.start_date} to ${e.end_date}` : e.start_date;
      await this.notifications.sendSystem({
        kind: 'event',
        title: `${prefix}: ${e.title}`,
        message: `${when}${e.event_time ? ` at ${e.event_time}` : ''}${e.location ? ` • ${e.location}` : ''}`,
        recipients,
      });
      this.logger.log(`event push "${e.title}" (${prefix.toLowerCase()}) → ${recipients.length} recipients`);
    })().catch((err) => this.logger.warn(`event push failed: ${(err as Error).message}`));
  }

  private async findOneRow(id: string): Promise<EventRow> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Event not found');
    const row = await this.db.queryOne<EventRow>(
      `select id, title, category,
              to_char(start_date, 'YYYY-MM-DD') as start_date,
              to_char(end_date, 'YYYY-MM-DD') as end_date,
              event_time, location, is_live, description, created_by, poster_path
         from events
        where id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Event not found');
    return row;
  }

  private async mapEvent(r: EventRow): Promise<EventJson> {
    let posterUrl: string | null = null;
    if (r.poster_path) {
      try {
        posterUrl = await this.storage.signedUrl(BUCKETS.eventImages, r.poster_path, 3600);
      } catch (e) {
        this.logger.warn(`sign poster failed for ${r.poster_path}: ${(e as Error).message}`);
      }
    }
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      startDate: r.start_date,
      endDate: r.end_date,
      time: r.event_time,
      location: r.location,
      isLive: r.is_live,
      description: r.description,
      createdBy: r.created_by,
      posterPath: r.poster_path ?? null,
      posterUrl,
    };
  }
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'file';
}

/** Validate a YYYY-MM-DD string is a real calendar date; returns it unchanged. */
function parseDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a valid calendar date`);
  }
  return value;
}

function addRange(marks: Set<string>, start: string, end: string | null) {
  const stop = end && end > start ? end : start; // single day when end is missing/not after start
  const cursor = new Date(`${start}T00:00:00Z`);
  const stopDate = new Date(`${stop}T00:00:00Z`);
  for (let i = 0; i <= MAX_RANGE_DAYS && cursor <= stopDate; i++) {
    marks.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}
