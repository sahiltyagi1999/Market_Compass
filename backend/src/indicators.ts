import type { Candle, TechnicalSnapshot } from './types.js';

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function emaSeries(values: number[], period: number) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const output = Array(period - 1).fill(Number.NaN) as number[];
  let current = mean(values.slice(0, period));
  output.push(current);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output.push(current);
  }
  return output;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - (100 / (1 + averageGain / averageLoss));
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return undefined;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function calculateTechnicals(input: Candle[]): TechnicalSnapshot {
  const candles = [...input].sort((left, right) => left.time - right.time);
  const closes = candles.map((candle) => candle.close).filter(Number.isFinite);
  const empty: TechnicalSnapshot = { candleCount: closes.length };
  if (closes.length < 15) return empty;

  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const emaFast = fast.at(-1);
  const emaSlow = slow.at(-1);
  const macdValues = closes
    .map((_, index) => Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : Number.NaN)
    .filter(Number.isFinite);
  const signalValues = emaSeries(macdValues, 9);
  const macd = macdValues.at(-1);
  const signal = signalValues.at(-1);
  const latest = closes.at(-1)!;
  const momentumLookback = Math.min(12, closes.length - 1);
  const momentumBase = closes[closes.length - 1 - momentumLookback];
  const recentCloses = closes.slice(-25);
  const returns = recentCloses.slice(1).map((close, index) => {
    const previous = recentCloses[index];
    return previous ? ((close - previous) / previous) * 100 : 0;
  });

  return {
    rsi: rsi(closes),
    emaFast,
    emaSlow,
    emaSpreadPct: emaFast != null && emaSlow ? ((emaFast - emaSlow) / emaSlow) * 100 : undefined,
    macdHistogramPct: macd != null && signal != null && latest ? ((macd - signal) / latest) * 100 : undefined,
    recentMomentumPct: momentumBase ? ((latest - momentumBase) / momentumBase) * 100 : undefined,
    volatilityPct: standardDeviation(returns),
    candleCount: closes.length
  };
}
