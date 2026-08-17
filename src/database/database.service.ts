import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { env } from '../config/env';

/**
 * Thin wrapper around node-postgres. All SQL in this codebase is hand-written
 * and parameterized — there is no ORM by design.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      query_timeout: 8_000,
    });
    this.pool.on('error', (err) => console.error('[pg pool error]', err.message));
  }

  async onModuleInit() {
    await this.query('select 1');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pool.query(sql, params as any[]).then((r) => r.rows as T[]);
  }

  async queryOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Run a callback inside a transaction; rolls back on any thrown error. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
