import { DEFAULT_CONFIG, MODEL_VERSION } from './modelConfig.js';
import { livePriceLookup } from './priceHistory.js';
import { attachTrackRecords, recordPredictions, resolveDuePredictions } from './predictionService.js';
import { buildCards, clearProviderCache } from './providers.js';
import { getRepository } from './storage.js';
import type { DashboardResponse } from './types.js';

export const REFRESH_MINUTES = 15;
const CYCLE_MS = REFRESH_MINUTES * 60 * 1000;
// Small delay after each slot boundary so the latest candle has closed upstream.
const SLOT_DELAY_MS = 5_000;
const EVALUATION_INTERVAL_MS = 5 * 60 * 1000;

let latest: DashboardResponse | null = null;
let latestSlot = 0;
let building: Promise<DashboardResponse> | null = null;
let evaluating: Promise<unknown> | null = null;

// Slots are aligned to the clock (:00, :15, :30, :45). IST is UTC+5:30, so the
// same boundaries are quarter-hours in India too.
export function slotStart(time: number) {
  return Math.floor(time / CYCLE_MS) * CYCLE_MS;
}

/** Evaluation job: resolves due predictions against candle prices at their target times. */
export function runEvaluation() {
  if (evaluating) return evaluating;
  evaluating = (async () => {
    const repo = await getRepository();
    const summary = await resolveDuePredictions(repo, livePriceLookup);
    if (summary.resolved || summary.unresolvable) console.log('Prediction evaluation:', summary);
    return summary;
  })().catch((error) => {
    console.error('Prediction evaluation failed:', error);
  }).finally(() => {
    evaluating = null;
  });
  return evaluating;
}

function rebuild() {
  if (building) return building;
  const slot = slotStart(Date.now());
  building = (async () => {
    clearProviderCache();
    const now = Date.now();
    const cards = await buildCards(now, DEFAULT_CONFIG);
    const repo = await getRepository();
    // Generation job: at most one prediction per market per hourly slot (unique id).
    try {
      const recorded = await recordPredictions(cards, repo, now, DEFAULT_CONFIG);
      for (const result of recorded) if (result.status === 'recorded') console.log(`Recorded ${result.id}`);
    } catch (error) {
      console.error('Prediction recording failed:', error);
    }
    await runEvaluation();
    try {
      await attachTrackRecords(cards, repo, DEFAULT_CONFIG);
    } catch (error) {
      console.error('Track record lookup failed:', error);
    }
    latest = {
      generatedAt: new Date(now).toISOString(),
      nextUpdateAt: new Date(slot + CYCLE_MS + SLOT_DELAY_MS).toISOString(),
      refreshMinutes: REFRESH_MINUTES,
      modelVersion: MODEL_VERSION,
      cards,
      storage: repo.info,
      notes: [
        'Directional score and signal quality are heuristic and uncalibrated. Calibrated probabilities appear only after enough resolved, non-overlapping outcomes.',
        'Signals are research aids, not financial advice; no model can guarantee market direction.'
      ]
    };
    latestSlot = slot;
    return latest;
  })().finally(() => {
    building = null;
  });
  return building;
}

// Returns the prediction for the current 15-minute slot. Every viewer gets the
// same locked snapshot; a new one is built only when the slot changes (for
// example after the server wakes from sleep and missed its timer).
export async function getDashboard() {
  if (latest && latestSlot === slotStart(Date.now())) return latest;
  try {
    return await rebuild();
  } catch (error) {
    if (latest) {
      console.error('Scheduled rebuild failed; serving previous snapshot:', error);
      return latest;
    }
    throw error;
  }
}

export interface SnapshotStatus {
  generatedAt: string | null;
  nextUpdateAt: string | null;
  ageSeconds: number | null;
  /** True when the snapshot belongs to the current 15-minute slot. */
  current: boolean;
  refreshing: boolean;
}

export function snapshotStatus(now = Date.now()): SnapshotStatus {
  return {
    generatedAt: latest?.generatedAt ?? null,
    nextUpdateAt: latest?.nextUpdateAt ?? null,
    ageSeconds: latest ? Math.round((now - Date.parse(latest.generatedAt)) / 1000) : null,
    current: Boolean(latest && latestSlot === slotStart(now)),
    refreshing: Boolean(building)
  };
}

/**
 * Starts a rebuild in the background when the current slot has no snapshot
 * (e.g. the host slept through a timer). Never waits on market providers, so
 * keep-alive pings stay fast. Returns true when a refresh was started.
 */
export function refreshIfStale(now = Date.now()) {
  if ((latest && latestSlot === slotStart(now)) || building) return false;
  getDashboard().catch((error) => console.error('Keep-alive refresh failed:', error));
  return true;
}

export function startDashboardSchedule() {
  const scheduleNext = () => {
    const delay = slotStart(Date.now()) + CYCLE_MS + SLOT_DELAY_MS - Date.now();
    setTimeout(() => {
      // getDashboard skips the build if a request already built this slot.
      getDashboard()
        .catch((error) => console.error('Scheduled dashboard build failed:', error))
        .finally(scheduleNext);
    }, delay);
  };
  rebuild().catch((error) => console.error('Initial dashboard build failed:', error));
  scheduleNext();
  setInterval(() => void runEvaluation(), EVALUATION_INTERVAL_MS);
}
