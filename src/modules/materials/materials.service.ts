import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StorageService, BUCKETS } from '../storage/storage.service';
import { CreateMaterialDto, FileType, MAX_FILE_BYTES, UpdateMaterialDto } from './dto';
import { pageParams, paginatedEnvelope } from '../../common/util/pagination';

type FileRow = {
  id: string;
  name: string;
  description: string | null;
  file_type: FileType;
  size_bytes: string; // pg returns bigint as string
  storage_path: string;
  created_at: Date;
  subject_id: string | null;
  subject_name: string | null;
  uploader_name: string | null;
};

export type MaterialFileJson = {
  id: string;
  name: string;
  description: string | null;
  type: FileType;
  subject: string | null;
  subjectId: string | null;
  uploadedBy: string | null;
  date: string;
  size: number;
  downloadUrl: string | null;
};

const FILE_COLUMNS = `f.id, f.name, f.description, f.file_type, f.size_bytes, f.storage_path,
                      f.created_at, f.subject_id, s.name as subject_name, u.display_name as uploader_name`;

const FILE_JOINS = `left join subjects s on s.id = f.subject_id
                    left join users u on u.id = f.uploaded_by`;

@Injectable()
export class MaterialsService {
  private logger = new Logger(MaterialsService.name);

  constructor(
    private db: DatabaseService,
    private storage: StorageService,
  ) {}

  /**
   * Library listing. `files` honors the search/subject filters with pagination;
   * `folders` and `stats` always describe the whole collection so folder
   * navigation stays stable while filtering. `pagination.total` is filtered.
   */
  async list(search?: string, subjectId?: string, sort?: string, page?: string | number, pageSize?: string | number) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      const p = `$${params.length}`;
      where.push(`(f.name ilike ${p} or f.description ilike ${p} or s.name ilike ${p})`);
    }
    if (subjectId) {
      if (!isUuid(subjectId)) throw new BadRequestException('subjectId must be a UUID');
      params.push(subjectId);
      where.push(`f.subject_id = $${params.length}::uuid`);
    }

    const sortNorm = (sort ?? 'latest').toLowerCase();
    let orderBy: string;
    switch (sortNorm) {
      case 'latest':
        orderBy = `f.created_at desc, lower(f.name) asc, f.id asc`;
        break;
      case 'oldest':
        orderBy = `f.created_at asc, lower(f.name) asc, f.id asc`;
        break;
      case 'name':
        orderBy = `lower(f.name) asc, f.id asc`;
        break;
      case 'size':
        orderBy = `f.size_bytes desc, lower(f.name) asc, f.id asc`;
        break;
      default:
        throw new BadRequestException('sort must be one of latest, oldest, name, size');
    }

    // Enforce bounded pageSize (default 10, max 50)
    const rawPg = pageParams(page, pageSize);
    const defaultSize = pageSize == null || String(pageSize).trim() === '' ? 10 : rawPg.pageSize;
    const effPageSize = Math.min(defaultSize, 50);
    const effPg = { ...rawPg, pageSize: effPageSize, limit: effPageSize, offset: (rawPg.page - 1) * effPageSize };
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const rows = await this.db.query<FileRow & { __total?: string | number }>(
      `select ${FILE_COLUMNS}, count(*) over() as "__total"
         from study_files f
         ${FILE_JOINS}
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by ${orderBy}
        limit $${limitIdx} offset $${offsetIdx}`,
      [...params, effPg.limit, effPg.offset],
    );
    const mappedFiles = await Promise.all(
      rows.map(async (r) => {
        const { __total, ...rest } = r;
        return { json: await this.mapFile(rest as FileRow), __total };
      }),
    );
    const envelope = paginatedEnvelope(mappedFiles.map((m) => ({ ...m.json, __total: m.__total }) as any), effPg);
    const files = envelope.rows;

    const folderRows = await this.db.query<{
      subject_id: string | null;
      subject_name: string | null;
      file_count: string;
    }>(
      `select f.subject_id, s.name as subject_name, count(*) as file_count
         from study_files f
         left join subjects s on s.id = f.subject_id
        group by f.subject_id, s.name
        order by s.name asc nulls last`,
    );
    const folders = folderRows.map((r) => ({
      id: r.subject_id,
      name: r.subject_name ?? 'General',
      fileCount: Number(r.file_count),
    }));

    const statsRow = await this.db.queryOne<{
      total_files: string;
      total_size: string | null;
      subject_count: string;
    }>(
      `select count(*) as total_files,
              coalesce(sum(size_bytes), 0) as total_size,
              count(distinct subject_id) as subject_count
         from study_files`,
    );

    return {
      files,
      folders,
      stats: {
        totalFiles: Number(statsRow?.total_files ?? 0),
        totalSize: Number(statsRow?.total_size ?? 0),
        subjects: Number(statsRow?.subject_count ?? 0),
      },
      pagination: {
        page: envelope.page,
        pageSize: envelope.pageSize,
        total: envelope.total,
        totalPages: Math.max(1, Math.ceil(envelope.total / envelope.pageSize)),
      },
    };
  }

  /** Signed URL the client PUTs the file bytes to (study-materials bucket). */
  async uploadUrl(dto: { name: string; sizeBytes: number }) {
    if (dto.sizeBytes > MAX_FILE_BYTES) {
      throw new BadRequestException('File exceeds the 50 MB study-materials limit');
    }
    const path = `${Date.now()}-${slugify(dto.name)}`;
    const { url } = await this.storage.signedUploadUrl(BUCKETS.studyMaterials, path);
    return { path, url };
  }

  async create(dto: CreateMaterialDto, userId: string): Promise<MaterialFileJson> {
    if (dto.sizeBytes > MAX_FILE_BYTES) {
      throw new BadRequestException('File exceeds the 50 MB study-materials limit');
    }
    await this.assertSubjectExists(dto.subjectId ?? null);
    const row = await this.db.queryOne<FileRow>(
      `with ins as (
         insert into study_files (name, subject_id, file_type, size_bytes, storage_path, description, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, name, description, file_type, size_bytes, storage_path, created_at, subject_id, uploaded_by
       )
       select ${FILE_COLUMNS}
         from ins f
         ${FILE_JOINS}`,
      [
        dto.name.trim(),
        dto.subjectId ?? null,
        dto.fileType,
        dto.sizeBytes,
        dto.storagePath,
        dto.description?.trim() || null,
        userId,
      ],
    );
    return this.mapFile(row!);
  }

  async update(id: string, dto: UpdateMaterialDto): Promise<MaterialFileJson> {
    await this.findOneRow(id);
    if (dto.subjectId !== undefined) await this.assertSubjectExists(dto.subjectId ?? null);

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.name !== undefined) set('name', dto.name.trim());
    if (dto.subjectId !== undefined) set('subject_id', dto.subjectId ?? null);
    if (dto.description !== undefined) set('description', dto.description?.trim() || null);

    if (sets.length) {
      const updated = await this.db.queryOne<FileRow>(
        `with upd as (
           update study_files set ${sets.join(', ')}
            where id = $${params.length + 1}::uuid
           returning id, name, description, file_type, size_bytes, storage_path, created_at, subject_id, uploaded_by
         )
         select ${FILE_COLUMNS}
           from upd f
           ${FILE_JOINS}`,
        [...params, id],
      );
      if (!updated) throw new NotFoundException('Material not found');
      return this.mapFile(updated);
    }
    return this.mapFile(await this.findOneRow(id));
  }

  async remove(id: string) {
    const row = await this.findOneRow(id);
    await this.db.query(`delete from study_files where id = $1`, [id]);
    try {
      await this.storage.deleteObject(BUCKETS.studyMaterials, row.storage_path);
    } catch (err) {
      // Row is already gone; don't fail the request if the object can't be removed.
      this.logger.warn(`storage delete failed for ${row.storage_path}: ${(err as Error).message}`);
    }
    return { deleted: true };
  }

  private async findOneRow(id: string): Promise<FileRow> {
    if (!isUuid(id)) throw new NotFoundException('Material not found');
    const row = await this.db.queryOne<FileRow>(
      `select ${FILE_COLUMNS}
         from study_files f
         ${FILE_JOINS}
        where f.id = $1::uuid`,
      [id],
    );
    if (!row) throw new NotFoundException('Material not found');
    return row;
  }

  private async assertSubjectExists(subjectId: string | null) {
    if (!subjectId) return;
    const subject = await this.db.queryOne(`select id from subjects where id = $1::uuid`, [
      subjectId,
    ]);
    if (!subject) throw new BadRequestException('Unknown subjectId');
  }

  private async mapFile(r: FileRow): Promise<MaterialFileJson> {
    let downloadUrl: string | null = null;
    try {
      downloadUrl = await this.storage.signedUrl(BUCKETS.studyMaterials, r.storage_path, 3600);
    } catch (err) {
      this.logger.warn(`sign failed for ${r.storage_path}: ${(err as Error).message}`);
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      type: r.file_type,
      subject: r.subject_name,
      subjectId: r.subject_id,
      uploadedBy: r.uploader_name,
      date: new Date(r.created_at).toISOString(),
      size: Number(r.size_bytes),
      downloadUrl,
    };
  }
}

/** Lowercase, dash-separated path segment safe for object storage. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'file';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
