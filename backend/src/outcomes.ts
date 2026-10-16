import type { OutcomeThresholds } from './modelConfig.js';

export type OutcomeClass = 'UP' | 'DOWN' | 'NEUTRAL';
export type PredictedClass = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export const OUTCOME_CLASSES: OutcomeClass[] = ['UP', 'NEUTRAL', 'DOWN'];

/**
 * Mutually exclusive outcome labels:
 *   UP      return >  +upPct
 *   DOWN    return <  -downPct
 *   NEUTRAL otherwise (boundaries inclusive)
 */
export function classifyOutcome(returnPct: number, thresholds: OutcomeThresholds): OutcomeClass {
  if (!Number.isFinite(returnPct)) throw new Error('Outcome return must be a finite number.');
  if (returnPct > thresholds.upPct) return 'UP';
  if (returnPct < -thresholds.downPct) return 'DOWN';
  return 'NEUTRAL';
}

export function expectedOutcome(predicted: PredictedClass): OutcomeClass {
  if (predicted === 'BULLISH') return 'UP';
  if (predicted === 'BEARISH') return 'DOWN';
  return 'NEUTRAL';
}

export function isCorrect(predicted: PredictedClass, actual: OutcomeClass) {
  return expectedOutcome(predicted) === actual;
}

export function returnPct(startPrice: number, endPrice: number) {
  if (!(startPrice > 0) || !Number.isFinite(endPrice)) throw new Error('Prices must be positive and finite.');
  return ((endPrice - startPrice) / startPrice) * 100;
}
