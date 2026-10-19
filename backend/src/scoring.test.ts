import { describe, expect, it } from 'vitest';
import { scoreCrypto, scoreNifty } from './scoring.js';

describe('dashboard scoring', () => {
  it('marks nifty bullish when price action is strong (PCR and aggregate OI skew are context only)', () => {
    const report = scoreNifty({
      spot: 25240,
      previousClose: 24980,
      vix: 13.2,
      vixPreviousClose: 14.3,
      pcr: 1.12,
      putOiChangePercent: 11,
      callOiChangePercent: 2.5,
      atmIv: 14.8,
      atmSpreadPercent: 0.7,
      updatedAt: '2026-09-10T09:30:00.000Z'
    }, [
      { name: 'quote', status: 'live', message: 'ok' },
      { name: 'vix', status: 'live', message: 'ok' },
      { name: 'chain', status: 'live', message: 'ok' }
    ]);

    expect(report.verdict).toBe('BULLISH');
    expect(report.probabilities.bullish).toBeGreaterThan(report.probabilities.neutral);
    expect(report.availability).toBe('live');
    expect(report.priceChangePct).toBeGreaterThan(0);
  });

  it('marks nifty unavailable when no live evidence exists', () => {
    const report = scoreNifty({}, [
      { name: 'quote', status: 'missing', message: 'no token' },
      { name: 'chain', status: 'missing', message: 'no token' }
    ]);

    expect(report.verdict).toBe('UNAVAILABLE');
    expect(report.availability).toBe('unavailable');
    expect(report.evidence).toHaveLength(0);
  });

  it('marks crypto bearish when btc, eth, market cap and breadth all weaken', () => {
    const report = scoreCrypto({
      btcPrice: 78000,
      btcChangePct: -2.8,
      ethPrice: 2450,
      ethChangePct: -4.2,
      marketCapChangePct: -3.3,
      btcDominance: 60.8,
      breadthPositiveRatio: 0.2,
      btcSpreadPercent: 0.01,
      ethSpreadPercent: 0.02,
      updatedAt: '2026-09-10T09:30:00.000Z'
    }, [
      { name: 'binance', status: 'live', message: 'ok' },
      { name: 'global', status: 'live', message: 'ok' },
      { name: 'breadth', status: 'live', message: 'ok' }
    ]);

    expect(report.verdict).toBe('BEARISH');
    expect(report.probabilities.bearish).toBeGreaterThan(report.probabilities.neutral);
    expect(report.confidence).toBeGreaterThan(0);
    expect(report.metrics.length).toBeGreaterThanOrEqual(3);
  });

  it('downgrades availability when only part of crypto data is present', () => {
    const report = scoreCrypto({
      btcPrice: 78000,
      btcChangePct: 1.2
    }, [
      { name: 'binance', status: 'live', message: 'ok' },
      { name: 'global', status: 'error', message: 'rate limit' }
    ]);

    expect(report.availability).toBe('partial');
    expect(report.verdict).not.toBe('UNAVAILABLE');
  });

  it('keeps a moderate mixed crypto score neutral instead of issuing a trade direction', () => {
    const report = scoreCrypto({
      btcPrice: 78_000,
      btcChangePct: 1.1,
      ethChangePct: 0.8,
      marketCapChangePct: 0.7,
      breadthPositiveRatio: 0.6,
      fearGreed: 58,
      btcSpreadPercent: 0.01
    }, [{ name: 'market data', status: 'live', message: 'ok' }]);

    expect(report.score).toBeGreaterThan(0);
    expect(report.verdict).toBe('NEUTRAL');
  });

  it('does not let optional AI sentiment change the directional score', () => {
    const base = {
      btcPrice: 78_000,
      btcChangePct: 0.4,
      ethChangePct: -0.2,
      breadthPositiveRatio: 0.5,
      fearGreed: 50,
      sentiment: {
        score: 90,
        deterministicScore: -20,
        aiScore: 90,
        method: 'ai_blend' as const,
        confidence: 70,
        positive: 4,
        negative: 4,
        neutral: 0,
        headlines: []
      }
    };
    const sources = [{ name: 'market data', status: 'live' as const, message: 'ok' }];
    const withAi = scoreCrypto(base, sources);
    const withoutAi = scoreCrypto({
      ...base,
      sentiment: { ...base.sentiment, score: -20, method: 'deterministic' as const }
    }, sources);

    expect(withAi.score).toBe(withoutAi.score);
  });

  it('does not let inconsistent global market-cap windows change the directional score', () => {
    const base = {
      btcPrice: 78_000,
      btcChangePct: 0.2,
      ethChangePct: 0.1,
      breadthPositiveRatio: 0.5,
      btcDominance: 57,
      fearGreed: 50
    };
    const sources = [{ name: 'market data', status: 'live' as const, message: 'ok' }];

    const positiveWindow = scoreCrypto({ ...base, marketCapChangePct: 3 }, sources);
    const negativeWindow = scoreCrypto({ ...base, marketCapChangePct: -3 }, sources);

    expect(positiveWindow.score).toBe(negativeWindow.score);
  });
});

import { DEFAULT_CONFIG } from './modelConfig.js';
import { heuristicProbabilities, scaled, signalQuality } from './scoring.js';
import type { CryptoSnapshot, NiftySnapshot, SourceStatus } from './types.js';

const live: SourceStatus[] = [{ name: 'market data', status: 'live', message: 'ok' }];
const fullCrypto: CryptoSnapshot = {
  btcPrice: 80_000,
  btcChangePct: 2.1,
  ethChangePct: 3.4,
  breadthPositiveRatio: 0.8,
  btcSpreadPercent: 0.01,
  ethSpreadPercent: 0.02,
  fearGreed: 66,
  technical: { rsi: 63, emaSpreadPct: 0.6, macdHistogramPct: 0.08, recentMomentumPct: 1.4, volatilityPct: 0.7, candleCount: 150, sessionCandleCount: 150 }
};

describe('scoring invariants', () => {
  it('treats missing, non-finite or invalid-range inputs as missing, never as a signal', () => {
    expect(scaled(undefined, 1)).toBeUndefined();
    expect(scaled(Number.NaN, 1)).toBeUndefined();
    expect(scaled(Number.POSITIVE_INFINITY, 1)).toBeUndefined();
    expect(scaled(1, 0)).toBeUndefined();
    expect(scaled(1, -2)).toBeUndefined();
    expect(scaled(5, 2)).toBe(1);
    expect(scaled(-0.5, 1)).toBe(-0.5);
  });

  it('keeps signal quality within [28, 89] for extreme components', () => {
    expect(signalQuality({ coverage: 5, agreement: 5, score: 1000, riskAdjustment: 100 })).toBe(89);
    expect(signalQuality({ coverage: -5, agreement: -5, score: 0, riskAdjustment: -100 })).toBe(28);
    expect(signalQuality({ coverage: Number.NaN, agreement: 0, score: 0, riskAdjustment: 0 })).toBe(28);
  });

  it('produces bounded heuristic probabilities that sum to 100', () => {
    for (const score of [-100, -45, -1, 0, 1, 30, 100]) {
      for (const confidence of [0, 28, 60, 89]) {
        const p = heuristicProbabilities(score, confidence, false);
        expect(p.bullish + p.neutral + p.bearish).toBe(100);
        expect(Math.min(p.bullish, p.neutral, p.bearish)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(heuristicProbabilities(Number.NaN, 50, false)).toEqual({ bullish: 0, neutral: 100, bearish: 0 });
  });

  it('makes direction contributions sum to the final score', () => {
    const report = scoreCrypto(fullCrypto, live);
    const direction = report.evidence.filter((item) => item.role === 'direction');
    const total = direction.reduce((sum, item) => sum + item.contribution, 0);
    expect(Math.abs(total - report.score)).toBeLessThanOrEqual(1);
    const analystTotal = report.analysts.reduce((sum, item) => sum + item.contribution, 0);
    expect(Math.abs(analystTotal - report.score)).toBeLessThanOrEqual(1);
    expect(report.evidence.filter((item) => item.role !== 'direction').every((item) => item.contribution === 0)).toBe(true);
  });

  it('never lets the zero-weight risk analyst move the directional score', () => {
    const calm = scoreCrypto(fullCrypto, live);
    const stressed = scoreCrypto({ ...fullCrypto, btcSpreadPercent: 2, ethSpreadPercent: 2, technical: { ...fullCrypto.technical!, volatilityPct: 9 } }, live);
    expect(stressed.score).toBe(calm.score);
    expect(stressed.confidence).toBeLessThan(calm.confidence);
    expect(stressed.analysts.find((item) => item.key === 'risk')!.effectiveWeightPct).toBe(0);
  });

  it('excludes analysts without data from the weighted aggregate', () => {
    const technicalOnly = scoreCrypto({ btcPrice: 80_000, technical: fullCrypto.technical }, live);
    const technical = technicalOnly.analysts.find((item) => item.key === 'technical')!;
    expect(technical.effectiveWeightPct).toBe(100);
    expect(technicalOnly.analysts.filter((item) => item.key !== 'technical').every((item) => item.effectiveWeightPct === 0)).toBe(true);
    expect(technicalOnly.score).toBe(technical.score);
  });

  it('does not score the local mood proxy (it would double count)', () => {
    const withProxy = scoreCrypto({ ...fullCrypto, fearGreed: 95, fearGreedIsProxy: true }, live);
    const withoutGauge = scoreCrypto({ ...fullCrypto, fearGreed: undefined }, live);
    expect(withProxy.score).toBe(withoutGauge.score);
    expect(withProxy.evidence.find((item) => item.key === 'mood-proxy')?.role).toBe('context');
  });

  it('treats BTC dominance as context: falling dominance is not automatically bullish', () => {
    const high = scoreCrypto({ ...fullCrypto, btcDominance: 65 }, live);
    const low = scoreCrypto({ ...fullCrypto, btcDominance: 45 }, live);
    expect(high.score).toBe(low.score);
    const falling = scoreCrypto({ ...fullCrypto, btcChangePct: -3, ethChangePct: -5, basketAverageChangePct: -4, btcDominance: 60 }, live);
    expect(falling.evidence.find((item) => item.key === 'dominance')?.reason).toContain('defensive');
  });

  it('keeps PCR, max pain and aggregate OI skew out of the NIFTY score', () => {
    const base: NiftySnapshot = { spot: 25_000, previousClose: 24_900 };
    const bullishContext = scoreNifty({ ...base, pcr: 1.6, maxPain: 26_000, putOiChangePercent: 30, callOiChangePercent: 0 }, live);
    const bearishContext = scoreNifty({ ...base, pcr: 0.5, maxPain: 24_000, putOiChangePercent: 0, callOiChangePercent: 30 }, live);
    expect(bullishContext.score).toBe(bearishContext.score);
    expect(bullishContext.evidence.find((item) => item.key === 'pcr')?.role).toBe('context');
  });

  it('does not raise the NIFTY direction when volatility falls', () => {
    const base: NiftySnapshot = { spot: 25_000, previousClose: 24_950 };
    const fallingVix = scoreNifty({ ...base, vix: 11, vixPreviousClose: 14, atmIv: 10 }, live);
    const risingVix = scoreNifty({ ...base, vix: 18, vixPreviousClose: 14, atmIv: 25 }, live);
    expect(fallingVix.score).toBe(risingVix.score);
    expect(fallingVix.confidence).toBeGreaterThan(risingVix.confidence);
  });

  it('honours disabled features (used by ablation)', () => {
    const full = scoreCrypto(fullCrypto, live);
    const ablated = scoreCrypto(fullCrypto, live, { config: { ...DEFAULT_CONFIG, disabledFeatures: ['breadth'] } });
    expect(ablated.evidence.some((item) => item.key === 'breadth')).toBe(false);
    expect(ablated.analysts.find((item) => item.key === 'positioning')!.confidence).toBe(0);
    expect(ablated.score).not.toBe(full.score);
  });

  it('returns UNAVAILABLE with a neutral distribution when only news exists', () => {
    const report = scoreNifty({
      sentiment: { score: 80, deterministicScore: 80, method: 'deterministic', confidence: 70, positive: 5, negative: 0, neutral: 0, headlines: [] }
    }, live);
    expect(report.verdict).toBe('UNAVAILABLE');
    expect(report.score).toBe(0);
    expect(report.probabilities).toEqual({ bullish: 0, neutral: 100, bearish: 0 });
    expect(report.probabilityKind).toBe('heuristic_uncalibrated');
    expect(report.calibration.calibratedProbabilities).toBeNull();
    expect(report.decision.action).toBe('WAIT FOR DATA');
  });
});
