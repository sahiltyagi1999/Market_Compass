import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { MarketCard, TrackRecord } from './types.js';

interface PredictionEntry {
  id: string;
  slug: MarketCard['slug'];
  modelVersion: string;
  generatedAt: string;
  targetAt: string;
  verdict: Exclude<MarketCard['verdict'], 'UNAVAILABLE'>;
  startPrice: number;
  resolvedAt?: string;
  endPrice?: number;
  movePct?: number;
  correct?: boolean;
}

const storePath = fileURLToPath(new URL('../data/predictions.json', import.meta.url));
export const MODEL_VERSION = 'research-desk-v3-safety';
let writeQueue = Promise.resolve();

async function loadEntries() {
  try {
    const parsed = JSON.parse(await readFile(storePath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as PredictionEntry[] : [];
  } catch {
    return [];
  }
}

function isNiftyMarketHours(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  const weekday = value('weekday');
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  return !['Sat', 'Sun'].includes(weekday) && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 15;
}

function wasCorrect(entry: PredictionEntry, movePct: number) {
  if (entry.verdict === 'BULLISH') return movePct > 0.2;
  if (entry.verdict === 'BEARISH') return movePct < -0.2;
  return Math.abs(movePct) <= 0.35;
}

function recordFor(entries: PredictionEntry[], slug: MarketCard['slug']): TrackRecord {
  const matching = entries.filter((entry) => entry.slug === slug && entry.modelVersion === MODEL_VERSION);
  const resolved = matching.filter((entry) => entry.correct != null);
  const pending = matching.filter((entry) => entry.correct == null);
  const hitRate = resolved.length
    ? Math.round(resolved.filter((entry) => entry.correct).length / resolved.length * 100)
    : null;
  return {
    resolved: resolved.length,
    pending: pending.length,
    hitRate,
    note: resolved.length < 30
      ? `Calibration is provisional until at least 30 outcomes resolve (${resolved.length}/30).`
      : 'Hit rate is based on automatically recorded forward outcomes.'
  };
}

async function update(cards: MarketCard[]) {
  const now = new Date();
  const bySlug = new Map(cards.map((card) => [card.slug, card]));
  const entries = await loadEntries();

  for (const entry of entries) {
    if (entry.modelVersion !== MODEL_VERSION || entry.correct != null || new Date(entry.targetAt).getTime() > now.getTime()) continue;
    const price = bySlug.get(entry.slug)?.price;
    if (!price || !entry.startPrice) continue;
    const movePct = ((price - entry.startPrice) / entry.startPrice) * 100;
    entry.resolvedAt = now.toISOString();
    entry.endPrice = price;
    entry.movePct = Number(movePct.toFixed(3));
    entry.correct = wasCorrect(entry, movePct);
  }

  for (const card of cards) {
    if (!card.price || card.verdict === 'UNAVAILABLE') continue;
    if (card.slug === 'nifty' && !isNiftyMarketHours(now)) continue;
    const latestPending = entries
      .filter((entry) => entry.slug === card.slug && entry.modelVersion === MODEL_VERSION && entry.correct == null)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
    if (latestPending && now.getTime() - new Date(latestPending.generatedAt).getTime() < 60 * 60 * 1000) continue;
    const horizonHours = card.slug === 'nifty' ? 3 : 6;
    entries.push({
      id: randomUUID(),
      slug: card.slug,
      modelVersion: MODEL_VERSION,
      generatedAt: now.toISOString(),
      targetAt: new Date(now.getTime() + horizonHours * 60 * 60 * 1000).toISOString(),
      verdict: card.verdict,
      startPrice: card.price
    });
  }

  const retained = entries.slice(-500);
  await writeFile(storePath, `${JSON.stringify(retained, null, 2)}\n`, 'utf8');
  for (const card of cards) card.trackRecord = recordFor(retained, card.slug);
}

export function attachTrackRecords(cards: MarketCard[]) {
  const operation = writeQueue.then(() => update(cards));
  writeQueue = operation.catch(() => undefined);
  return operation;
}
