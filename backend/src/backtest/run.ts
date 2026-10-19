import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { DEFAULT_CONFIG } from '../modelConfig.js';
import type { Candle } from '../types.js';
import { loadCryptoHistory, loadNiftyHistory } from './data.js';
import { runBacktest, type Observation } from './engine.js';
import { cryptoObservations, niftyObservations } from './observations.js';
import { normaliseHistory } from './replay.js';
import { reliabilitySvg, renderMarkdown, type RunMetadata } from './report.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
loadEnv({ path: join(repoRoot, '.env') });

/**
 * Reproducible usage (pin the dates so re-runs read identical data):
 *   npm run backtest -w backend -- --market crypto --start 2024-10-10 --end 2026-10-10
 *   npm run backtest -w backend -- --market nifty  --start 2025-10-10 --end 2026-10-10   (needs UPSTOX_ANALYTICS_TOKEN)
 * Options: --out <dir> (default backend/data/backtests), --cost <round-trip %>, --bootstrap <n>
 */
function argument(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const market = (argument('market', 'crypto') as 'crypto' | 'nifty');
const endDate = argument('end', new Date().toISOString().slice(0, 10))!;
const defaultStart = new Date(`${endDate}T00:00:00Z`);
defaultStart.setUTCFullYear(defaultStart.getUTCFullYear() - (market === 'crypto' ? 2 : 1));
const startDate = argument('start', defaultStart.toISOString().slice(0, 10))!;
const start = Date.parse(`${startDate}T00:00:00Z`);
const end = Date.parse(`${endDate}T00:00:00Z`);
const outArg = argument('out', join(repoRoot, 'backend/data/backtests'))!;
const outDir = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
const cost = argument('cost');
const bootstrapIterations = Number(argument('bootstrap', '1000'));

const technical = ['spot', 'btc', 'eth', 'ema', 'rsi', 'macd', 'momentum'];
const ablationGroups: Record<string, string[]> = market === 'crypto'
  ? { 'BTC 24h move': ['btc'], 'ETH 24h move': ['eth'], 'EMA 12/26': ['ema'], RSI: ['rsi'], 'MACD histogram': ['macd'], '12h momentum': ['momentum'], 'Top-10 breadth': ['breadth'], 'Fear & Greed': ['fear-greed'], 'All technical': technical }
  : { 'Spot move': ['spot'], 'EMA 12/26': ['ema'], RSI: ['rsi'], 'MACD histogram': ['macd'], 'Session momentum': ['momentum'], 'Everything except spot move': ['ema', 'rsi', 'macd', 'momentum'] };

const limitations = market === 'crypto'
  ? [
      'Replays BTC/ETH/basket hourly candles and the daily Fear & Greed index only; news, spreads, derivatives and market cap have no stored history and are missing (as when a live provider fails).',
      '24h changes come from hourly closes (the live ticker uses a rolling 24h window).',
      'Fear & Greed is used from one hour after its 00:00 UTC stamp because its publication time is undocumented.',
      'Trading: entry at the decision close (no latency), flat 0.20% round-trip cost assumed for spot taker fees plus slippage; no funding or market impact.',
      'Single asset, single horizon (6 h); results do not generalise to other horizons without re-running.'
    ]
  : [
      'Replays NIFTY index and India VIX 5m candles only: options, breadth, futures volume and news have no stored history, so positioning and sentiment analysts are absent.',
      'Trading assumes a futures-like instrument at the index price with a flat 0.05% round-trip cost; no basis, lot size, margin or slippage model.',
      'Days come from actual exchange candles, so historical holidays are implicit.',
      'About one year of data gives a small non-overlapping test sample; intervals are wide.'
    ];

function fingerprint(name: string, rows: Array<{ time: number }>) {
  return {
    [name]: {
      count: rows.length,
      first: rows.length ? new Date(rows[0].time).toISOString() : null,
      last: rows.length ? new Date(rows[rows.length - 1].time).toISOString() : null,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    }
  };
}

function git(command: string) {
  try {
    return execSync(command, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  if (!(start < end)) throw new Error('--start must be before --end.');
  console.log(`Loading ${market} history ${startDate} → ${endDate}…`);
  let observations: Observation[];
  let fingerprints: RunMetadata['fingerprints'] = {};
  let dataSources: string[];
  if (market === 'crypto') {
    const history = normaliseHistory(await loadCryptoHistory(start, end));
    history.fearGreed = history.fearGreed.filter((point) => point.time < end);
    for (const [symbol, candles] of Object.entries(history.basket)) fingerprints = { ...fingerprints, ...fingerprint(`binance ${symbol} 1h`, candles as Candle[]) };
    fingerprints = { ...fingerprints, ...fingerprint('alternative.me fear & greed (daily)', history.fearGreed) };
    observations = cryptoObservations(history, DEFAULT_CONFIG);
    dataSources = ['Binance spot klines (data-api.binance.vision, 1h, closed candles)', 'Alternative.me Fear & Greed full history'];
  } else {
    const history = normaliseHistory(await loadNiftyHistory(start, end));
    fingerprints = { ...fingerprint('upstox NIFTY 50 5m', history.nifty), ...fingerprint('upstox India VIX 5m', history.vix) };
    observations = niftyObservations(history, DEFAULT_CONFIG);
    dataSources = ['Upstox historical/intraday candle API v3 (5m)'];
  }
  if (observations.length < 200) throw new Error(`Only ${observations.length} observations; not enough for a meaningful backtest.`);

  console.log(`${observations.length} decision points; running walk-forward evaluation…`);
  const report = runBacktest(observations, {
    market,
    config: DEFAULT_CONFIG,
    roundTripCostPct: cost ? Number(cost) : undefined,
    bootstrapIterations,
    ablationGroups
  });
  report.limitations = limitations;

  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `${market}-${startDate}_${endDate}`);
  const artifacts = [`${base}.json`, `${base}.md`, ...report.finalTest.map((final) => `${base}-reliability-${final.outcomeThreshold}.svg`)].map((path) => relative(repoRoot, path));
  const meta: RunMetadata = {
    command: `npm run backtest -w backend -- --market ${market} --start ${startDate} --end ${endDate}${cost ? ` --cost ${cost}` : ''}${bootstrapIterations !== 1000 ? ` --bootstrap ${bootstrapIterations}` : ''}`,
    generatedAt: new Date().toISOString(),
    gitCommit: git('git rev-parse --short HEAD'),
    gitDirty: (() => { const status = git('git status --porcelain'); return status == null ? null : status.length > 0; })(),
    requestedRange: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    dataSources,
    fingerprints,
    artifacts
  };
  await writeFile(`${base}.json`, `${JSON.stringify({ meta, report }, null, 2)}\n`, 'utf8');
  await writeFile(`${base}.md`, renderMarkdown(report, meta), 'utf8');
  for (const final of report.finalTest) {
    const probability = final.result.probability;
    await writeFile(`${base}-reliability-${final.outcomeThreshold}.svg`, reliabilitySvg(
      `${market.toUpperCase()} untouched test, ±${final.outcomeThreshold}% (${final.result.n} windows)`,
      { heuristic: probability.heuristic.reliabilityBins, scoreCalibrated: probability.scoreCalibrated.reliabilityBins, logistic: probability.logistic.reliabilityBins }
    ), 'utf8');
  }
  console.log(`Selected outcome threshold (development only): ±${report.selection.selectedOutcomeThreshold}%`);
  for (const final of report.finalTest) {
    const c = final.result.classification;
    console.log(`Test ±${final.outcomeThreshold}% (${final.label}), n=${final.result.n}: macro-F1 hand-set ${c.handSet.macroF1}, logistic ${c.logistic.macroF1}, majority ${c.majority.macroF1}, momentum ${c.momentum.macroF1}, neutral ${c.alwaysNeutral.macroF1}`);
  }
  console.log(`Artifacts:\n  ${artifacts.join('\n  ')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
