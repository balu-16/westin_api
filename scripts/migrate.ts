import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    create table if not exists schema_migrations (
      id int primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await pool.query<{ id: string }>('select id::text as id from schema_migrations');
  const applied = new Set(rows.map((r) => String(Number(r.id))));

  const dir = path.resolve(__dirname, '../db/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const id = String(Number(file.split('_')[0]));
    if (applied.has(id)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`applying ${file} ...`);
    await pool.query('begin');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (id, name) values ($1, $2)', [Number(id), file]);
      await pool.query('commit');
      console.log(`applied ${file}`);
    } catch (err) {
      await pool.query('rollback');
      console.error(`FAILED ${file}:`, (err as Error).message);
      process.exit(1);
    }
  }

  const list = await pool.query('select id, name from schema_migrations order by id');
  console.log('applied migrations:', list.rows.map((r) => r.name).join(', ') || '(none)');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
