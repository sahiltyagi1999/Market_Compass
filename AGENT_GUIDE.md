# MarketCompass India Agent Guide

## Product contract

This is a grounded market-research dashboard. Never add synthetic market
snapshots or silently replace a failed source with made-up values.

## Runtime flow

`GET /api/dashboard` performs these steps:

1. `providers.ts` fetches independent market, candle, positioning and news data.
2. `indicators.ts` computes deterministic EMA, RSI, MACD and volatility values.
3. `sentiment.ts` scores and recency-weights deduplicated headlines.
4. `aiNews.ts` optionally adds structured GPT market-impact analysis.
5. `scoring.ts` creates four analysts, bull/bear cases and final probabilities.
6. `predictionStore.ts` resolves old calls and records eligible new calls.
7. React renders the evidence, disagreements, news explanations and calibration.

## Important files

- `backend/src/providers.ts`: external API boundaries and short-lived cache
- `backend/src/indicators.ts`: technical indicator calculations
- `backend/src/sentiment.ts`: transparent finance headline sentiment
- `backend/src/aiNews.ts`: optional OpenAI Responses API enrichment
- `backend/src/scoring.ts`: analyst weighting, verdict and probability model
- `backend/src/predictionStore.ts`: forward outcome tracking
- `frontend/src/App.tsx`: research dashboard
- `backend/data/predictions.json`: runtime calibration state

## Data policy

- Nifty market data: Upstox Analytics Token
- Crypto market data: Binance and CoinGecko, with CoinLore global and Binance breadth fallbacks
- Headlines: Yahoo Finance, Economic Times, CoinDesk and Cointelegraph RSS; Google and Upstox news are supplemental
- Crypto sentiment: Alternative.me Fear & Greed
- A news-only Nifty response must remain `UNAVAILABLE`; headlines cannot issue a
  standalone options call.
- Every external source must fail independently and expose its status.

## Environment

```env
PORT=4100
FRONTEND_ORIGIN=http://localhost:5174
UPSTOX_ANALYTICS_TOKEN=
UPSTOX_NIFTY_KEY=NSE_INDEX|Nifty 50
UPSTOX_VIX_KEY=NSE_INDEX|India VIX
# COINGECKO_DEMO_API_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
```

Use Node.js `20.19+` or `22.12+`. Verify changes with `npm test` and
`npm run build`.
