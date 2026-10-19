import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutcomeThresholds } from './modelConfig.js';
import type { OutcomeClass, PredictedClass } from './outcomes.js';
import type { DirectionProbabilities, MarketCard, StorageInfo } from './types.js';

export type PredictionStatus = 'pending' | 'resolved' | 'unresolvable' | 'legacy';

export interface PredictionRecord {
  /** `${market}:${modelVersion}:${slotStartIso}` — unique per market, model and slot. */
  id: string;
  market: MarketCard['slug'];
  modelVersion: string;
  createdAt: string;
  slotStart: string;
  targetAt: string;
  horizonMinutes: number;
  horizonKind: 'intraday' | 'rolling-utc';
  truncatedAtClose: boolean;
  verdict: PredictedClass;
  score: number;
  signalQuality: number;
  heuristicProbabilities: DirectionProbabilities;
  thresholds: OutcomeThresholds;
  snapshotPrice: number;
  regime?: string;
  status: PredictionStatus;
  startPrice?: number;
  startPriceAt?: string;
  endPrice?: number;
  endPriceAt?: string;
  returnPct?: number;
  outcome?: OutcomeClass;
  correct?: boolean;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface PredictionRepository {
  readonly info: StorageInfo;
  /** Inserts the record unless one with the same id exists. Returns true when inserted. */
  insertIfAbsent(record: PredictionRecord): Promise<boolean>;
  /** Pending records whose target time is at or before `before`. */
  listDue(before: Date): Promise<PredictionRecord[]>;
  /** Saves a resolution only if the stored record is still pending. Returns true when saved. */
  resolve(record: PredictionRecord): Promise<boolean>;
  list(filter?: { market?: MarketCard['slug']; modelVersion?: string }): Promise<PredictionRecord[]>;
}

const defaultFile = fileURLToPath(new URL('../data/predictions.json', import.meta.url));
const MAX_FILE_RECORDS = 20_000;

interface LegacyEntry {
  id: string;
  slug: MarketCard['slug'];
  modelVersion: string;
  generatedAt: string;
  targetAt: string;
  verdict: PredictedClass;
  startPrice: number;
  resolvedAt?: string;
  endPrice?: number;
  movePct?: number;
  correct?: boolean;
}

/** Legacy (v3) entries were resolved with the price at whatever time a page loaded; keep them, but never score them. */
export function convertLegacy(entry: LegacyEntry): PredictionRecord {
  return {
    id: `legacy:${entry.id}`,
    market: entry.slug,
    modelVersion: entry.modelVersion,
    createdAt: entry.generatedAt,
    slotStart: entry.generatedAt,
    targetAt: entry.targetAt,
    horizonMinutes: Math.round((Date.parse(entry.targetAt) - Date.parse(entry.generatedAt)) / 60_000),
    horizonKind: entry.slug === 'nifty' ? 'intraday' : 'rolling-utc',
    truncatedAtClose: false,
    verdict: entry.verdict,
    score: 0,
    signalQuality: 0,
    heuristicProbabilities: { bullish: 0, neutral: 100, bearish: 0 },
    thresholds: { upPct: 0.2, downPct: 0.2 },
    snapshotPrice: entry.startPrice,
    status: 'legacy',
    startPrice: entry.startPrice,
    endPrice: entry.endPrice,
    returnPct: entry.movePct,
    correct: entry.correct,
    resolvedAt: entry.resolvedAt,
    resolutionNote: 'Imported from v3; resolved against the price at page-load time, so excluded from evaluation.'
  };
}

/**
 * JSON-file repository. Writes are serialised in-process and replaced
 * atomically (temp file + rename), so a crash cannot leave half a file.
 * It cannot coordinate between several server instances and is not durable
 * on hosts with an ephemeral filesystem (e.g. Render free web services).
 */
export class FileRepository implements PredictionRepository {
  readonly info: StorageInfo;
  private queue: Promise<unknown> = Promise.resolve();
  private records: PredictionRecord[] | null = null;

  constructor(private readonly path = defaultFile, durable = false) {
    this.info = {
      kind: 'file',
      durable,
      note: durable
        ? 'Local JSON file on a persistent disk.'
        : 'Local JSON file. Not durable on hosts with an ephemeral filesystem; set DATABASE_URL for Postgres.'
    };
  }

  private async load() {
    if (this.records) return this.records;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep the unreadable file for manual recovery instead of overwriting it.
        await copyFile(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      parsed = { schema: 2, records: [] };
    }
    if (Array.isArray(parsed)) {
      await copyFile(this.path, `${this.path}.v3-backup`).catch(() => undefined);
      this.records = (parsed as LegacyEntry[]).filter((entry) => entry && entry.id && entry.slug).map(convertLegacy);
    } else {
      const records = (parsed as { records?: PredictionRecord[] }).records;
      this.records = Array.isArray(records) ? records : [];
    }
    return this.records;
  }

  private async persist(records: PredictionRecord[]) {
    const retained = records.length > MAX_FILE_RECORDS ? records.slice(-MAX_FILE_RECORDS) : records;
    this.records = retained;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ schema: 2, records: retained }, null, 2)}\n`, 'utf8');
    await rename(temp, this.path);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  insertIfAbsent(record: PredictionRecord) {
    return this.exclusive(async () => {
      const records = await this.load();
      if (records.some((item) => item.id === record.id)) return false;
      await this.persist([...records, record]);
      return true;
    });
  }

  listDue(before: Date) {
    return this.exclusive(async () => (await this.load())
      .filter((item) => item.status === 'pending' && Date.parse(item.targetAt) <= before.getTime())
      .map((item) => ({ ...item })));
  }

  resolve(record: PredictionRecord) {
    return this.exclusive(async () => {
      const records = await this.load();
      const index = records.findIndex((item) => item.id === record.id);
      if (index < 0 || records[index].status !== 'pending') return false;
      const next = [...records];
      next[index] = record;
      await this.persist(next);
      return true;
    });
  }

  list(filter: { market?: MarketCard['slug']; modelVersion?: string } = {}) {
    return this.exclusive(async () => (await this.load())
      .filter((item) => (!filter.market || item.market === filter.market) && (!filter.modelVersion || item.modelVersion === filter.modelVersion))
      .map((item) => ({ ...item })));
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS predictions (
  id text PRIMARY KEY,
  market text NOT NULL,
  model_version text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  target_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS predictions_due_idx ON predictions (status, target_at);
CREATE INDEX IF NOT EXISTS predictions_market_version_idx ON predictions (market, model_version, created_at);
`;

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/**
 * Postgres repository. Uniqueness comes from the primary key, and resolution
 * uses a conditional UPDATE, so several instances cannot double-insert or
 * double-resolve the same prediction.
 */
export class PostgresRepository implements PredictionRepository {
  readonly info: StorageInfo = { kind: 'postgres', durable: true, note: 'Postgres via DATABASE_URL.' };
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private init() {
    if (!this.ready) this.ready = this.db.query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async insertIfAbsent(record: PredictionRecord) {
    await this.init();
    const result = await this.db.query(
      `INSERT INTO predictions (id, market, model_version, status, created_at, target_at, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [record.id, record.market, record.modelVersion, record.status, record.createdAt, record.targetAt, JSON.stringify(record)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listDue(before: Date) {
    await this.init();
    const result = await this.db.query(
      `SELECT record FROM predictions WHERE status = 'pending' AND target_at <= $1 ORDER BY target_at LIMIT 500`,
      [before.toISOString()]
    );
    return result.rows.map((row) => row.record as PredictionRecord);
  }

  async resolve(record: PredictionRecord) {
    await this.init();
    const result = await this.db.query(
      `UPDATE predictions SET status = $2, record = $3, updated_at = now() WHERE id = $1 AND status = 'pending'`,
      [record.id, record.status, JSON.stringify(record)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(filter: { market?: MarketCard['slug']; modelVersion?: string } = {}) {
    await this.init();
    const result = await this.db.query(
      `SELECT record FROM predictions
       WHERE ($1::text IS NULL OR market = $1) AND ($2::text IS NULL OR model_version = $2)
       ORDER BY created_at`,
      [filter.market ?? null, filter.modelVersion ?? null]
    );
    return result.rows.map((row) => row.record as PredictionRecord);
  }
}

let repository: PredictionRepository | null = null;

/** Postgres when DATABASE_URL is set, otherwise the local JSON file. */
export async function getRepository(): Promise<PredictionRepository> {
  if (repository) return repository;
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      max: 3,
      ssl: process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' }
    });
    repository = new PostgresRepository(pool);
  } else {
    repository = new FileRepository(defaultFile, process.env.PREDICTIONS_FILE_DURABLE === 'true');
  }
  return repository;
}

export function setRepositoryForTests(next: PredictionRepository | null) {
  repository = next;
}
