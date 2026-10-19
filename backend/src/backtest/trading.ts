import type { PredictedClass } from '../outcomes.js';

/**
 * Documented strategy simulation.
 *
 * Rules
 * - One decision per non-overlapping evaluation window (the same windows used
 *   for classification metrics). BULLISH = long, BEARISH = short, NEUTRAL or
 *   UNAVAILABLE = flat. Nothing else can open a position.
 * - Entry at the close of the decision candle (the last price the model saw),
 *   exit at the close at the window's target time. No intra-window stops.
 * - Sizing: 100% of current equity per trade, 1x, no leverage; equity
 *   compounds trade to trade. An additive (sum of % returns) figure is also
 *   reported because earlier reports used it.
 * - Costs: a flat round-trip cost in % of notional (fees + spread + slippage),
 *   charged once per trade. No funding, borrow or market-impact model.
 */
export interface StrategyWindow {
  startAt: number;
  endAt: number;
  /** Underlying return over the window, %. */
  returnPct: number;
  predicted: PredictedClass | 'UNAVAILABLE';
}

export interface TradingStats {
  windows: number;
  trades: number;
  longs: number;
  shorts: number;
  winRate: number | null;
  averageWinPct: number | null;
  averageLossPct: number | null;
  profitFactor: number | null;
  /** Compounded equity change over the period, %. */
  compoundedReturnPct: number;
  /** Sum of per-trade net % returns (NOT an equity return). */
  additiveReturnPct: number;
  grossCompoundedReturnPct: number;
  maxDrawdownPct: number;
  perTradeMeanPct: number | null;
  perTradeStdevPct: number | null;
  /** Share of the evaluation period with an open position. */
  exposure: number | null;
  /** Notional traded / starting capital (entry + exit legs, ignoring compounding). */
  turnover: number;
  costPerRoundTripPct: number;
  totalCostsPct: number;
}

export function positionFor(predicted: StrategyWindow['predicted']): -1 | 0 | 1 {
  if (predicted === 'BULLISH') return 1;
  if (predicted === 'BEARISH') return -1;
  return 0;
}

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

export function simulateStrategy(windows: StrategyWindow[], costPct: number): TradingStats {
  const ordered = [...windows].sort((left, right) => left.startAt - right.startAt);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].startAt < ordered[index - 1].endAt) throw new Error('Strategy windows overlap; pass non-overlapping windows only.');
  }
  let equity = 1;
  let grossEquity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let exposed = 0;
  const nets: number[] = [];
  let longs = 0;
  let shorts = 0;
  for (const window of ordered) {
    const position = positionFor(window.predicted);
    if (!position || !Number.isFinite(window.returnPct)) continue;
    if (position > 0) longs += 1;
    else shorts += 1;
    const gross = position * window.returnPct;
    const net = gross - costPct;
    nets.push(net);
    equity *= 1 + net / 100;
    grossEquity *= 1 + gross / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    exposed += window.endAt - window.startAt;
  }
  const wins = nets.filter((value) => value > 0);
  const losses = nets.filter((value) => value <= 0);
  const mean = nets.length ? nets.reduce((sum, value) => sum + value, 0) / nets.length : null;
  const stdev = nets.length > 1 && mean != null ? Math.sqrt(nets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (nets.length - 1)) : null;
  const span = ordered.length ? ordered[ordered.length - 1].endAt - ordered[0].startAt : 0;
  const lossTotal = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    windows: ordered.length,
    trades: nets.length,
    longs,
    shorts,
    winRate: nets.length ? round(wins.length / nets.length) : null,
    averageWinPct: wins.length ? round(wins.reduce((sum, value) => sum + value, 0) / wins.length) : null,
    averageLossPct: losses.length ? round(losses.reduce((sum, value) => sum + value, 0) / losses.length) : null,
    profitFactor: lossTotal > 0 ? round(wins.reduce((sum, value) => sum + value, 0) / lossTotal) : null,
    compoundedReturnPct: round((equity - 1) * 100, 3),
    additiveReturnPct: round(nets.reduce((sum, value) => sum + value, 0), 3),
    grossCompoundedReturnPct: round((grossEquity - 1) * 100, 3),
    maxDrawdownPct: round(maxDrawdown * 100, 3),
    perTradeMeanPct: mean == null ? null : round(mean),
    perTradeStdevPct: stdev == null ? null : round(stdev),
    exposure: span > 0 ? round(exposed / span) : null,
    turnover: nets.length * 2,
    costPerRoundTripPct: costPct,
    totalCostsPct: round(nets.length * costPct, 3)
  };
}

/** Passive references on the same evaluation period. */
export function benchmarks(windows: StrategyWindow[], firstPrice: number | undefined, lastPrice: number | undefined, costPct: number) {
  return {
    noTrade: simulateStrategy(windows.map((window) => ({ ...window, predicted: 'NEUTRAL' as const })), costPct),
    alwaysLongSameWindows: simulateStrategy(windows.map((window) => ({ ...window, predicted: 'BULLISH' as const })), costPct),
    /** Hold the underlying from the first window start to the last window end (includes time between windows). */
    buyAndHoldPct: firstPrice && lastPrice ? round(((lastPrice - firstPrice) / firstPrice) * 100 - costPct, 3) : null
  };
}
