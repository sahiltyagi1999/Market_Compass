# Data Sources (verified 2026-10-10)

| Input | Source | Key | Use | Freshness rule |
| --- | --- | --- | --- | --- |
| NIFTY spot, VIX | Upstox LTP v3 | Analytics token | Direction (spot), risk (VIX) | During market hours, stale if the latest 5m candle is > 15 min old (LTP has no timestamp) |
| NIFTY 5m candles | Upstox intraday + historical v3 | Analytics token | Technical analyst | Only closed candles; previous session used for warm-up only |
| Option chain (nearest expiry) | Upstox `/v2/option/chain` | Analytics token | Near-ATM OI flow (direction); PCR, zones, max pain, IV skew (context); IV/spread (risk) | Fetched fresh each cycle |
| Nifty 50 constituents | niftyindices.com / NSE archives CSV | None | Breadth universe | Cached 12 h |
| Constituent quotes | Upstox full quote v3 (≤500 keys) | Analytics token | Advance/decline (direction); % above VWAP, concentration (context) | Stale if median last trade > 15 min old in session |
| Sector indices | Upstox LTP v3 (`NSE_INDEX|Nifty Bank`, `Nifty Fin Service`, …) | Analytics token | Context | — |
| Near-month NIFTY future | Upstox instrument search + candles | Analytics token | VWAP distance, relative volume (context) | Closed candles only |
| GIFT Nifty, US 30 futures | Upstox global instruments (LTP) | Analytics token | Context | ~2 min / 20 s provider latency |
| USD/INR, Brent | Upstox global indicators (daily candles only) | Analytics token | Context | Latest daily candle, labelled as such |
| FII/DII cash flows | Upstox `/v2/market/fii`, `/dii` | Analytics token | Context | Only sessions before today (publication time undocumented) |
| BTC/ETH tickers, 1h candles, depth | Binance spot (`data-api.binance.vision`) | None | Technical analyst, risk, context | Ticker ≤ 5 min, last candle ≤ 2 h |
| Top-10 basket | Binance spot | None | Breadth (direction) | — |
| Funding, OI, premium | Binance USD-M futures → OKX fallback | None | Context + crowding warnings | Binance often HTTP 451 from US IPs |
| Market cap, dominance | CoinGecko → CoinLore | None (demo key optional) | Context only | ≤ 60 min |
| Fear & Greed | Alternative.me | None (attribution required) | Sentiment analyst | ≤ 48 h; local proxy shown but never scored |
| Headlines | Yahoo, ET, CoinDesk, Cointelegraph, Google News RSS, Upstox news | None / token | Rules-based sentiment | ≤ 4 days, recency-weighted |
| NSE holidays 2026 | NSE holiday master | None | Session calendar | Hard-coded in `marketSession.ts`; add each new year |
| FOMC, US CPI, RBI MPC dates | federalreserve.gov, bls.gov, rbi.org.in | None | Event warnings | Hard-coded in `events.ts`; RBI time unconfirmed |

Not used: Yahoo Finance's unofficial API (personal-use terms), direct NSE JSON scraping, US 10Y yield (only FRED CSV with ~1-day lag; not wired), liquidation data (no complete free feed), on-chain metrics (horizon not justified).

Historical data for backtests: Binance klines (years, keyless) and Alternative.me full history; Upstox 5m candles from January 2022 (one month per request). Option chains, constituent quotes and news have no stored history, so those inputs are absent in replay.
