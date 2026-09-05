import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StorageService, BUCKETS } from '../storage/storage.service';
import { pageParams, paginatedEnvelope } from '../../common/util/pagination';
import { CreateReportDto, MAX_ATTACHMENT_BYTES } from './dto';

type ReportRow = {
  id: string;
  faculty_id: string;
  section_id: string | null;
  section_label: string | null;
  subject_id: string | null;
  subject_name: string | null;
  report_date: string; // YYYY-MM-DD via to_char
  topic: string;
  attachment_path: string | null;
  created_at: Date;
  submitted_by: string;
};

export type DailyReportJson = {
  id: string;
  section: string | null;
  sectionId: string | null;
  subject: string | null;
  subjectId: string | null;
  date: string;
  topic: string;
  fileName: string | null;
  fileType: string | null;
  attachmentUrl: string | null;
  submittedBy: string;
};

const REPORT_FIELDS = `
  select r.id, r.faculty_id, r.section_id, sec.label as section_label,
         r.subject_id, sub.name as subject_name,
         to_char(r.report_date, 'YYYY-MM-DD') as report_date,
         r.topic, r.attachment_path, r.created_at,
         u.display_name as submitted_by`;

const REPORT_JOINS = `
    from daily_reports r
    left join sections sec on sec.id = r.section_id
    left join subjects sub on sub.id = r.subject_id
    join users u on u.id = r.faculty_id`;

const REPORT_SELECT = `${REPORT_FIELDS}${REPORT_JOINS}`;

@Injectable()
export class ReportsService {
  private logger = new Logger(ReportsService.name);

  constructor(
    private db: DatabaseService,
    private storage: StorageService,
  ) {}

  /** Own reports, newest first — paginated (default 10). */
  async mine(userId: string, page?: string | number, pageSize?: string | number) {
    const pg = pageParams(page, pageSize);
    const rows = await this.db.query<ReportRow & { __total?: string | number }>(
      `${REPORT_FIELDS}, count(*) over() as "__total" ${REPORT_JOINS}
        where r.faculty_id = $1::uuid
        order by r.report_date desc, r.created_at desc
        limit $2 offset $3`,
      [userId, pg.limit, pg.offset],
    );
    const mapped = await Promise.all(
      rows.map(async (r) => {
        const { __total, ...rest } = r;
        const json = await this.mapReport(rest as ReportRow);
        return Object.assign(json, { __total });
      }),
    );
    return paginatedEnvelope<DailyReportJson>(mapped as any, pg);
  }

  /** Admin listing of everyone's reports with filters + search. */
  async listAdmin(
    filters: { search?: string; sectionId?: string; from?: string; to?: string },
    page?: number | string,
    pageSize?: number | string,
  ) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.search && filters.search.trim()) {
      params.push(`%${filters.search.trim()}%`);
      const p = `$${params.length}`;
      where.push(`(r.topic ilike ${p} or u.display_name ilike ${p} or sec.label ilike ${p})`);
    }
    if (filters.sectionId) {
      if (!isUuid(filters.sectionId)) throw new BadRequestException('sectionId must be a UUID');
      params.push(filters.sectionId);
      where.push(`r.section_id = $${params.length}::uuid`);
    }
    if (filters.from) {
      const from = parseDate(filters.from, 'from');
      params.push(from);
      where.push(`r.report_date >= $${params.length}::date`);
    }
    if (filters.to) {
      const to = parseDate(filters.to, 'to');
      params.push(to);
      where.push(`r.report_date <= $${params.length}::date`);
    }

    const pg = pageParams(page, pageSize);
    params.push(pg.limit, pg.offset);
    const rows = await this.db.query<ReportRow & { __total?: string | number }>(
      `${REPORT_FIELDS},
              count(*) over() as "__total"${REPORT_JOINS}
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by r.report_date desc, r.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const mapped = await Promise.all(
      rows.map(async (r) => {
        const { __total, ...rest } = r;
        const json = await this.mapReport(rest);
        return Object.assign(json, { __total });
      }),
    );
    return paginatedEnvelope<DailyReportJson>(mapped, pg);
  }

  /** Signed URL the client PUTs the attachment bytes to (report-attachments bucket). */
  async uploadUrl(dto: { name: string; sizeBytes: number; contentType?: string }) {
    if (!dto.name || dto.name.length > 160) throw new BadRequestException('name must be 1-160 characters');
    if (dto.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Attachment exceeds the 20 MB report-attachments limit');
    }
    if (dto.contentType && !/^(application\/pdf|application\/(vnd\.openxmlformats-officedocument|msword)|image\/)/.test(dto.contentType)) {
      throw new BadRequestException('Only PDF, Office documents or images are allowed for reports');
    }
    const rand = Math.random().toString(36).slice(2, 8);
    const path = `${Date.now()}-${rand}-${slugify(dto.name)}`;
    const { url } = await this.storage.signedUploadUrl(BUCKETS.reportAttachments, path);
    return { path, url };
  }

  async create(dto: CreateReportDto, userId: string): Promise<DailyReportJson> {
    parseDate(dto.reportDate, 'reportDate');
    const section = await this.db.queryOne(`select id from sections where id = $1::uuid`, [
      dto.sectionId,
    ]);
    if (!section) throw new BadRequestException('Unknown sectionId');
    const subject = await this.db.queryOne(`select id from subjects where id = $1::uuid`, [
      dto.subjectId,
    ]);
    if (!subject) throw new BadRequestException('Unknown subjectId');

    try {
      const row = await this.db.queryOne<ReportRow>(
        `with ins as (
         insert into daily_reports (faculty_id, section_id, subject_id, report_date, topic, attachment_path)
         values ($1, $2, $3, $4, $5, $6)
         returning id, faculty_id, section_id, subject_id, report_date, topic, attachment_path, created_at
       )
       select r.id, r.faculty_id, r.section_id, sec.label as section_label,
              r.subject_id, sub.name as subject_name,
              to_char(r.report_date, 'YYYY-MM-DD') as report_date,
              r.topic, r.attachment_path, r.created_at,
              u.display_name as submitted_by
         from ins r
         left join sections sec on sec.id = r.section_id
         left join subjects sub on sub.id = r.subject_id
         join users u on u.id = r.faculty_id`,
        [
          userId,
          dto.sectionId,
          dto.subjectId,
          dto.reportDate,
          dto.topic.trim(),
          dto.attachmentPath?.trim() || null,
        ],
      );
      return this.mapReport(row!);
    } catch (err: any) {
      // Unique violation on (faculty_id, section_id, subject_id, report_date)
      if (err.code === '23505' && (err.constraint === 'uq_daily_reports_occurrence' || String(err.message).includes('uq_daily_reports_occurrence'))) {
        throw new BadRequestException({
          code: 'REPORT_IMMUTABLE',
          message: 'A report for this section/subject/date already exists and cannot be duplicated.',
        });
      }
      throw err;
    }
  }

  /** Reports are immutable — no edit or delete after submission (DB trigger also enforces). */
  async remove(id: string, _user: { id: string; role: 'student' | 'faculty' | 'admin' }) {
    await this.findOneRow(id); // ensure 404 if not found
    throw new BadRequestException({
      code: 'REPORT_IMMUTABLE',
      message: 'Reports cannot be deleted or edited after submission.',
    });
  }

  private async findOneRow(id: string): Promise<ReportRow> {
    if (!isUuid(id)) throw new NotFoundException('Report not found');
    const row = await this.db.queryOne<ReportRow>(
      `${REPORT_SELECT}
        where r.id = $1::uuid`,
      [id],
    );
    if (!row) throw new NotFoundException('Report not found');
    return row;
  }

  private async mapReport(r: ReportRow): Promise<DailyReportJson> {
    const { fileName, fileType } = attachmentMeta(r.attachment_path);
    let attachmentUrl: string | null = null;
    if (r.attachment_path) {
      try {
        attachmentUrl = await this.storage.signedUrl(
          BUCKETS.reportAttachments,
          r.attachment_path,
          3600,
        );
      } catch (err) {
        this.logger.warn(`sign failed for ${r.attachment_path}: ${(err as Error).message}`);
      }
    }
    return {
      id: r.id,
      section: r.section_label,
      sectionId: r.section_id,
      subject: r.subject_name,
      subjectId: r.subject_id,
      date: r.report_date,
      topic: r.topic,
      fileName,
      fileType,
      attachmentUrl,
      submittedBy: r.submitted_by,
    };
  }
}

/**
 * Derive display metadata from the storage path. Paths are generated as
 * `${Date.now()}-${slug(originalName)}`, so strip the leading timestamp to
 * recover the (slugged) file name and take the extension as the type.
 */
function attachmentMeta(path: string | null): { fileName: string | null; fileType: string | null } {
  if (!path) return { fileName: null, fileType: null };
  const base = path.split('/').pop()!;
  const stripped = base.replace(/^\d+-/, '');
  const dot = stripped.lastIndexOf('.');
  const ext = dot > 0 ? stripped.slice(dot + 1).toLowerCase() : null;
  return { fileName: stripped, fileType: ext };
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

/** Lowercase, dash-separated path segment safe for object storage. */
function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'report';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
