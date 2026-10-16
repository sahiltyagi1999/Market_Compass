import { toNumber } from './http.js';
import { istTime, SESSION_CLOSE_MINUTES } from './marketSession.js';
import type { OptionsDetail, OptionZone, Tone } from './types.js';

/** Raw per-strike row from Upstox GET /v2/option/chain. */
export interface UpstoxChainRow {
  expiry?: string;
  strike_price?: number;
  underlying_spot_price?: number;
  call_options?: UpstoxLeg;
  put_options?: UpstoxLeg;
}

interface UpstoxLeg {
  market_data?: { ltp?: number; volume?: number; oi?: number; close_price?: number; bid_price?: number; ask_price?: number; prev_oi?: number };
  option_greeks?: { iv?: number; delta?: number; theta?: number };
}

interface Leg {
  ltp?: number;
  close?: number;
  oi?: number;
  prevOi?: number;
  volume?: number;
  bid?: number;
  ask?: number;
  iv?: number;
  delta?: number;
  theta?: number;
}

interface Strike {
  strike: number;
  call: Leg;
  put: Leg;
}

export interface ChainAnalysis {
  detail: OptionsDetail;
  spot?: number;
  atmSpreadPercent?: number;
  callOiChangePercent?: number;
  putOiChangePercent?: number;
  /** Rows dropped by validation (bad strike, other expiry, duplicates). */
  rejectedRows: number;
}

function leg(raw?: UpstoxLeg): Leg {
  const market = raw?.market_data;
  const positive = (value: unknown) => {
    const parsed = toNumber(value);
    return parsed != null && parsed >= 0 ? parsed : undefined;
  };
  return {
    ltp: positive(market?.ltp),
    close: positive(market?.close_price),
    oi: positive(market?.oi),
    prevOi: positive(market?.prev_oi),
    volume: positive(market?.volume),
    bid: positive(market?.bid_price),
    ask: positive(market?.ask_price),
    // Upstox reports IV 0 for illiquid strikes; treat 0 as missing, not as a genuine zero.
    iv: (() => { const value = positive(raw?.option_greeks?.iv); return value ? value : undefined; })(),
    delta: toNumber(raw?.option_greeks?.delta),
    theta: toNumber(raw?.option_greeks?.theta)
  };
}

export function spreadPercent(bid?: number, ask?: number) {
  if (!bid || !ask || ask < bid) return undefined;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? ((ask - bid) / midpoint) * 100 : undefined;
}

const average = (values: Array<number | undefined>) => {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : undefined;
};

type FlowLabel =
  | 'Call writing' | 'Call buying' | 'Call short covering' | 'Call long unwinding'
  | 'Put writing' | 'Put buying' | 'Put short covering' | 'Put long unwinding';

/**
 * Classic OI/premium reading. Premium changes also reflect the underlying's
 * move, so this partly echoes price action; treat it as a heuristic.
 */
function classify(side: 'call' | 'put', oiChange: number, premiumChange: number): { label: FlowLabel; sign: 1 | -1 } | null {
  if (oiChange === 0 || premiumChange === 0) return null;
  const oiUp = oiChange > 0;
  const premiumUp = premiumChange > 0;
  if (side === 'call') {
    if (oiUp && !premiumUp) return { label: 'Call writing', sign: -1 };
    if (oiUp && premiumUp) return { label: 'Call buying', sign: 1 };
    if (!oiUp && premiumUp) return { label: 'Call short covering', sign: 1 };
    return { label: 'Call long unwinding', sign: -1 };
  }
  if (oiUp && !premiumUp) return { label: 'Put writing', sign: 1 };
  if (oiUp && premiumUp) return { label: 'Put buying', sign: -1 };
  if (!oiUp && premiumUp) return { label: 'Put short covering', sign: -1 };
  return { label: 'Put long unwinding', sign: 1 };
}

/** Strike where total option-writer payout at expiry is smallest. */
export function maxPain(strikes: Strike[]) {
  let best: { strike: number; pain: number } | undefined;
  for (const candidate of strikes) {
    let pain = 0;
    for (const row of strikes) {
      pain += (row.call.oi ?? 0) * Math.max(0, candidate.strike - row.strike);
      pain += (row.put.oi ?? 0) * Math.max(0, row.strike - candidate.strike);
    }
    if (!best || pain < best.pain) best = { strike: candidate.strike, pain };
  }
  return best?.strike;
}

export function analyseOptionChain(
  rows: UpstoxChainRow[],
  options: {
    expiry: string;
    now: number;
    spot?: number;
    nearbyStrikes?: number;
    zoneRangePct?: number;
    /** Underlying spot minus its previous close, used to strip the price-driven part of premium changes. */
    underlyingChange?: number;
    /** Trading days between the previous close and now (theta adjustment). */
    elapsedDays?: number;
  }
): ChainAnalysis {
  const nearbyCount = options.nearbyStrikes ?? 5;
  const zoneRange = options.zoneRangePct ?? 5;
  const seen = new Set<number>();
  const strikes: Strike[] = [];
  let rejectedRows = 0;
  let spot = options.spot;
  for (const row of rows) {
    const strike = toNumber(row.strike_price);
    if (strike == null || strike <= 0 || seen.has(strike) || (row.expiry && row.expiry !== options.expiry)) {
      rejectedRows += 1;
      continue;
    }
    seen.add(strike);
    spot = spot ?? toNumber(row.underlying_spot_price);
    strikes.push({ strike, call: leg(row.call_options), put: leg(row.put_options) });
  }
  strikes.sort((left, right) => left.strike - right.strike);

  const atmIndex = spot == null || !strikes.length
    ? -1
    : strikes.reduce((best, row, index) => Math.abs(row.strike - spot!) < Math.abs(strikes[best].strike - spot!) ? index : best, 0);
  const atm = atmIndex >= 0 ? strikes[atmIndex] : undefined;
  const nearby = atmIndex >= 0 ? strikes.slice(Math.max(0, atmIndex - nearbyCount), atmIndex + nearbyCount + 1) : [];

  const sum = (list: Strike[], side: 'call' | 'put', field: 'oi' | 'prevOi') => list.reduce((total, row) => total + (row[side][field] ?? 0), 0);
  const ratio = (put: number, call: number) => call > 0 ? Number((put / call).toFixed(3)) : null;
  const callOi = sum(strikes, 'call', 'oi');
  const putOi = sum(strikes, 'put', 'oi');
  const callPrev = sum(strikes, 'call', 'prevOi');
  const putPrev = sum(strikes, 'put', 'prevOi');
  const change = (now: number, previous: number) => previous > 0 ? ((now - previous) / previous) * 100 : undefined;

  const adjusted = options.underlyingChange != null && Number.isFinite(options.underlyingChange);
  const flows = new Map<FlowLabel, number>();
  let signed = 0;
  let total = 0;
  for (const row of nearby) {
    for (const side of ['call', 'put'] as const) {
      const data = row[side];
      if (data.oi == null || data.prevOi == null || data.ltp == null || data.close == null) continue;
      const oiChange = data.oi - data.prevOi;
      // First-order adjustment: the premium change expected from the underlying move (delta)
      // and time decay (theta) is removed, so only the unexplained part signals demand.
      const expected = adjusted && data.delta != null
        ? data.delta * options.underlyingChange! + (data.theta ?? 0) * (options.elapsedDays ?? 1)
        : 0;
      if (adjusted && data.delta == null) continue;
      const kind = classify(side, oiChange, data.ltp - data.close - expected);
      if (!kind) continue;
      const size = Math.abs(oiChange);
      flows.set(kind.label, (flows.get(kind.label) ?? 0) + size);
      signed += kind.sign * size;
      total += size;
    }
  }
  const leanOf = (label: FlowLabel): Tone => ['Call buying', 'Call short covering', 'Put writing', 'Put long unwinding'].includes(label) ? 'positive' : 'negative';

  const zones = (side: 'call' | 'put'): OptionZone[] => {
    if (spot == null) return [];
    return strikes
      .filter((row) => (side === 'put' ? row.strike <= spot! : row.strike >= spot!) && Math.abs(row.strike - spot!) / spot! * 100 <= zoneRange)
      .filter((row) => (row[side].oi ?? 0) > 0)
      .sort((left, right) => (right[side].oi ?? 0) - (left[side].oi ?? 0))
      .slice(0, 3)
      .map((row) => ({
        strike: row.strike,
        oi: row[side].oi ?? 0,
        oiChange: (row[side].oi ?? 0) - (row[side].prevOi ?? row[side].oi ?? 0),
        distancePct: Number((((row.strike - spot!) / spot!) * 100).toFixed(2))
      }));
  };

  const skewWindow = atmIndex >= 0 ? strikes.slice(Math.max(0, atmIndex - 2), atmIndex + 3) : [];
  const putIv = average(skewWindow.map((row) => row.put.iv));
  const callIv = average(skewWindow.map((row) => row.call.iv));
  const expiryClose = istTime(options.expiry, SESSION_CLOSE_MINUTES);
  const daysToExpiry = Number.isFinite(expiryClose) ? Number(Math.max(0, (expiryClose - options.now) / 86_400_000).toFixed(2)) : null;

  return {
    detail: {
      expiry: options.expiry,
      daysToExpiry,
      atmStrike: atm?.strike ?? null,
      strikesUsed: nearbyCount,
      nearbyPcr: ratio(sum(nearby, 'put', 'oi'), sum(nearby, 'call', 'oi')),
      totalPcr: ratio(putOi, callOi),
      oiFlow: total > 0 ? Number((signed / total).toFixed(3)) : null,
      flowAdjusted: adjusted,
      flowBreakdown: [...flows.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([label, contracts]) => ({ label, contracts, lean: leanOf(label) })),
      supportZones: zones('put'),
      resistanceZones: zones('call'),
      maxPain: maxPain(strikes) ?? null,
      ivSkew: putIv != null && callIv != null ? Number((putIv - callIv).toFixed(2)) : null,
      atmIv: atm ? average([atm.call.iv, atm.put.iv]) ?? null : null
    },
    spot,
    atmSpreadPercent: atm ? average([spreadPercent(atm.call.bid, atm.call.ask), spreadPercent(atm.put.bid, atm.put.ask)]) : undefined,
    callOiChangePercent: change(callOi, callPrev),
    putOiChangePercent: change(putOi, putPrev),
    rejectedRows
  };
}
