import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichNewsWithAi } from './aiNews.js';
import { calculateTechnicals } from './indicators.js';
import { analyseHeadlines, scoreHeadline } from './sentiment.js';

describe('research inputs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('scores clearly positive and negative finance headlines in opposite directions', () => {
    expect(scoreHeadline('Bitcoin surges after strong inflows')).toBeGreaterThan(0);
    expect(scoreHeadline('Crypto exchange hacked as market plunges')).toBeLessThan(0);
    expect(scoreHeadline('Nifty bears gain momentum as India VIX rises')).toBeLessThan(0);
  });

  it('uses headline count and source diversity for sentiment confidence', () => {
    const report = analyseHeadlines([
      { title: 'Nifty gains on rate cut optimism', source: 'Source A', url: 'https://example.com/a', publishedAt: '2026-09-10T05:00:00Z' },
      { title: 'India VIX falls as markets rally', source: 'Source B', url: 'https://example.com/b', publishedAt: '2026-09-10T06:00:00Z' }
    ], new Date('2026-09-10T07:00:00Z').getTime());

    expect(report.score).toBeGreaterThan(0);
    expect(report.confidence).toBeGreaterThan(0);
    expect(report.positive).toBe(2);
  });

  it('preserves deterministic sentiment when the optional OpenAI key is absent', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const report = analyseHeadlines([
      { title: 'Nifty gains on rate cut optimism', source: 'Source A', url: 'https://example.com/a', publishedAt: '2026-09-10T05:00:00Z' }
    ], new Date('2026-09-10T07:00:00Z').getTime());

    const enriched = await enrichNewsWithAi('nifty', report, { spot: 25_000 });

    expect(enriched.sentiment).toBe(report);
    expect(enriched.analysis).toBeUndefined();
    expect(enriched.source.status).toBe('missing');
    expect(enriched.source.optional).toBe(true);
  });

  it('detects a rising EMA and RSI regime from candles', () => {
    const candles = Array.from({ length: 80 }, (_, index) => ({
      time: index * 3_600_000,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 1_000 + index
    }));
    const technical = calculateTechnicals(candles);

    expect(technical.emaSpreadPct).toBeGreaterThan(0);
    expect(technical.rsi).toBeGreaterThan(50);
    expect(technical.candleCount).toBe(80);
  });
});
