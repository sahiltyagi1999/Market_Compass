# MarketCompass India

A real-data research dashboard for the Nifty 50 (intraday) and Bitcoin (6-hour), with a forward track record and an offline backtester. It is a research aid, not a trading system: there is no order execution, and directional setups stay locked until measured evidence supports them.

## How it works

Every 15 minutes (:00/:15/:30/:45 IST) the server fetches all sources fresh and builds one locked snapshot per market:

1. **Data** — Upstox (NIFTY quote, 5m candles with previous-session warm-up, option chain, constituent quotes, sector indices, near-month futures, global cues, FII/DII), Binance spot and USD-M futures (OKX fallback), CoinGecko/CoinLore, Alternative.me, RSS news. Every source carries observation/retrieval timestamps; stale values are excluded from scoring.
2. **Features** — each is a *direction* input (moves the score), a *risk* input (changes signal quality only) or *context* (shown, never scored).
3. **Analysts** — Technical (30), Positioning/Breadth (30), Sentiment (22), Risk (0). Only analysts with valid data vote; weights scale with each analyst's input coverage.
4. **Outputs** — directional score (−100..100), verdict (±30), signal quality (uncalibrated, 28–89), a heuristic distribution labelled uncalibrated, and calibrated probabilities only once 150 independent outcomes exist and they beat the class-frequency forecast on held-out data.
5. **Predictions** — one per market per hourly slot (unique id), NIFTY targets capped at the 15:30 close, resolved against the candle close at the target time, evaluated overlap-aware.
6. **Decision** — computed on the server: `WAIT FOR DATA`, `WAIT`, `PAPER TRADE ONLY` (until ≥30 independent outcomes beat chance, always-neutral and majority-class baselines at the 95% lower bound), `WAIT / NO TRADE`, or a research-only setup.

Full formulas, rules and data sources: [REPO_LOGIC.md](REPO_LOGIC.md). Audit, bug fixes and backtest results: [MODEL_AUDIT.md](MODEL_AUDIT.md).

## Run

Requirements: Node.js `22.x` (Vite needs `20.19+`).

```bash
cp .env.example .env
npm install
npm run dev
```

- Dashboard: `http://localhost:5174`
- API: `/api/dashboard`, `/api/health` (storage + provider health), `/api/health/live` (liveness), `/api/keepalive` (cron ping), `/api/evaluation` (forward-outcome metrics)

## Commands

```bash
npm test                 # backend + frontend tests
npm run typecheck
npm run build
npm run backtest -w backend -- --market crypto --start 2024-10-10 --end 2026-10-10 --out ../docs/backtests   # keyless Binance history
npm run backtest -w backend -- --market nifty --start 2025-10-10 --end 2026-10-10 --out ../docs/backtests    # needs UPSTOX_ANALYTICS_TOKEN
npm run migrate:predictions -w backend                        # JSON history -> DATABASE_URL
```

Each backtest writes JSON, Markdown and reliability-diagram SVGs (default `backend/data/backtests/`, git-ignored; the audited runs are committed in `docs/backtests/`). Downloaded history is cached in `backend/data/history/`. Pin `--start/--end` for reproducible results.

## Keys

| Variable | Needed for | Notes |
| --- | --- | --- |
| `UPSTOX_ANALYTICS_TOKEN` | All NIFTY market data | Free, read-only, valid one year |
| `DATABASE_URL` | Durable prediction history | Any Postgres; without it a local JSON file is used |
| `OPENAI_API_KEY` | Headline explanations | Optional; never changes the score |
| `COINGECKO_DEMO_API_KEY` | Rate-limit headroom | Optional |

Crypto, news and Fear & Greed need no key. Deployment steps: [DEPLOYMENT.md](DEPLOYMENT.md).

## Important

A walk-forward audit on real history found no persistent edge over simple baselines and no net trading edge after costs (see MODEL_AUDIT.md); the app stays on PAPER TRADE ONLY. Scores and signal quality are uncalibrated heuristics, not win probabilities. Fear & Greed data is provided by alternative.me.
