import cors from 'cors';
import express from 'express';
import { buildDashboard } from './providers.js';

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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasUpstoxToken: Boolean(process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN),
    hasCoinGeckoKey: Boolean(process.env.COINGECKO_DEMO_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    openAIModel: process.env.OPENAI_MODEL || 'gpt-5-mini',
    time: new Date().toISOString()
  });
});

app.get('/api/dashboard', async (_req, res, next) => {
  try {
    res.json(await buildDashboard());
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected server error' });
});
