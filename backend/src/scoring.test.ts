import { describe, expect, it } from 'vitest';
import { scoreCrypto, scoreNifty } from './scoring.js';

describe('dashboard scoring', () => {
  it('marks nifty bullish when spot, vix, pcr and oi skew align', () => {
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
    expect(report.metrics.length).toBeGreaterThan(3);
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
