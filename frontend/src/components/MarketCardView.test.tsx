import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MarketCard } from '../types';
import { MarketCardView } from './MarketCardView';

function card(overrides: Partial<MarketCard> = {}): MarketCard {
  return {
    slug: 'crypto',
    title: 'Crypto Research Desk',
    subtitle: '',
    availability: 'live',
    verdict: 'BULLISH',
    headline: '',
    summary: '',
    horizon: 'Next 6 hours',
    horizonMinutes: 360,
    lastUpdated: '2026-10-10T10:00:00.000Z',
    confidence: 70,
    signalQuality: { score: 70, label: 'Signal quality (uncalibrated)', coverage: 0.9, agreement: 0.67, strength: 42, riskAdjustment: 2, note: '' },
    score: 42,
    probabilities: { bullish: 60, neutral: 30, bearish: 10 },
    probabilityKind: 'heuristic_uncalibrated',
    calibration: {
      status: 'insufficient_data',
      method: '',
      sampleSize: 12,
      required: 150,
      calibratedProbabilities: null,
      brier: null,
      logLoss: null,
      heuristicBrier: null,
      empiricalBrier: null,
      note: ''
    },
    priceLabel: 'BTC',
    price: 80_000,
    priceChangePct: 1.2,
    metrics: [],
    analysts: [
      { key: 'technical', name: 'Technical Analyst', score: 50, confidence: 90, stance: 'BULLISH', summary: '', effectiveWeightPct: 60, contribution: 30, inputs: 5 },
      { key: 'risk', name: 'Risk Manager', score: 40, confidence: 80, stance: 'BULLISH', summary: '', effectiveWeightPct: 0, contribution: 0, inputs: 2 }
    ],
    evidence: [
      { key: 'ema', label: 'BTC EMA 12/26 (1h)', value: '+0.60%', score: 0.5, weight: 12, contribution: 6.2, reason: '', role: 'direction', analyst: 'technical' },
      { key: 'volatility', label: 'Hourly realised volatility', value: '0.70%', score: 0.4, weight: 0, contribution: 0, reason: '', role: 'risk', analyst: 'risk' },
      { key: 'dominance', label: 'BTC dominance', value: '59.1%', score: 0, weight: 0, contribution: 0, reason: '', role: 'context' }
    ],
    headlines: [],
    aiAnalysis: null,
    bullCase: [],
    bearCase: [],
    risks: ['Crypto trades continuously.'],
    sources: [{ name: 'Binance public tickers', status: 'live', message: 'ok', ageSeconds: 30 }],
    setup: [],
    trackRecord: {
      resolved: 40,
      pending: 3,
      unresolvable: 1,
      hitRate: 45,
      nonOverlapping: { n: 7, hitRate: 43, ci95: { low: 0.16, high: 0.75 }, alwaysNeutralHitRate: 29, majorityClassHitRate: 43, balancedAccuracy: 0.4 },
      minimumSample: 30,
      note: 'Provisional: 7/30 non-overlapping outcomes resolved.'
    },
    decision: { action: 'PAPER TRADE ONLY', copy: 'Not validated for entries yet (7/30 non-overlapping outcomes resolved).', tone: 'neutral' },
    session: { open: true, label: 'Horizon to 21:30 IST', detail: '6-hour window', targetAt: '2026-10-10T16:00:00.000Z' },
    options: null,
    breadth: null,
    derivatives: null,
    events: [],
    globalCues: [],
    institutionalFlows: null,
    modelVersion: 'research-desk-v4',
    ...overrides
  };
}

const render = (value: MarketCard) => renderToStaticMarkup(<MarketCardView card={value} refreshMinutes={15} />);

describe('MarketCardView', () => {
  it('labels signal quality and probabilities as uncalibrated when calibration is unavailable', () => {
    const html = render(card());
    expect(html).toContain('Signal quality 70/100 · uncalibrated');
    expect(html).toContain('Unavailable · 12/150 independent outcomes');
    expect(html).toContain('Heuristic split (uncalibrated)');
    expect(html).not.toContain('Brier');
  });

  it('shows the backend decision verbatim instead of recomputing one', () => {
    const html = render(card({ verdict: 'BULLISH', confidence: 88, decision: { action: 'PAPER TRADE ONLY', copy: 'server says so', tone: 'neutral' } }));
    expect(html).toContain('PAPER TRADE ONLY');
    expect(html).toContain('server says so');
    expect(html).not.toContain('BULLISH SETUP');
  });

  it('renders unavailable data without a directional call or heuristic split', () => {
    const html = render(card({
      verdict: 'UNAVAILABLE',
      availability: 'unavailable',
      price: null,
      priceChangePct: null,
      score: 0,
      confidence: 0,
      evidence: [],
      decision: { action: 'WAIT FOR DATA', copy: 'No position until grounded price data returns.', tone: 'neutral' },
      sources: [{ name: 'Upstox NIFTY quote', status: 'error', message: '401 Unauthorized' }]
    }));
    expect(html).toContain('No directional call without grounded price data.');
    expect(html).toContain('WAIT FOR DATA');
    expect(html).toContain('Not available');
    expect(html).not.toContain('Heuristic split');
    expect(html).toContain('Data warning');
    expect(html).toContain('401 Unauthorized');
  });

  it('warns about stale data and keeps risk separate from direction', () => {
    const html = render(card({ sources: [{ name: 'Binance hourly candles', status: 'stale', message: 'old', ageSeconds: 9_000 }] }));
    expect(html).toContain('stale (3 h old), excluded from scoring');
    expect(html).toContain('quality only');
    expect(html).toContain('+6.2 pts');
  });

  it('shows calibrated probabilities with their held-out score once available', () => {
    const html = render(card({
      calibration: {
        status: 'calibrated',
        method: '',
        sampleSize: 200,
        required: 150,
        calibratedProbabilities: { bullish: 41, neutral: 33, bearish: 26 },
        brier: 0.61,
        logLoss: 1.02,
        heuristicBrier: 0.74,
        empiricalBrier: 0.65,
        note: ''
      }
    }));
    expect(html).toContain('↑ 41% · – 33% · ↓ 26%');
    expect(html).toContain('Held-out Brier 0.61 vs class-frequency 0.65');
  });

  it('hides calibrated probabilities that do not beat the class-frequency forecast', () => {
    const html = render(card({
      calibration: { status: 'no_skill', method: '', sampleSize: 200, required: 150, calibratedProbabilities: null, brier: 0.663, logLoss: 1.09, heuristicBrier: 0.86, empiricalBrier: 0.65, note: '' }
    }));
    expect(html).toContain('no skill vs class frequencies (Brier 0.663 vs 0.65)');
    expect(html).not.toContain('class="calibrated"');
  });

  it('shows the independent sample size and interval in the track record', () => {
    const html = render(card());
    expect(html).toContain('7 independent outcomes · hit rate 43% (95% CI 16–75%) · always-neutral 29%');
  });
});
