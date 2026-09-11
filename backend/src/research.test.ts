import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichNewsWithAi } from './aiNews.js';
import { calculateTechnicals } from './indicators.js';
import { isCryptoHeadlineRelevant, isNiftyHeadlineRelevant, parseRssNews } from './providers.js';
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

  it('uses the deterministic fallback when the OpenAI key is incomplete', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k-proj-incomplete');
    const report = analyseHeadlines([
      { title: 'Bitcoin rises after institutional inflows', source: 'Source A', url: 'https://example.com/a', publishedAt: '2026-09-10T05:00:00Z' }
    ], new Date('2026-09-10T07:00:00Z').getTime());

    const enriched = await enrichNewsWithAi('crypto', report, { spot: 100_000 });

    expect(enriched.sentiment).toBe(report);
    expect(enriched.source.status).toBe('error');
    expect(enriched.source.message).toContain('beginning with sk-');
  });

  it('keeps only headlines relevant to each market', () => {
    expect(isNiftyHeadlineRelevant('Indian shares rise as Nifty tracks an RBI rate decision')).toBe(true);
    expect(isNiftyHeadlineRelevant('BlackRock expands its private credit team in Europe')).toBe(false);
    expect(isCryptoHeadlineRelevant('Bitcoin and Ether rebound as crypto inflows improve')).toBe(true);
    expect(isCryptoHeadlineRelevant('Financial stocks lead the broader equity market')).toBe(false);
  });

  it('parses direct RSS fallback headlines and decodes entities', () => {
    const headlines = parseRssNews(`
      <rss><channel><item>
        <title><![CDATA[Bitcoin &amp; markets rebound]]></title>
        <link>https://example.com/rebound</link>
        <pubDate>Fri, 11 Sep 2026 10:00:00 GMT</pubDate>
      </item></channel></rss>
    `, 'Fallback Desk');

    expect(headlines).toHaveLength(1);
    expect(headlines[0].title).toBe('Bitcoin & markets rebound');
    expect(headlines[0].source).toBe('Fallback Desk');
    expect(headlines[0].url).toBe('https://example.com/rebound');
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
