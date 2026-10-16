import cors from 'cors';
import express from 'express';
import { getDashboard, refreshIfStale, snapshotStatus } from './dashboardSchedule.js';
import { MODEL_VERSION } from './modelConfig.js';
import { evaluationReport } from './predictionService.js';
import { getProviderHealth } from './providers.js';
import { getRepository } from './storage.js';

export const app = express();
const normalizeOrigin = (origin: string) => origin.trim().replace(/\/+$/, '');
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5174')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  }
}));
app.use(express.json({ limit: '100kb' }));

const startedAt = Date.now();
const uptimeSeconds = () => Math.round((Date.now() - startedAt) / 1000);

// Liveness: no I/O, always fast. Use as Render's healthCheckPath.
app.get('/api/health/live', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, uptimeSeconds: uptimeSeconds(), time: new Date().toISOString() });
});

// Keep-alive for an external cron (every 10 min keeps a free Render instance awake).
// Also restarts a missed 15-minute prediction cycle in the background; never blocks on providers.
app.get('/api/keepalive', (_req, res) => {
  const refreshStarted = refreshIfStale();
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    uptimeSeconds: uptimeSeconds(),
    time: new Date().toISOString(),
    refreshStarted,
    snapshot: snapshotStatus()
  });
});

app.get('/api/health', async (_req, res) => {
  const storage = (await getRepository()).info;
  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    storage,
    providers: getProviderHealth(),
    hasUpstoxToken: Boolean(process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN),
    hasCoinGeckoKey: Boolean(process.env.COINGECKO_DEMO_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    openAIModel: process.env.OPENAI_MODEL || 'gpt-5-mini',
    time: new Date().toISOString()
  });
});

app.get('/api/dashboard', async (_req, res, next) => {
  try {
    res.json(await getDashboard());
  } catch (error) {
    next(error);
  }
});

// Forward-outcome evaluation for the current model version (overlap-aware).
app.get('/api/evaluation', async (_req, res, next) => {
  try {
    res.json(await evaluationReport(await getRepository()));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected server error' });
});
