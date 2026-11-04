import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Applies the checked-in Prisma SQL migrations without requiring a native CLI engine.
// The ledger matches Prisma's schema so a later Prisma migrate deploy can inspect it.
// Never use db push to mutate a production schema.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL precisa estar definida para aplicar migrations.');
const migrationRoot = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
let connected = false;
let locked = false;
try {
  await client.connect();
  connected = true;
  await client.query('SELECT pg_advisory_lock(72707369)');
  locked = true;
  await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  )`);
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^[0-9][A-Za-z0-9_-]*$/.test(entry.name))
    .map(entry => entry.name).sort();
  if (!names.length) throw new Error('Nenhuma migration SQL encontrada.');
  const ledger = await client.query('SELECT "migration_name", "checksum", "finished_at", "rolled_back_at" FROM "_prisma_migrations" ORDER BY "started_at"');
  for (const row of ledger.rows) {
    if (!row.rolled_back_at && !row.finished_at) throw new Error(`Migration incompleta: ${row.migration_name}. Investigue antes de continuar.`);
    if (!row.rolled_back_at && !names.includes(row.migration_name)) throw new Error(`Migration aplicada ausente no checkout: ${row.migration_name}.`);
  }
  let applied = 0;
  for (const name of names) {
    const bytes = await readFile(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url));
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const existing = ledger.rows.filter(row => row.migration_name === name && !row.rolled_back_at);
    if (existing.length > 1) throw new Error(`Ledger duplicado para ${name}.`);
    if (existing.length) {
      if (existing[0].checksum !== checksum) throw new Error(`Checksum divergente: ${name}. Não altere migrations já aplicadas.`);
      continue;
    }
    const id = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query('INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name") VALUES ($1, $2, $3)', [id, checksum, name]);
      await client.query(bytes.toString('utf8'));
      await client.query('UPDATE "_prisma_migrations" SET "finished_at" = now(), "applied_steps_count" = 1 WHERE "id" = $1', [id]);
      await client.query('COMMIT');
      applied += 1;
      console.log(`Migration aplicada: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log(`${applied} migration(s) aplicada(s); schema atualizado.`);
} catch (error) {
  console.error('Falha ao aplicar migrations:', error instanceof Error ? error.message : 'erro desconhecido');
  process.exitCode = 1;
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock(72707369)').catch(() => {});
  if (connected) await client.end();
}
