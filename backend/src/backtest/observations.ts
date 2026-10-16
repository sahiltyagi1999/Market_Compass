import { intradayTarget, istDateKey, marketStatus, NSE_HOLIDAY_CALENDARS, sessionBounds } from '../marketSession.js';
import { DEFAULT_CONFIG, type ModelConfig } from '../modelConfig.js';
import type { Observation } from './engine.js';
import { closeAt, cryptoSnapshotAt, niftySnapshotAt, type CryptoHistory, type NiftyHistory } from './replay.js';

/**
 * One observation per closed hourly candle. Start = BTC close at t,
 * end = BTC close at t + horizon. Inputs are rebuilt from data closed by t.
 */
export function cryptoObservations(history: CryptoHistory, config: ModelConfig = DEFAULT_CONFIG): Observation[] {
  const horizon = config.horizonMinutes.crypto * 60_000;
  const observations: Observation[] = [];
  for (const candle of history.btc) {
    const at = candle.time + history.intervalMs;
    const startPrice = closeAt(history.btc, history.intervalMs, at);
    const endPrice = closeAt(history.btc, history.intervalMs, at + horizon);
    const priorPrice = closeAt(history.btc, history.intervalMs, at - horizon);
    if (startPrice == null || endPrice == null) continue;
    const snapshot = cryptoSnapshotAt(history, at);
    if (!snapshot) continue;
    observations.push({
      at,
      targetAt: at + horizon,
      snapshot,
      startPrice,
      endPrice,
      priorReturnPct: priorPrice ? ((startPrice - priorPrice) / priorPrice) * 100 : undefined
    });
  }
  return observations;
}

/**
 * NIFTY decisions at the same hourly slots the live server records
 * (UTC hour boundaries = IST hh:30), skipping the opening buffer and any slot
 * with less than the minimum intraday horizon. Targets never cross the close.
 */
export function niftyObservations(history: NiftyHistory, config: ModelConfig = DEFAULT_CONFIG): Observation[] {
  const observations: Observation[] = [];
  const interval = history.intervalMs;
  const days = [...new Set(history.nifty.map((candle) => istDateKey(candle.time)))];
  for (const day of days) {
    const { open } = sessionBounds(day);
    for (let at = Math.ceil((open + 15 * 60_000) / 3_600_000) * 3_600_000; ; at += 3_600_000) {
      const status = marketStatus(at);
      if (!status.open || istDateKey(at) !== day) break;
      const target = intradayTarget(at, config.horizonMinutes.nifty, config.minIntradayHorizonMinutes, NSE_HOLIDAY_CALENDARS, false);
      if (!target.ok) break;
      const startPrice = closeAt(history.nifty, interval, at);
      const endPrice = closeAt(history.nifty, interval, target.targetAt);
      if (startPrice == null || endPrice == null) continue;
      const snapshot = niftySnapshotAt(history, at);
      if (!snapshot) continue;
      const priorAt = Math.max(open + interval, at - 60 * 60_000);
      const priorPrice = closeAt(history.nifty, interval, priorAt);
      observations.push({
        at,
        targetAt: target.targetAt,
        snapshot,
        startPrice,
        endPrice,
        priorReturnPct: priorPrice && priorAt < at ? ((startPrice - priorPrice) / priorPrice) * 100 : undefined
      });
    }
  }
  return observations;
}
