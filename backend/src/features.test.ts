import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderBookImbalance, percentileRank } from './cryptoData.js';
import { researchDecision } from './decision.js';
import { upcomingEvents } from './events.js';
import { clearHttpCache } from './http.js';
import { istTime } from './marketSession.js';
import { computeBreadth, fetchInstitutionalFlows, parseConstituentCsv } from './niftyData.js';
import { analyseOptionChain, maxPain, type UpstoxChainRow } from './optionsAnalysis.js';
import { parseBinanceKlines, sourceStatus } from './providers.js';
import { emptyTrackRecord } from './scoring.js';
import { closedCandles, fetchLtp } from './upstox.js';

const row = (strike: number, call: Record<string, number>, put: Record<string, number>, expiry = '2026-10-13'): UpstoxChainRow => ({
  expiry,
  strike_price: strike,
  underlying_spot_price: 25_010,
  call_options: { market_data: call, option_greeks: { iv: call.iv ?? 12 } },
  put_options: { market_data: put, option_greeks: { iv: put.iv ?? 14 } }
});

describe('strike-wise option analysis', () => {
  const now = istTime('2026-10-12', 11 * 60);

  it('classifies OI flow using premium direction, not OI alone', () => {
    // Put OI up with put premium down = put writing (+); call OI up with call premium down = call writing (-).
    const putWriting = analyseOptionChain([
      row(25_000, { oi: 100, prev_oi: 100, ltp: 50, close_price: 50 }, { oi: 1_000, prev_oi: 500, ltp: 40, close_price: 60 })
    ], { expiry: '2026-10-13', now });
    expect(putWriting.detail.oiFlow).toBe(1);
    expect(putWriting.detail.flowBreakdown[0]).toMatchObject({ label: 'Put writing', lean: 'positive' });

    // Same put OI increase but premium rising = put buying, which is bearish.
    const putBuying = analyseOptionChain([
      row(25_000, { oi: 100, prev_oi: 100, ltp: 50, close_price: 50 }, { oi: 1_000, prev_oi: 500, ltp: 80, close_price: 60 })
    ], { expiry: '2026-10-13', now });
    expect(putBuying.detail.oiFlow).toBe(-1);
  });

  it('removes the premium change explained by the underlying move before classifying', () => {
    // Spot +100 with delta 0.5 explains a +50 call premium move; OI up with exactly that move is not "call buying".
    const leg = (premiumNow: number, delta: number) => ({ market_data: { oi: 1_000, prev_oi: 500, ltp: premiumNow, close_price: 100 }, option_greeks: { iv: 12, delta, theta: 0 } });
    const rows: UpstoxChainRow[] = [{ expiry: '2026-10-13', strike_price: 25_000, underlying_spot_price: 25_010, call_options: leg(150, 0.5), put_options: leg(50, -0.5) }];
    const raw = analyseOptionChain(rows, { expiry: '2026-10-13', now });
    const adjusted = analyseOptionChain(rows, { expiry: '2026-10-13', now, underlyingChange: 100 });
    // Unadjusted, a plain rally reads as call buying + put writing: a full-strength echo of price.
    expect(raw.detail.oiFlow).toBe(1);
    expect(raw.detail.flowBreakdown.map((item) => item.label).sort()).toEqual(['Call buying', 'Put writing']);
    expect(adjusted.detail.flowAdjusted).toBe(true);
    expect(adjusted.detail.oiFlow).toBeNull();
    // A call premium that rises MORE than delta explains does read as call buying.
    const demand = analyseOptionChain([{ ...rows[0], call_options: leg(180, 0.5), put_options: undefined }], { expiry: '2026-10-13', now, underlyingChange: 100 });
    expect(demand.detail.flowBreakdown[0].label).toBe('Call buying');
  });

  it('finds ATM, nearby PCR, OI zones, IV skew and days to expiry', () => {
    const rows = [24_800, 24_900, 25_000, 25_100, 25_200].map((strike) => row(
      strike,
      { oi: strike === 25_200 ? 9_000 : 1_000, prev_oi: 900, ltp: 10, close_price: 12, bid_price: 10, ask_price: 10.2, iv: 12 },
      { oi: strike === 24_800 ? 8_000 : 2_000, prev_oi: 1_800, ltp: 10, close_price: 9, bid_price: 9.9, ask_price: 10.1, iv: 15 }
    ));
    const analysis = analyseOptionChain(rows, { expiry: '2026-10-13', now, nearbyStrikes: 1 });
    expect(analysis.detail.atmStrike).toBe(25_000);
    expect(analysis.detail.nearbyPcr).toBe(2);
    expect(analysis.detail.supportZones[0].strike).toBe(24_800);
    expect(analysis.detail.resistanceZones[0].strike).toBe(25_200);
    expect(analysis.detail.ivSkew).toBe(3);
    expect(analysis.detail.daysToExpiry).toBeCloseTo(1.19, 1);
    expect(analysis.atmSpreadPercent).toBeGreaterThan(0);
  });

  it('drops rows from other expiries, duplicates and invalid strikes', () => {
    const analysis = analyseOptionChain([
      row(25_000, { oi: 1 }, { oi: 1 }),
      row(25_000, { oi: 1 }, { oi: 1 }),
      row(25_100, { oi: 1 }, { oi: 1 }, '2026-10-20'),
      row(-5, { oi: 1 }, { oi: 1 })
    ], { expiry: '2026-10-13', now });
    expect(analysis.rejectedRows).toBe(3);
  });

  it('computes max pain from OI', () => {
    // Writer payout: K=100 -> 150, K=110 -> 100, K=120 -> 150.
    expect(maxPain([
      { strike: 100, call: { oi: 5 }, put: { oi: 0 } },
      { strike: 110, call: { oi: 5 }, put: { oi: 5 } },
      { strike: 120, call: { oi: 0 }, put: { oi: 5 } }
    ])).toBe(110);
  });
});

describe('breadth and crypto context', () => {
  it('skips missing quotes instead of counting them as unchanged', () => {
    const breadth = computeBreadth([
      { lastPrice: 105, previousClose: 100, averagePrice: 103 },
      { lastPrice: 95, previousClose: 100, averagePrice: 97 },
      { lastPrice: 100, previousClose: 100 },
      { lastPrice: undefined, previousClose: 100 }
    ], [{ name: 'Bank', changePct: 1.5 }], 0.5)!;
    expect(breadth.constituents).toBe(3);
    expect([breadth.advances, breadth.declines, breadth.unchanged]).toEqual([1, 1, 1]);
    expect(breadth.aboveVwapPct).toBe(50);
    expect(breadth.bankNiftyRelativePct).toBe(1);
    expect(computeBreadth([], [])).toBeNull();
  });

  it('parses the official constituent CSV', () => {
    const list = parseConstituentCsv('Company Name,Industry,Symbol,Series,ISIN Code\nReliance Industries Ltd.,Oil Gas,RELIANCE,EQ,INE002A01018\nBad,X,BAD,EQ,notanisin\n');
    expect(list).toEqual([{ symbol: 'RELIANCE', isin: 'INE002A01018', industry: 'Oil Gas' }]);
  });

  it('computes funding percentile and order-book imbalance', () => {
    expect(percentileRank(5, [1, 2, 3, 4, 5])).toBe(90);
    expect(percentileRank(1, [])).toBeNull();
    expect(orderBookImbalance([['100', '3']], [['100.1', '1']])).toBe(0.5);
    expect(orderBookImbalance([['100', '1']], [['99', '1']])).toBeNull();
  });
});

describe('data freshness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it('marks observations older than their limit as stale', () => {
    const now = Date.parse('2026-10-12T06:00:00Z');
    expect(sourceStatus('x', 'ok', { observedAt: now - 60_000, maxAgeSeconds: 300, now }).status).toBe('live');
    const stale = sourceStatus('x', 'ok', { observedAt: now - 3_600_000, maxAgeSeconds: 300, now });
    expect(stale.status).toBe('stale');
    expect(stale.ageSeconds).toBe(3600);
  });

  it('drops candles that have not closed yet', () => {
    const now = 10 * 60_000;
    const candles = [0, 5, 9].map((minute) => ({ time: minute * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    expect(closedCandles(candles, 5 * 60_000, now).map((candle) => candle.time)).toEqual([0, 5 * 60_000]);
    const klines = parseBinanceKlines([[0, '1', '1', '1', '1', '1', 59_999], [60_000, '1', '1', '1', '1', '1', 119_999]], 100_000);
    expect(klines).toHaveLength(1);
  });

  it('maps LTP responses back by instrument token, not by response key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { 'NSE_INDEX:Nifty 50': { last_price: 25_000, cp: 24_900, instrument_token: 'NSE_INDEX|Nifty 50' } }
    }))));
    const { quotes } = await fetchLtp('token', ['NSE_INDEX|Nifty 50']);
    expect(quotes.get('NSE_INDEX|Nifty 50')).toEqual({ price: 25_000, previousClose: 24_900 });
  });

  it('never uses same-day FII/DII figures during the session', async () => {
    const today = istTime('2026-10-12', 0);
    const yesterday = istTime('2026-10-09', 0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { 'NSE_EQ|CASH': [
        { time_stamp: today, buy_amount: 100, sell_amount: 50 },
        { time_stamp: yesterday, buy_amount: 10, sell_amount: 30 }
      ] }
    }))));
    const flows = await fetchInstitutionalFlows('token', istTime('2026-10-12', 11 * 60));
    expect(flows).toMatchObject({ date: '2026-10-09', fiiNetCr: -20, diiNetCr: -20 });
  });
});

describe('events and decisions', () => {
  it('lists upcoming official events without labelling them bullish or bearish', () => {
    const events = upcomingEvents('nifty', Date.parse('2026-10-06T00:00:00Z'), 48);
    expect(events.map((event) => event.name)).toContain('RBI MPC policy decision (time unconfirmed)');
    expect(events.every((event) => !/bullish|bearish/i.test(event.name))).toBe(true);
    expect(upcomingEvents('crypto', Date.parse('2026-10-06T00:00:00Z'), 48).some((event) => event.name.startsWith('RBI'))).toBe(false);
  });

  const card = (overrides: Partial<Parameters<typeof researchDecision>[0]> = {}) => ({
    availability: 'live' as const,
    verdict: 'BULLISH' as const,
    slug: 'crypto' as const,
    session: { open: true, label: '', detail: '', targetAt: null },
    trackRecord: emptyTrackRecord(),
    confidence: 70,
    ...overrides
  });

  it('keeps PAPER TRADE ONLY until the independent sample beats the baselines', () => {
    expect(researchDecision(card()).action).toBe('PAPER TRADE ONLY');
    const weak = { ...emptyTrackRecord(), nonOverlapping: { n: 40, hitRate: 45, ci95: { low: 0.3, high: 0.6 }, alwaysNeutralHitRate: 40, majorityClassHitRate: 40, balancedAccuracy: 0.4 } };
    expect(researchDecision(card({ trackRecord: weak })).action).toBe('PAPER TRADE ONLY');
    const strong = { ...emptyTrackRecord(), nonOverlapping: { n: 200, hitRate: 62, ci95: { low: 0.55, high: 0.69 }, alwaysNeutralHitRate: 40, majorityClassHitRate: 45, balancedAccuracy: 0.6 } };
    expect(researchDecision(card({ trackRecord: strong })).action).toBe('BULLISH SETUP');
    expect(researchDecision(card({ trackRecord: strong, confidence: 40 })).action).toBe('WAIT / NO TRADE');
    // A hit rate that only matches always predicting the majority class (here UP at 58%) is not an edge.
    const majorityOnly = { ...strong, nonOverlapping: { ...strong.nonOverlapping, majorityClassHitRate: 58 } };
    expect(researchDecision(card({ trackRecord: majorityOnly })).action).toBe('PAPER TRADE ONLY');
  });

  it('waits when data is missing or the NIFTY session is closed', () => {
    expect(researchDecision(card({ verdict: 'UNAVAILABLE' })).action).toBe('WAIT FOR DATA');
    expect(researchDecision(card({ slug: 'nifty', session: { open: false, label: 'Market closed', detail: 'Weekend', targetAt: null } })).action).toBe('WAIT');
  });
});
