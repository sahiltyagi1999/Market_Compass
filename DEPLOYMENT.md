# Deploy: Render (API) + Netlify (frontend)

Repository: `https://github.com/sahiltyagi1999/Market_Compass` · Backend config: [render.yaml](render.yaml) · Frontend config: [netlify.toml](netlify.toml). Never put tokens in either file or in the repo.

## 0. Before you start

1. **Rotate credentials** that have ever been shared or pasted anywhere: Upstox Analytics Token and OpenAI key.
2. **Create a free Postgres database that does not expire** (recommended: a Neon free project). Copy its connection string (`postgres://…?sslmode=require`). Without it, prediction history resets on every Render restart and the forward track record can never reach its 30-outcome gate. Render's own free Postgres expires after 30 days.

## 1. Backend on Render (Blueprint)

1. Render → **New → Blueprint** → connect `sahiltyagi1999/Market_Compass`, branch `main`.
2. Render reads `render.yaml`: free web service `market-compass-india-api`, region **Singapore**, build `npm ci && npm run build -w backend`, start `npm run start -w backend`, health check `/api/health/live`, Node 22.22.0.
3. Fill in the secret variables when prompted:

   | Variable | Value |
   |---|---|
   | `FRONTEND_ORIGIN` | Your Netlify URL, e.g. `https://your-site.netlify.app` (no trailing slash; comma-separate several) |
   | `UPSTOX_ANALYTICS_TOKEN` | Rotated Upstox Analytics Token |
   | `OPENAI_API_KEY` | Rotated key (optional; only explains headlines) |
   | `DATABASE_URL` | Neon connection string |
   | `COINGECKO_DEMO_API_KEY` | Optional; leave empty |

   You can put a placeholder in `FRONTEND_ORIGIN` now and fix it in step 3.
4. Wait for **Live**, then check:

   ```bash
   curl https://<your-api>.onrender.com/api/health/live   # {"ok":true,...}
   curl https://<your-api>.onrender.com/api/health        # storage.kind "postgres", durable true, hasUpstoxToken true
   curl https://<your-api>.onrender.com/api/keepalive     # snapshot.current true after the first build
   ```

Region note: the region is fixed when the service is created. If you already have a US-region service, Binance futures will usually fail there (the app falls back to OKX, then marks derivatives unavailable); create a new service from the Blueprint to get Singapore.

## 2. Frontend on Netlify

1. Netlify → **Add new project → Import an existing project** → GitHub → `sahiltyagi1999/Market_Compass`.
2. Netlify reads `netlify.toml`: build `npm run build -w frontend`, publish `frontend/dist`, Node 22.22.0.
3. Project configuration → Environment variables → add `VITE_API_BASE_URL=https://<your-api>.onrender.com` (no trailing slash). It is baked in at build time.
4. Deploy (or **Trigger deploy → Deploy project without cache** after changing the variable).

## 3. Connect the two

1. Copy the final Netlify URL into Render's `FRONTEND_ORIGIN` and save (Render redeploys).
2. Open the Netlify site: both desks, news and the 15-minute countdown should load. A CORS error in the browser console means `FRONTEND_ORIGIN` does not exactly match the site origin.

## 4. Keep-alive cron

Render free services sleep after 15 minutes without inbound traffic; while asleep, no predictions are recorded. Ping `GET /api/keepalive` every 10 minutes. It responds immediately and also restarts a missed 15-minute prediction cycle in the background.

**Primary: cron-job.org (free, reliable timing)**

1. Create a job: URL `https://<your-api>.onrender.com/api/keepalive`, method GET, schedule every 10 minutes, timeout 60 s+ (first ping after sleep includes a cold start).
2. Turn on failure notifications.

**Backup: GitHub Actions** (already in [.github/workflows/keepalive.yml](.github/workflows/keepalive.yml); free on this public repo)

1. GitHub → Settings → Secrets and variables → Actions → **Variables** → add `KEEPALIVE_URL` = `https://<your-api>.onrender.com/api/keepalive`.
2. Actions tab → "Keep Render API awake" → **Run workflow** once to test.

GitHub may delay scheduled runs by several minutes and disables schedules after 60 days without repository activity, so use it as a backup, not the only pinger.

Budget: one free service awake 24/7 uses about 720–744 of Render's 750 free instance-hours per month, leaving almost nothing for other free services in the same workspace.

## 5. Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health/live` | Liveness, no I/O (Render health check) |
| `GET /api/keepalive` | Cron ping: uptime, snapshot freshness, starts a missed cycle |
| `GET /api/health` | Storage durability, key presence, provider health |
| `GET /api/dashboard` | Current locked 15-minute snapshot |
| `GET /api/evaluation` | Forward-outcome metrics for the current model version |

## 6. Optional: import local prediction history

```bash
DATABASE_URL='postgres://…' npm run migrate:predictions -w backend
```

Idempotent. v3 entries are imported as `legacy` and excluded from evaluation. Retention: Postgres keeps every record (~48 rows/day); use Neon point-in-time restore or periodic `pg_dump` for backups.

## 7. Production notes

- The server builds one locked snapshot every 15 minutes (:00/:15/:30/:45 IST) and evaluates due predictions every 5 minutes.
- Cold start after sleep is roughly 30–60 s; the frontend shows its loading screen meanwhile.
- If the Netlify domain changes, update `FRONTEND_ORIGIN`. If the Render URL changes, update `VITE_API_BASE_URL` and redeploy Netlify.
- Update `backend/src/marketSession.ts` (NSE holidays) and `backend/src/events.ts` (FOMC/CPI/RBI) before January 2027; live NIFTY forecasting stops on unverified years by design.
- The app stays on PAPER TRADE ONLY; see [MODEL_AUDIT.md](MODEL_AUDIT.md).
