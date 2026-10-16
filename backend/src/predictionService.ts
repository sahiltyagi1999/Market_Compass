import { researchDecision } from './decision.js';
import {
  applyScoreCalibration,
  chronologicalSplit,
  classificationReport,
  evaluate,
  fitScoreCalibration,
  nonOverlapping,
  type EvaluatedSample,
  type EvaluationReport
} from './evaluation.js';
import { intradayTarget, istDateKey, marketStatus } from './marketSession.js';
import { DEFAULT_CONFIG, type ModelConfig } from './modelConfig.js';
import { classifyOutcome, isCorrect, returnPct, type OutcomeClass } from './outcomes.js';
import type { PriceLookup } from './priceHistory.js';
import { emptyTrackRecord, insufficientCalibration } from './scoring.js';
import type { PredictionRecord, PredictionRepository } from './storage.js';
import type { CalibrationStatus, DirectionProbabilities, MarketCard, TrackRecord } from './types.js';

export const MINIMUM_TRACK_SAMPLE = 30;
export const MINIMUM_CALIBRATION_SAMPLE = 150;
/** Give the target candle time to close and reach the provider. */
const RESOLUTION_DELAY_MS = 2 * 60_000;
/** After this long without a valid target price, stop retrying. */
const GIVE_UP_AFTER_MS = 72 * 60 * 60_000;
/** Skip the first minutes of the NSE session until candles exist. */
const NIFTY_OPENING_BUFFER_MS = 15 * 60_000;

export interface RecordResult {
  market: MarketCard['slug'];
  status: 'recorded' | 'duplicate' | 'skipped';
  reason?: string;
  id?: string;
}

export function slotStart(time: number, slotMinutes: number) {
  const size = slotMinutes * 60_000;
  return Math.floor(time / size) * size;
}

export function predictionId(market: MarketCard['slug'], modelVersion: string, slot: number) {
  return `${market}:${modelVersion}:${new Date(slot).toISOString()}`;
}

/** Builds the record for a card, or explains why no forecast is made now. */
export function buildPrediction(card: MarketCard, now: number, config: ModelConfig = DEFAULT_CONFIG): PredictionRecord | { skip: string } {
  if (card.verdict === 'UNAVAILABLE' || card.price == null) return { skip: 'No grounded price/verdict.' };
  let targetAt: number;
  let horizonMinutes: number;
  let truncatedAtClose = false;
  if (card.slug === 'nifty') {
    const status = marketStatus(now);
    if (status.open && status.sessionOpenAt != null && now < status.sessionOpenAt + NIFTY_OPENING_BUFFER_MS) {
      return { skip: 'Opening minutes: waiting for the first closed candles.' };
    }
    const target = intradayTarget(now, config.horizonMinutes.nifty, config.minIntradayHorizonMinutes);
    if (!target.ok) return { skip: target.detail };
    targetAt = target.targetAt;
    horizonMinutes = target.horizonMinutes;
    truncatedAtClose = target.truncatedAtClose;
  } else {
    horizonMinutes = config.horizonMinutes.crypto;
    targetAt = now + horizonMinutes * 60_000;
  }
  const slot = slotStart(now, config.predictionSlotMinutes);
  const regime = card.evidence.find((item) => item.key === 'regime')?.value.split(' ')[0];
  return {
    id: predictionId(card.slug, config.version, slot),
    market: card.slug,
    modelVersion: config.version,
    createdAt: new Date(now).toISOString(),
    slotStart: new Date(slot).toISOString(),
    targetAt: new Date(targetAt).toISOString(),
    horizonMinutes,
    horizonKind: card.slug === 'nifty' ? 'intraday' : 'rolling-utc',
    truncatedAtClose,
    verdict: card.verdict,
    score: card.score,
    signalQuality: card.confidence,
    heuristicProbabilities: card.probabilities,
    thresholds: config.outcome[card.slug],
    snapshotPrice: card.price,
    regime,
    status: 'pending'
  };
}

/** One prediction per market per slot; repeated calls, restarts and extra instances are deduplicated by id. */
export async function recordPredictions(
  cards: MarketCard[],
  repo: PredictionRepository,
  now = Date.now(),
  config: ModelConfig = DEFAULT_CONFIG
): Promise<RecordResult[]> {
  const results: RecordResult[] = [];
  for (const card of cards) {
    const built = buildPrediction(card, now, config);
    if ('skip' in built) {
      results.push({ market: card.slug, status: 'skipped', reason: built.skip });
      continue;
    }
    const inserted = await repo.insertIfAbsent(built);
    results.push({ market: card.slug, status: inserted ? 'recorded' : 'duplicate', id: built.id });
  }
  return results;
}

export interface ResolutionSummary {
  resolved: number;
  unresolvable: number;
  stillPending: number;
}

/**
 * Resolves due predictions against the candle close at the creation time and
 * at the target time. NIFTY start and end must fall on the same IST session.
 */
export async function resolveDuePredictions(
  repo: PredictionRepository,
  lookup: PriceLookup,
  now = Date.now()
): Promise<ResolutionSummary> {
  const due = await repo.listDue(new Date(now - RESOLUTION_DELAY_MS));
  const summary: ResolutionSummary = { resolved: 0, unresolvable: 0, stillPending: 0 };
  for (const record of due) {
    const target = Date.parse(record.targetAt);
    const created = Date.parse(record.createdAt);
    const expired = now - target > GIVE_UP_AFTER_MS;
    const giveUp = async (note: string) => {
      if (await repo.resolve({ ...record, status: 'unresolvable', resolvedAt: new Date(now).toISOString(), resolutionNote: note })) {
        summary.unresolvable += 1;
      }
    };
    let start;
    let end;
    try {
      [start, end] = await Promise.all([lookup(record.market, created), lookup(record.market, target)]);
    } catch (error) {
      if (expired) await giveUp(`Price provider failed until expiry: ${error instanceof Error ? error.message : 'unknown error'}`);
      else summary.stillPending += 1;
      continue;
    }
    if (!start || !end) {
      if (expired) await giveUp(`No candle close within tolerance at the ${!start ? 'start' : 'target'} time.`);
      else summary.stillPending += 1;
      continue;
    }
    if (record.market === 'nifty' && istDateKey(start.at) !== istDateKey(end.at)) {
      await giveUp('Start and target prices fall on different sessions; intraday outcome not evaluable.');
      continue;
    }
    const move = returnPct(start.price, end.price);
    const outcome = classifyOutcome(move, record.thresholds);
    const saved = await repo.resolve({
      ...record,
      status: 'resolved',
      startPrice: start.price,
      startPriceAt: new Date(start.at).toISOString(),
      endPrice: end.price,
      endPriceAt: new Date(end.at).toISOString(),
      returnPct: Number(move.toFixed(4)),
      outcome,
      correct: isCorrect(record.verdict, outcome),
      resolvedAt: new Date(now).toISOString()
    });
    if (saved) summary.resolved += 1;
  }
  return summary;
}

function toProbabilities(probabilities: DirectionProbabilities): Record<OutcomeClass, number> {
  return { UP: probabilities.bullish / 100, NEUTRAL: probabilities.neutral / 100, DOWN: probabilities.bearish / 100 };
}

export function toSamples(records: PredictionRecord[]): EvaluatedSample[] {
  return records
    .filter((record) => record.status === 'resolved' && record.outcome)
    .map((record) => ({
      startAt: Date.parse(record.createdAt),
      endAt: Date.parse(record.targetAt),
      predicted: record.verdict,
      actual: record.outcome!,
      score: record.score,
      probabilities: toProbabilities(record.heuristicProbabilities),
      returnPct: record.returnPct,
      regime: record.regime
    }));
}

export function trackRecordFrom(records: PredictionRecord[]): TrackRecord {
  const samples = toSamples(records);
  if (!records.length) return emptyTrackRecord(MINIMUM_TRACK_SAMPLE);
  const report = evaluate(samples);
  const independent = report.nonOverlapping;
  const pending = records.filter((record) => record.status === 'pending').length;
  const unresolvable = records.filter((record) => record.status === 'unresolvable').length;
  const pctOf = (value: number | null) => value == null ? null : Math.round(value * 100);
  return {
    resolved: samples.length,
    pending,
    unresolvable,
    hitRate: pctOf(report.all.accuracy),
    nonOverlapping: {
      n: independent.n,
      hitRate: pctOf(independent.accuracy),
      ci95: independent.accuracyCi95,
      alwaysNeutralHitRate: pctOf(report.baselines.alwaysNeutral.accuracy),
      majorityClassHitRate: independent.n ? Math.round(Math.max(...Object.values(independent.actualDistribution)) / independent.n * 100) : null,
      balancedAccuracy: independent.balancedAccuracy
    },
    minimumSample: MINIMUM_TRACK_SAMPLE,
    note: independent.n < MINIMUM_TRACK_SAMPLE
      ? `Provisional: ${independent.n}/${MINIMUM_TRACK_SAMPLE} non-overlapping outcomes resolved.`
      : 'Hit rate from automatically resolved forward outcomes; overlapping windows excluded from the headline sample.'
  };
}

/**
 * Calibration is fitted on the chronologically earlier 70% of non-overlapping
 * outcomes and scored on the later 30% only. Returns insufficient_data until
 * enough outcomes exist.
 */
export function calibrationFrom(records: PredictionRecord[], score: number): CalibrationStatus {
  const independent = nonOverlapping(toSamples(records));
  if (independent.length < MINIMUM_CALIBRATION_SAMPLE) return insufficientCalibration(independent.length, MINIMUM_CALIBRATION_SAMPLE);
  const { train, test } = chronologicalSplit(independent, 0.7);
  if (test.length < 30) return insufficientCalibration(independent.length, MINIMUM_CALIBRATION_SAMPLE);
  const calibration = fitScoreCalibration(train);
  const calibratedTest = classificationReport(test.map((sample) => ({ ...sample, probabilities: applyScoreCalibration(calibration, sample.score ?? 0) })));
  const heuristicTest = classificationReport(test);
  // The bar to beat: training class frequencies forecast for every held-out window.
  const counts = { UP: 1, NEUTRAL: 1, DOWN: 1 };
  for (const sample of train) counts[sample.actual] += 1;
  const total = counts.UP + counts.NEUTRAL + counts.DOWN;
  const empirical = { UP: counts.UP / total, NEUTRAL: counts.NEUTRAL / total, DOWN: counts.DOWN / total };
  const empiricalTest = classificationReport(test.map((sample) => ({ ...sample, probabilities: empirical })));
  if (calibratedTest.brier == null || empiricalTest.brier == null || calibratedTest.brier >= empiricalTest.brier) {
    return {
      ...insufficientCalibration(independent.length, MINIMUM_CALIBRATION_SAMPLE),
      status: 'no_skill',
      brier: calibratedTest.brier,
      logLoss: calibratedTest.logLoss,
      heuristicBrier: heuristicTest.brier,
      empiricalBrier: empiricalTest.brier,
      note: `Held-out Brier ${calibratedTest.brier} did not beat the class-frequency forecast (${empiricalTest.brier}); no calibrated probability is shown.`
    };
  }
  const live = applyScoreCalibration(calibration, score);
  const bullish = Math.round(live.UP * 100);
  const bearish = Math.round(live.DOWN * 100);
  return {
    status: 'calibrated',
    method: 'Score-bin frequencies fitted on chronologically earlier outcomes',
    sampleSize: independent.length,
    required: MINIMUM_CALIBRATION_SAMPLE,
    calibratedProbabilities: { bullish, bearish, neutral: 100 - bullish - bearish },
    brier: calibratedTest.brier,
    logLoss: calibratedTest.logLoss,
    heuristicBrier: heuristicTest.brier,
    empiricalBrier: empiricalTest.brier,
    note: `Fitted on ${train.length} earlier outcomes, scored on ${test.length} later ones.`
  };
}

/** Attaches track record, calibration and the final research decision to each card. */
export async function attachTrackRecords(cards: MarketCard[], repo: PredictionRepository, config: ModelConfig = DEFAULT_CONFIG) {
  for (const card of cards) {
    const records = await repo.list({ market: card.slug, modelVersion: config.version });
    card.trackRecord = trackRecordFrom(records);
    if (card.verdict !== 'UNAVAILABLE') card.calibration = calibrationFrom(records, card.score);
    card.decision = researchDecision(card);
  }
}

export async function evaluationReport(repo: PredictionRepository, config: ModelConfig = DEFAULT_CONFIG) {
  const result: Record<string, { report: EvaluationReport; pending: number; unresolvable: number; legacy: number }> = {};
  for (const market of ['nifty', 'crypto'] as const) {
    const all = await repo.list({ market });
    const current = all.filter((record) => record.modelVersion === config.version);
    result[market] = {
      report: evaluate(toSamples(current)),
      pending: current.filter((record) => record.status === 'pending').length,
      unresolvable: current.filter((record) => record.status === 'unresolvable').length,
      legacy: all.filter((record) => record.status === 'legacy').length
    };
  }
  return { modelVersion: config.version, generatedAt: new Date().toISOString(), markets: result };
}
