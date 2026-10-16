import type { MarketCard, ResearchDecision } from './types.js';

/** Minimum signal quality before a directional setup is shown. */
export const MIN_SIGNAL_QUALITY = 55;

/**
 * Research posture, decided once on the server so the UI never recomputes a
 * different answer. A directional setup is only shown when the measured,
 * non-overlapping track record beats both chance and the always-neutral
 * baseline at the lower bound of its 95% interval.
 */
export function researchDecision(card: Pick<MarketCard, 'availability' | 'verdict' | 'slug' | 'session' | 'trackRecord' | 'confidence'>): ResearchDecision {
  if (card.availability === 'unavailable' || card.verdict === 'UNAVAILABLE') {
    return { action: 'WAIT FOR DATA', copy: 'No position until grounded price data returns.', tone: 'neutral' };
  }
  if (card.slug === 'nifty' && !card.session.open) {
    return { action: 'WAIT', copy: 'Cash market is closed. No new forecast until the next session opens.', tone: 'neutral' };
  }

  const record = card.trackRecord;
  const sample = record.nonOverlapping;
  const lowerBound = sample.ci95?.low;
  // Must beat chance and every constant-class predictor (always-neutral, majority class) on the same sample.
  const baseline = Math.max(1 / 3, (sample.alwaysNeutralHitRate ?? 0) / 100, (sample.majorityClassHitRate ?? 0) / 100);
  if (sample.n < record.minimumSample || lowerBound == null || lowerBound <= baseline) {
    const reason = sample.n < record.minimumSample
      ? `${sample.n}/${record.minimumSample} non-overlapping outcomes resolved`
      : `hit-rate lower bound ${Math.round((lowerBound ?? 0) * 100)}% does not beat the ${Math.round(baseline * 100)}% baseline`;
    return { action: 'PAPER TRADE ONLY', copy: `Not validated for entries yet (${reason}).`, tone: 'neutral' };
  }

  if (card.verdict === 'NEUTRAL' || card.confidence < MIN_SIGNAL_QUALITY) {
    return { action: 'WAIT / NO TRADE', copy: 'The directional edge is not strong enough yet.', tone: 'neutral' };
  }
  const copy = 'Research direction only; confirm entry and risk independently. This is not an order instruction.';
  return card.verdict === 'BULLISH'
    ? { action: 'BULLISH SETUP', copy, tone: 'bullish' }
    : { action: 'BEARISH SETUP', copy, tone: 'bearish' };
}
