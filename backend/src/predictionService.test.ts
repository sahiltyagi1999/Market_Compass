import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { istTime } from './marketSession.js';
import { buildPrediction, calibrationFrom, recordPredictions, resolveDuePredictions, trackRecordFrom } from './predictionService.js';
import type { PriceLookup } from './priceHistory.js';
import { closeAtOrBefore } from './priceHistory.js';
import { scoreCrypto, scoreNifty } from './scoring.js';
import { FileRepository, PostgresRepository, type PredictionRecord } from './storage.js';
import type { Candle } from './types.js';

const ist = (date: string, hhmm: string) => {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return istTime(date, hours * 60 + minutes);
};
const live = [{ name: 'market data', status: 'live' as const, message: 'ok' }];
const tempRepo = async () => new FileRepository(join(await mkdtemp(join(tmpdir(), 'mc-')), 'predictions.json'));

function niftyCard(now: number) {
  return scoreNifty({ spot: 25_000, previousClose: 24_800 }, live, { now });
}

function cryptoCard(now: number) {
  return scoreCrypto({ btcPrice: 80_000, btcChangePct: 2, ethChangePct: 3 }, live, { now });
}

describe('prediction generation', () => {
  it('deduplicates repeated requests within the same slot', async () => {
    const repo = await tempRepo();
    const now = ist('2026-10-12', '10:40');
    const first = await recordPredictions([niftyCard(now), cryptoCard(now)], repo, now);
    const second = await recordPredictions([niftyCard(now + 60_000), cryptoCard(now + 60_000)], repo, now + 60_000);
    expect(first.map((row) => row.status)).toEqual(['recorded', 'recorded']);
    expect(second.map((row) => row.status)).toEqual(['duplicate', 'duplicate']);
    expect(await repo.list()).toHaveLength(2);
  });

  it('allows only one insert when several writers race on the same id', async () => {
    const repo = await tempRepo();
    const now = ist('2026-10-12', '10:40');
    const results = await Promise.all(Array.from({ length: 5 }, () => recordPredictions([cryptoCard(now)], repo, now)));
    expect(results.flat().filter((row) => row.status === 'recorded')).toHaveLength(1);
  });

  it('caps NIFTY targets at the session close and skips near the close or when closed', () => {
    const late = buildPrediction(niftyCard(ist('2026-10-12', '14:05')), ist('2026-10-12', '14:05'));
    expect('skip' in late ? null : late.targetAt).toBe(new Date(ist('2026-10-12', '15:30')).toISOString());
    expect('skip' in late ? null : late.truncatedAtClose).toBe(true);
    expect('skip' in buildPrediction(niftyCard(ist('2026-10-12', '14:45')), ist('2026-10-12', '14:45'))).toBe(true);
    expect('skip' in buildPrediction(niftyCard(ist('2026-10-12', '09:20')), ist('2026-10-12', '09:20'))).toBe(true);
    expect('skip' in buildPrediction(niftyCard(ist('2026-10-20', '11:00')), ist('2026-10-20', '11:00'))).toBe(true);
    expect('skip' in buildPrediction(niftyCard(ist('2026-10-10', '11:00')), ist('2026-10-10', '11:00'))).toBe(true);
  });

  it('uses fixed six-hour UTC windows for crypto', () => {
    const now = Date.parse('2026-10-10T21:10:00Z');
    const record = buildPrediction(cryptoCard(now), now);
    expect('skip' in record).toBe(false);
    if (!('skip' in record)) {
      expect(record.targetAt).toBe('2026-10-11T03:10:00.000Z');
      expect(record.slotStart).toBe('2026-10-10T21:00:00.000Z');
      expect(record.horizonKind).toBe('rolling-utc');
    }
  });
});

describe('prediction resolution', () => {
  const lookupFrom = (prices: Record<number, number>): PriceLookup => async (_market, time) => {
    const at = Number(Object.keys(prices).map(Number).filter((key) => key <= time).sort((a, b) => b - a)[0]);
    return Number.isFinite(at) ? { price: prices[at], at } : null;
  };

  it('resolves against prices at creation and target time, not at evaluation time', async () => {
    const repo = await tempRepo();
    const created = ist('2026-10-12', '10:30');
    await recordPredictions([niftyCard(created)], repo, created);
    const [record] = await repo.list();
    const target = Date.parse(record.targetAt);
    const lookup = lookupFrom({ [created]: 25_000, [target]: 25_100, [target + 3_600_000]: 24_000 });
    const summary = await resolveDuePredictions(repo, lookup, target + 2 * 3_600_000);
    const [resolved] = await repo.list();
    expect(summary.resolved).toBe(1);
    expect(resolved.endPrice).toBe(25_100);
    expect(resolved.outcome).toBe('UP');
    expect(resolved.correct).toBe(resolved.verdict === 'BULLISH');
  });

  it('keeps a prediction pending while target data is missing, then marks it unresolvable', async () => {
    const repo = await tempRepo();
    const now = Date.parse('2026-10-10T10:00:00Z');
    await recordPredictions([cryptoCard(now)], repo, now);
    const missing: PriceLookup = async () => null;
    const early = await resolveDuePredictions(repo, missing, now + 7 * 3_600_000);
    expect(early.stillPending).toBe(1);
    expect((await repo.list())[0].status).toBe('pending');
    const late = await resolveDuePredictions(repo, missing, now + 90 * 3_600_000);
    expect(late.unresolvable).toBe(1);
    expect((await repo.list())[0].status).toBe('unresolvable');
  });

  it('refuses NIFTY outcomes whose prices come from different sessions', async () => {
    const repo = await tempRepo();
    const created = ist('2026-10-12', '10:30');
    await recordPredictions([niftyCard(created)], repo, created);
    const nextDay = ist('2026-10-13', '10:00');
    // A misaligned provider returns the next session's candle for the target time.
    const lookup: PriceLookup = async (_market, time) => ({ price: 25_000, at: time === created ? created : nextDay });
    await resolveDuePredictions(repo, lookup, ist('2026-10-13', '12:00'));
    expect((await repo.list())[0]).toMatchObject({ status: 'unresolvable' });
  });

  it('does not use a candle outside the tolerance as the target price', () => {
    const candles: Candle[] = [{ time: 0, open: 1, high: 1, low: 1, close: 100, volume: 1 }];
    expect(closeAtOrBefore(candles, 60_000, 60_000, 180_000)?.price).toBe(100);
    expect(closeAtOrBefore(candles, 60_000, 30 * 60_000, 180_000)).toBeNull();
    expect(closeAtOrBefore(candles, 60_000, 30_000, 180_000)).toBeNull();
  });
});

describe('track record and calibration', () => {
  const resolved = (index: number, verdict: PredictionRecord['verdict'], outcome: PredictionRecord['outcome'], score = 40): PredictionRecord => ({
    id: `crypto:v:${index}`,
    market: 'crypto',
    modelVersion: 'v',
    createdAt: new Date(index * 3_600_000).toISOString(),
    slotStart: new Date(index * 3_600_000).toISOString(),
    targetAt: new Date(index * 3_600_000 + 6 * 3_600_000).toISOString(),
    horizonMinutes: 360,
    horizonKind: 'rolling-utc',
    truncatedAtClose: false,
    verdict,
    score,
    signalQuality: 60,
    heuristicProbabilities: { bullish: 60, neutral: 30, bearish: 10 },
    thresholds: { upPct: 0.2, downPct: 0.2 },
    snapshotPrice: 1,
    status: 'resolved',
    outcome,
    correct: (verdict === 'BULLISH' && outcome === 'UP') || (verdict === 'NEUTRAL' && outcome === 'NEUTRAL') || (verdict === 'BEARISH' && outcome === 'DOWN')
  });

  it('counts overlapping hourly predictions separately from independent ones', () => {
    const records = Array.from({ length: 60 }, (_, index) => resolved(index, 'BULLISH', 'UP'));
    const record = trackRecordFrom(records);
    expect(record.resolved).toBe(60);
    expect(record.nonOverlapping.n).toBe(10);
    expect(record.hitRate).toBe(100);
  });

  it('reports calibration as unavailable until enough independent outcomes exist', () => {
    const records = Array.from({ length: 300 }, (_, index) => resolved(index, 'BULLISH', 'UP'));
    const status = calibrationFrom(records, 40);
    expect(status.status).toBe('insufficient_data');
    expect(status.calibratedProbabilities).toBeNull();
    expect(status.sampleSize).toBe(50);
  });

  it('reports no_skill when calibrated probabilities do not beat class frequencies on held-out data', () => {
    // Score carries no information: outcomes alternate regardless of score.
    const records = Array.from({ length: 1200 }, (_, index) => resolved(index, 'BULLISH', index % 2 ? 'UP' : 'DOWN', (index * 37) % 100 - 50));
    const status = calibrationFrom(records, 30);
    expect(status.status).toBe('no_skill');
    expect(status.calibratedProbabilities).toBeNull();
    expect(status.empiricalBrier).not.toBeNull();
  });

  it('calibrates on earlier outcomes and scores on later ones once the sample is large enough', () => {
    // Independent windows are every 6th row, so alternate per 6-row block to give them informative scores.
    const records = Array.from({ length: 1200 }, (_, index) => { const up = Math.floor(index / 6) % 2 === 1; return resolved(index, up ? 'BULLISH' : 'BEARISH', up ? 'UP' : 'DOWN', up ? 50 : -50); });
    const status = calibrationFrom(records, 50);
    expect(status.status).toBe('calibrated');
    expect(status.brier!).toBeLessThan(status.empiricalBrier!);
    expect(status.calibratedProbabilities!.bullish + status.calibratedProbabilities!.neutral + status.calibratedProbabilities!.bearish).toBe(100);
    expect(status.brier).not.toBeNull();
  });
});

describe('prediction storage', () => {
  it('persists records across repository instances (reload)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-'));
    const path = join(dir, 'predictions.json');
    const now = Date.parse('2026-10-10T10:00:00Z');
    await recordPredictions([cryptoCard(now)], new FileRepository(path), now);
    const reloaded = new FileRepository(path);
    expect(await reloaded.list()).toHaveLength(1);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.schema).toBe(2);
  });

  it('imports v3 entries as legacy records excluded from evaluation and keeps a backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-'));
    const path = join(dir, 'predictions.json');
    await writeFile(path, JSON.stringify([{ id: 'a', slug: 'crypto', modelVersion: 'research-desk-v3-safety', generatedAt: '2026-09-01T00:00:00Z', targetAt: '2026-09-01T06:00:00Z', verdict: 'BULLISH', startPrice: 1, endPrice: 2, movePct: 100, correct: true }]));
    const repo = new FileRepository(path);
    const records = await repo.list();
    expect(records[0]).toMatchObject({ status: 'legacy', id: 'legacy:a' });
    expect(trackRecordFrom(records).resolved).toBe(0);
    await repo.insertIfAbsent({ ...records[0], id: 'new', status: 'pending' });
    expect(JSON.parse(await readFile(`${path}.v3-backup`, 'utf8'))).toHaveLength(1);
  });

  it('uses conflict-safe SQL for Postgres inserts and resolutions', async () => {
    const calls: string[] = [];
    const repo = new PostgresRepository({
      query: async (text) => {
        calls.push(text);
        return { rows: [], rowCount: text.includes('INSERT') ? 0 : 1 };
      }
    });
    const now = Date.parse('2026-10-10T10:00:00Z');
    const record = buildPrediction(cryptoCard(now), now) as PredictionRecord;
    expect(await repo.insertIfAbsent(record)).toBe(false);
    expect(calls.some((text) => text.includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
    await repo.resolve({ ...record, status: 'resolved' });
    expect(calls.some((text) => text.includes("AND status = 'pending'"))).toBe(true);
  });
});
