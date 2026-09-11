# MarketCompass India

A real-data Nifty 50 options and crypto research dashboard inspired by the
specialist-analyst architecture in TauricResearch/TradingAgents.

The app runs four independent desks:

- Technical: EMA 12/26, RSI 14, MACD, momentum and realised volatility
- Positioning: Nifty PCR/OI/max pain or crypto market breadth/dominance
- Sentiment: recency-weighted live headlines plus crypto Fear & Greed
- Risk: VIX, IV, spreads and volatility

Their confidence-weighted consensus produces a bullish, neutral and bearish
model distribution. Bull and bear arguments, source health and every weighted
input remain visible. The app also records forward outcomes; hit rate stays
marked provisional until at least 30 predictions resolve.

## Run

Requirements: Node.js `20.19+` or `22.12+`.

```bash
cp .env.example .env
npm install
npm run dev
```

- Dashboard: `http://localhost:5174`
- API: `http://localhost:4100/api/dashboard`

## Keys and cost

Crypto, Google News RSS and Fear & Greed run without a key. Full Nifty analysis
needs the free, read-only Upstox Analytics Token:

```env
UPSTOX_ANALYTICS_TOKEN=your_token
UPSTOX_NIFTY_KEY=NSE_INDEX|Nifty 50
UPSTOX_VIX_KEY=NSE_INDEX|India VIX
```

`COINGECKO_DEMO_API_KEY` is optional and only improves rate-limit stability.
The free deterministic engine remains the fallback. To enable semantic news
analysis, add:

```env
OPENAI_API_KEY=your_server_side_key
OPENAI_MODEL=gpt-5-mini
```

GPT classifies every displayed headline by market impact and importance,
explains the likely causal effect, and writes an overall news brief. AI
sentiment contributes 75% of the news score and the deterministic model
contributes 25%. Unchanged analysis is cached for 15 minutes.

## Commands

```bash
npm run dev
npm test
npm run build
```

See [TAURIC_FRAMEWORK_ADAPTATION.md](TAURIC_FRAMEWORK_ADAPTATION.md) for the
architecture, source choices and limitations.

## Important

The displayed probabilities are model-implied, not guaranteed or initially
calibrated probabilities. This is a research aid, not financial advice.
