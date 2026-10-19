import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { FileRepository, getRepository } from './storage.js';

loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

/**
 * Copies every record from the local JSON file (including converted v3
 * legacy entries) into the repository selected by DATABASE_URL. Safe to
 * re-run: inserts are idempotent by id.
 */
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the target Postgres database first.');
  const source = new FileRepository(process.argv[2] || fileURLToPath(new URL('../data/predictions.json', import.meta.url)));
  const target = await getRepository();
  const records = await source.list();
  let inserted = 0;
  for (const record of records) if (await target.insertIfAbsent(record)) inserted += 1;
  console.log(`Imported ${inserted} of ${records.length} records (${records.length - inserted} already present).`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
