# Free Data Research

| Market input | Implemented source | Key | Cost |
| --- | --- | --- | --- |
| Nifty quote, VIX, 5m candles | Upstox | Analytics Token | Free |
| Nifty option chain, Greeks, OI | Upstox | Analytics Token | Free |
| Nifty max pain | Upstox | Analytics Token | Free |
| Nifty instrument news | Upstox | Analytics Token | Free |
| BTC/ETH tickers and BTC candles | Binance public data | None | Free |
| Crypto global cap, dominance, breadth | CoinGecko | None; demo key optional | Free tier |
| Nifty and crypto headlines | Google News RSS | None | Free |
| Crypto Fear & Greed | Alternative.me | None | Free |

Direct NSE scraping was deliberately avoided because it is brittle and often
blocked. An Upstox Analytics Token gives a stable read-only path without
granting order permissions.

Headline sentiment is a transparent lexicon model, not an LLM. It handles
finance-specific positive/negative terms, common negation, deduplication,
source diversity and recency. This is cheaper and reproducible, but weaker on
sarcasm, nuanced policy language and ambiguous headlines.

The next justified upgrade is not a more expensive model by itself. It is an
out-of-sample calibration set large enough to compare model versions by market,
horizon and regime.
