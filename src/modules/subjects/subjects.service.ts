import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CacheService } from '../../common/cache/cache.service';

@Injectable()
export class SubjectsService {
  constructor(
    private db: DatabaseService,
    private cache: CacheService,
  ) {}

  list() {
    return this.cache.wrap('subjects:all', 60_000, () =>
      this.db.query(`
        select id, name, code from subjects order by code
      `),
    );
  }

  async create(dto: { name: string; code: string }) {
    const dup = await this.db.queryOne(`select 1 from subjects where code = $1`, [dto.code]);
    if (dup) throw new ConflictException(`Subject code ${dto.code} already exists`);
    const row = await this.db.queryOne<any>(
      `insert into subjects (name, code) values ($1, $2) returning id, name, code`,
      [dto.name, dto.code],
    );
    this.cache.invalidate('subjects');
    return row;
  }

  async update(id: string, dto: Partial<{ name: string; code: string }>) {
    const existing = await this.db.queryOne(`select id from subjects where id = $1`, [id]);
    if (!existing) throw new NotFoundException('Subject not found');
    if (dto.code) {
      const dup = await this.db.queryOne(`select 1 from subjects where code = $1 and id <> $2`, [dto.code, id]);
      if (dup) throw new ConflictException(`Subject code ${dto.code} already exists`);
    }
    const row = await this.db.queryOne<any>(
      `update subjects set name = coalesce($1, name), code = coalesce($2, code)
        where id = $3 returning id, name, code`,
      [dto.name ?? null, dto.code ?? null, id],
    );
    this.cache.invalidate('subjects');
    return row;
  }

  async remove(id: string) {
    const existing = await this.db.queryOne(`select id from subjects where id = $1`, [id]);
    if (!existing) throw new NotFoundException('Subject not found');
    await this.db.query(`delete from subjects where id = $1`, [id]);
    this.cache.invalidate('subjects');
    return { deleted: true };
  }
}
