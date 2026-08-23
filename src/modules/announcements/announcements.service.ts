import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { Role } from '../../common/decorators/roles.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto';

type AnnouncementRow = {
  id: string;
  title: string;
  message: string;
  category: string;
  audience: string;
  created_at: Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnnouncementJson = {
  id: string;
  title: string;
  message: string;
  date: string; // ISO 8601
  category: string;
  audience: string;
};

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private db: DatabaseService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Newest first. Students only see announcements addressed to them
   * (audience 'all' or 'students'); faculty/admin see everything.
   */
  async listForRole(role: Role): Promise<AnnouncementJson[]> {
    const visible =
      role === 'student' ? `where audience in ('all', 'students')` : '';
    const rows = await this.db.query<AnnouncementRow>(
      `select id, title, message, category, audience, created_at
         from announcements
         ${visible}
        order by created_at desc, id asc`,
    );
    return rows.map(mapAnnouncement);
  }

  async create(dto: CreateAnnouncementDto): Promise<AnnouncementJson> {
    const row = await this.db.queryOne<AnnouncementRow>(
      `insert into announcements (title, message, category, audience)
       values ($1, $2, $3, $4)
       returning id, title, message, category, audience, created_at`,
      [dto.title.trim(), dto.message.trim(), dto.category ?? 'general', dto.audience ?? 'all'],
    );
    this.pushCreated(row!);
    return mapAnnouncement(row!);
  }

  /**
   * Push the new announcement to its audience: 'students' → students,
   * 'faculty' → faculty, 'all' → both. Fire-and-forget — the row is already
   * committed and a push outage must not fail the announcement creation.
   */
  private pushCreated(a: AnnouncementRow) {
    void (async () => {
      const recipients: Array<{ id: string; role: 'faculty' | 'student' }> = [];
      if (a.audience === 'all' || a.audience === 'faculty') {
        recipients.push(...(await this.notifications.activeFaculty()));
      }
      if (a.audience === 'all' || a.audience === 'students') {
        recipients.push(...(await this.notifications.activeStudents()));
      }
      if (recipients.length === 0) return;
      await this.notifications.sendSystem({
        kind: 'announcement',
        title: a.title,
        message: a.message,
        recipients,
      });
      this.logger.log(`announcement "${a.title}" pushed to ${recipients.length} recipients`);
    })().catch((err) => this.logger.warn(`announcement push failed: ${(err as Error).message}`));
  }

  async update(id: string, dto: UpdateAnnouncementDto): Promise<AnnouncementJson> {
    await this.findOneRow(id);

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.title !== undefined) set('title', dto.title.trim());
    if (dto.message !== undefined) set('message', dto.message.trim());
    if (dto.category !== undefined) set('category', dto.category);
    if (dto.audience !== undefined) set('audience', dto.audience);

    if (sets.length) {
      const updated = await this.db.queryOne<AnnouncementRow>(
        `update announcements set ${sets.join(', ')}
          where id = $${params.length + 1}::uuid
         returning id, title, message, category, audience, created_at`,
        [...params, id],
      );
      if (!updated) throw new NotFoundException('Announcement not found');
      return mapAnnouncement(updated);
    }
    return mapAnnouncement(await this.findOneRow(id));
  }

  async remove(id: string) {
    await this.findOneRow(id);
    await this.db.query(`delete from announcements where id = $1`, [id]);
    return { deleted: true };
  }

  private async findOneRow(id: string): Promise<AnnouncementRow> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Announcement not found');
    const row = await this.db.queryOne<AnnouncementRow>(
      `select id, title, message, category, audience, created_at
         from announcements
        where id = $1::uuid`,
      [id],
    );
    if (!row) throw new NotFoundException('Announcement not found');
    return row;
  }
}

function mapAnnouncement(r: AnnouncementRow): AnnouncementJson {
  return {
    id: r.id,
    title: r.title,
    message: r.message,
    date: new Date(r.created_at).toISOString(),
    category: r.category,
    audience: r.audience,
  };
}
