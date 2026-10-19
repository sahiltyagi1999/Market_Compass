# MarketCompass India — Poora Logic (Hinglish mein)

> Ye file batati hai ki app **kya karta hai, data kahan se laata hai, aur Bullish / Bearish / Neutral kaise decide karta hai** — model `research-desk-v4`.
> Har formula code se liya gaya hai. Bugs aur backtest results ki English report: [MODEL_AUDIT.md](MODEL_AUDIT.md).

---

## 1. App ek line mein

Do desk hain: **Nifty 50** (intraday, max 3 ghante) aur **Bitcoin** (6 ghante). Har 15 min server saara data fresh laata hai → features banata hai → 4 analyst score dete hain → weighted average = **directional score** → **verdict**. Saath mein **signal quality**, prediction save hoti hai, baad mein asli price se check hoti hai.

```
Har 15 min (:00 :15 :30 :45 IST) — dashboardSchedule.ts
  ↓  cache clear, saara data fresh fetch (providers.ts, niftyData.ts, cryptoData.ts, news.ts)
  ↓  freshness check — purana (stale) data score se bahar
Features → har feature ka role: direction / risk / context
  ↓
4 Analysts (scoring.ts) → weighted score → verdict + signal quality
  ↓
Prediction save (har ghante 1, unique id) → predictionService.ts + storage.ts
  ↓  har 5 min evaluation job: target time ka candle price se sahi/galat
Track record + calibration → server pe decision (decision.ts) → Frontend sirf dikhata hai
```

---

## 2. Files ka map

| File | Kaam |
|---|---|
| [providers.ts](backend/src/providers.ts) | Dono desk ka data jodna, freshness, scoring call |
| [niftyData.ts](backend/src/niftyData.ts) | Nifty 50 breadth, sectors, futures VWAP, global cues, FII/DII |
| [optionsAnalysis.ts](backend/src/optionsAnalysis.ts) | Option chain strike-wise analysis |
| [cryptoData.ts](backend/src/cryptoData.ts) | Funding, OI, premium (Binance → OKX), order book |
| [news.ts](backend/src/news.ts), [sentiment.ts](backend/src/sentiment.ts), [aiNews.ts](backend/src/aiNews.ts) | Headlines, word-based score, AI explanation |
| [indicators.ts](backend/src/indicators.ts) | RSI, EMA, MACD, ATR, VWAP, regime |
| [modelConfig.ts](backend/src/modelConfig.ts) | Saare weights, ranges, thresholds, horizons, `MODEL_VERSION` |
| [scoring.ts](backend/src/scoring.ts) | **Asli dimaag** — analysts, score, verdict, signal quality |
| [marketSession.ts](backend/src/marketSession.ts) | NSE timing + 2026 holidays |
| [outcomes.ts](backend/src/outcomes.ts), [evaluation.ts](backend/src/evaluation.ts) | UP/DOWN/NEUTRAL label, accuracy, CI, Brier, calibration |
| [predictionService.ts](backend/src/predictionService.ts), [storage.ts](backend/src/storage.ts), [priceHistory.ts](backend/src/priceHistory.ts) | Prediction banana, resolve karna, save karna |
| [decision.ts](backend/src/decision.ts) | PAPER TRADE ONLY / WAIT / SETUP |
| [events.ts](backend/src/events.ts) | FOMC, US CPI, RBI MPC calendar |
| [backtest/](backend/src/backtest/) | Purane data pe model chalana |
| [MarketCardView.tsx](frontend/src/components/MarketCardView.tsx) | Card UI |

---

## 3. Words jo samajhne zaroori hain

### General
- **Bullish / Bearish / Neutral** — upar / neeche / sideways ka lean.
- **Spot** — abhi ka price. **Previous close** — pichhle session ka last price.
- **Candle** — ek time-period (5 min / 1 ghanta) ka Open, High, Low, Close, Volume. **Closed candle** = jiska time poora ho gaya. App sirf closed candles use karta hai.
- **Session** — market khulne se band hone tak (NSE: 09:15–15:30 IST).
- **Momentum** — price kitni tezi se ek taraf ja raha hai.
- **Volatility** — price kitna uchhal raha hai. Zyada = risk zyada.
- **Stale data** — purana data jo "abhi ka" bata ke use nahi karna chahiye.

### Technical indicators
- **EMA 12/26** — naye candles ko zyada importance wala average. Fast (12) > slow (26) = uptrend.
- **RSI (0–100)** — buyers vs sellers. 50 se upar = buyers strong. 70+ overbought, 30− oversold.
- **MACD histogram** — (EMA12 − EMA26) − uska 9-EMA. Positive = momentum badh raha.
- **Warm-up** — indicator ko "settle" hone ke liye pehle kuch candles chahiye. Isliye Nifty mein kal ke candles bhi jode jaate hain.
- **ATR** — average candle range, % mein. Volatility ka simple naap.
- **VWAP** — volume-weighted average price. Price VWAP se upar = aaj buyers ne control rakha.
- **Efficiency ratio (ER)** — net move ÷ total chalna. 1 = seedha trend, 0 = idhar-udhar (chop). ER ≥ 0.30 = "trending", warna "range-bound".
- **Relative volume** — aaj ab tak ka volume ÷ pichhle dino mein isi time tak ka average.
- **Opening gap** — aaj ka open vs kal ka close.

### Options (Nifty)
- **Call / Put** — upar / neeche jaane pe faayda wala option. **Strike** — option ka price level. **ATM** — spot ke sabse paas wala strike.
- **Expiry** — option ka last din. App nearest expiry dekhta hai.
- **OI (Open Interest)** — kitne contracts khule hain. **ΔOI** — aaj kitne naye jude / band hue.
- **PCR** — Put OI ÷ Call OI. **Near-ATM PCR** — sirf ATM ke aas-paas ke strikes ka.
- **Premium** — option ki keemat. **IV** — premium mein chhupa expected move. **IV skew** — put IV − call IV (zyada = log downside protection khareed rahe).
- **Delta** — spot 1 point hile toh premium kitna hilega. **Theta** — har din time ki wajah se premium kitna ghatega.
- **Writing / Buying / Short covering / Long unwinding** — OI aur premium ke combination se andaza ki kaun kya kar raha (sirf andaza, asli intent nahi pata chalta).
- **Max pain** — wo strike jahan expiry pe option buyers ka sabse zyada nuksaan. Sirf context.
- **Support / Resistance zone** — jahan sabse zyada Put OI (neeche) / Call OI (upar) hai. Guarantee nahi.
- **India VIX** — Nifty ka fear index.

### Breadth / flows (Nifty)
- **Advance/Decline** — Nifty 50 mein kitne stock upar, kitne neeche.
- **Concentration** — move sab stocks mein hai (broad) ya kuch hi stocks mein (narrow).
- **GIFT Nifty** — Nifty futures jo India ke bahar bhi trade hote hain. **FII/DII** — foreign / domestic institutions ki net kharid-bikri (₹ crore).

### Crypto
- **Breadth** — top-10 coins mein kitne green. **BTC dominance** — total market mein BTC ka hissa.
- **Perpetual futures / Funding rate** — perp ka price spot ke paas rakhne ke liye longs-shorts ek dusre ko fee dete hain. Positive funding = longs bheed mein.
- **Funding percentile** — aaj ka funding pichhle 30 din mein kahan hai (p90 = top 10%).
- **Basis / premium** — perp price vs spot index.
- **Order-book imbalance** — mid price ke 0.5% ke andar bid vs ask depth.
- **Fear & Greed (0–100)** — crypto mood index (alternative.me).

### Model / statistics
- **Directional score (−100..+100)** — app ka final number.
- **Signal quality (28–89)** — kitna data mila, analysts kitne sehmat, signal kitna strong, risk kaisa. **Probability nahi hai.**
- **Calibration** — app "60% up" bole toh asal mein ~60% baar up hona chahiye. Iske liye purane results chahiye. Calibrated probability tabhi dikhti hai jab wo class-frequency forecast ko haraye (warna status `no_skill`).
- **Brier score / log loss** — probability kitni sahi thi (kam = behtar).
- **Hit rate / accuracy** — kitne % predictions sahi. **Balanced accuracy** — teeno class (UP/NEUTRAL/DOWN) ki recall ka average; "hamesha NEUTRAL bolo" wali chalaki pakadta hai.
- **Confidence interval (CI)** — sample chhota ho toh asli hit rate kitne range mein ho sakta hai.
- **Overlapping windows** — har ghante 6-ghante ki prediction → windows ek dusre pe chadhti hain → ye independent nahi. **Non-overlapping** sample hi asli gina jaata hai.
- **Backtest** — purane data pe model chala ke dekhna. **Look-ahead bias** — galti se future data use kar lena. **Purging** — train/test ke boundary pe overlapping samples hata dena.
- **Train / validation / test** — train pe seekho, validation pe tune karo, test ko sirf ek baar dekho.
- **Ablation** — ek feature hata ke dekho score pe kya fark pada.
- **Baseline** — simple rule (hamesha neutral, majority class, ya pichhla move continue) jisse model ko harana chahiye.
- **Macro-F1** — har class ka F1 (precision aur recall ka balance) ka average. Constant prediction wale baseline ko 2 class pe 0 milta hai.
- **Walk-forward** — data ko time order mein tukdon mein baanto; har baar pichhle pe seekho, agle pe check karo. Ek baar ki jeet kaafi nahi, folds mein tikni chahiye.
- **Logistic regression** — simple learned model jo features se teeno class ki probability deta hai. Weights data se seekhe jaate hain.
- **Drawdown** — peak se sabse badi girawat. **Compounded return** — har trade ka result agle trade ke capital pe lagta hai.

---

## 4. Data kahan se aata hai

### Nifty (token: `UPSTOX_ANALYTICS_TOKEN`, free, read-only)
| Data | Source | Role |
|---|---|---|
| Spot, VIX | Upstox LTP v3 | Direction (spot), Risk (VIX) |
| 5m candles (aaj + kal warm-up ke liye) | Upstox intraday + historical | Technical |
| Option chain (nearest expiry) | Upstox option chain | OI flow (direction); PCR, zones, max pain, skew (context); IV, spread (risk) |
| Nifty 50 stocks list | niftyindices.com / NSE CSV | Breadth |
| 50 stocks ke quotes | Upstox full quote v3 | Advance/decline (direction); above-VWAP, concentration (context) |
| Sector indices (Bank, Fin Service, IT, Auto, Pharma, Metal, FMCG) | Upstox LTP | Context |
| Near-month NIFTY futures | Upstox search + candles | VWAP distance, relative volume (context) — index ka volume 0 hota hai |
| GIFT Nifty, US 30 futures, USD/INR, Brent | Upstox global instruments | Context |
| FII/DII | Upstox | Context — **sirf pichhle session ka**, kyunki publish time pata nahi |
| News | Yahoo, ET, Google News RSS, Upstox news | Sentiment |

Token nahi → sirf news → **UNAVAILABLE** (sirf news pe Nifty call nahi).

### Crypto (koi key nahi)
| Data | Source | Role |
|---|---|---|
| BTC/ETH price, 24h change, bid/ask | Binance spot | Technical, risk |
| BTC 1h candles (150) | Binance | Technical; 1h/4h return (context) |
| Top-10 basket | Binance | Breadth (direction) |
| Funding, OI, premium | Binance futures → fail ho toh OKX | Context + crowding warning |
| Order book | Binance spot depth | Context |
| Market cap, dominance | CoinGecko → CoinLore | Context |
| Fear & Greed | alternative.me | Sentiment (fail ho toh proxy dikhta hai, **score nahi hota**) |
| News | Yahoo, CoinDesk, Cointelegraph, Google News | Sentiment |

### Freshness rules
- Har source ke saath `observedAt`, `retrievedAt`, `ageSeconds`, `maxAgeSeconds` aata hai.
- Market khula ho aur Nifty ka latest candle 15 min se purana → **stale** → candles aur spot score se bahar, card pe warning.
- BTC ticker > 5 min, 1h candle > 2 ghante, Fear & Greed > 48 ghante → stale.
- Har 15 min cycle se pehle saara cache clear. Sirf AI explanation same headlines pe 15 min reuse hoti hai.

---

## 5. Core trick: `scaled(value, range)`

```
scaled(value, range) = value / range, −1 aur +1 pe cut
value missing / NaN ya range ≤ 0 → undefined (matlab "data nahi", neutral NAHI)
```
`range` = "kitna move = full strong signal". Saari ranges [modelConfig.ts](backend/src/modelConfig.ts) mein hain, **haath se chuni hui**, data se fit nahi.

---

## 6. Feature ke 3 role

| Role | Matlab |
|---|---|
| **direction** | Score badalta hai. Iska `contribution` (points) sab milke score ke barabar. |
| **risk** | Sirf signal quality badalta hai, direction kabhi nahi. |
| **context** | Sirf dikhata hai. Score aur quality pe zero asar. |

Naye features pehle **context** mein aate hain. Backtest / forward record proof de tab direction mein.

---

## 7. Nifty scoring (`scoreNifty`)

**Technical Analyst (weight 30)** — sab ek hi price se bane hain (correlated):
| Input | Range (full strength) |
|---|---|
| Spot vs previous close | ±1.1% |
| EMA 12/26 spread (kal se warm-up) | ±0.35% |
| RSI − 50 | ±20 |
| MACD histogram % | ±0.12% |
| Session momentum (sirf aaj ke candles, last 1 ghanta) | ±0.7% |
Confidence = 25 + 14 × inputs.

**Positioning & Breadth (weight 30):**
| Input | Formula |
|---|---|
| Near-ATM OI flow | ATM ± 5 strikes. Har strike pe ΔOI ko premium ke "bache hue" move se classify karo: residual = (premium change) − delta × spot change − theta × 1 din. Put writing / call buying / call short covering / put long unwinding = +; baaki = −. Flow = Σ(sign × \|ΔOI\|) ÷ Σ\|ΔOI\|. Range ±0.6. |
| Advance/decline | (advancers − decliners) ÷ stocks. Range ±0.5. |
Confidence = 25 + 20 × inputs.

> Kyun delta adjust? Bina iske, Nifty 1.3% chadha toh saare calls mehenge + puts saste → sab "bullish flow" → +1.00, jo bas price ka echo tha. Adjust karne ke baad +0.13 aaya.

**News Sentiment (weight 22)** — word-list score, confidence = headlines × 3 + sources × 4 (max 82). AI score yahan **nahi** jaata.

**Risk Manager (weight 0)** — VIX change (±7%), ATM IV (18 se kam = achha, ±9), ATM spread (1.2% se kam = achha). Sirf quality.

**Context:** PCR (all + near-ATM), aggregate OI change, max pain, support/resistance zones, IV skew, days to expiry, futures VWAP distance, relative volume, gap, ATR, regime, above-VWAP %, concentration, sectors, Bank Nifty vs Nifty, global cues, FII/DII.

## 8. Crypto scoring (`scoreCrypto`)

- **Technical (30):** BTC 24h (±3.5%), ETH 24h (±4%), EMA (±1.2%), RSI (±20), MACD (±0.3%), 12h momentum (±3%). Confidence 20 + 12 × inputs.
- **Breadth (30):** top-10 green ratio − 0.5 (±0.35).
- **Sentiment (22):** news + Fear & Greed (−50, ±32) — sirf asli index. Proxy score nahi hota (warna same cheez do baar gin jaati).
- **Risk (0):** spread, hourly volatility.
- **Context:** market cap, **dominance** (market direction + ETH/BTC ke saath padha jaata hai — girta dominance girte market mein bullish nahi), 1h/4h return, regime, funding + percentile, OI change, premium, order book.

---

## 9. Final score, verdict, quality, probability

```
analyst score = 100 × average(uske direction inputs)
final score   = Σ(score × weight × confidence) ÷ Σ(weight × confidence)   (sirf jinke paas data hai)
input ka contribution = 100 × input × (analyst ka share) ÷ analyst ke inputs   → sab milke = score
```
| Score | Verdict |
|---|---|
| ≥ +30 | BULLISH |
| ≤ −30 | BEARISH |
| beech | NEUTRAL |
| price/technical/positioning kuch nahi | UNAVAILABLE |

**Signal quality** = 28 + 42 × coverage + 15 × agreement + 0.12 × \|score\| + risk adjustment, 28–89 pe cut.

**Heuristic split** (UI pe "uncalibrated" likha): neutral = 52 − 0.7×\|score\| + 0.12×(100 − quality) (10–82), baaki sigmoid(score/16) se bull/bear. Hamesha 100 total.

**Calibrated probability** — 150 non-overlapping resolved outcomes ke baad: pehle ke 70% pe score-bin frequency fit, baad ke 30% pe Brier check. Agar wo training class-frequency forecast se behtar nahi → `no_skill`, kuch nahi dikhaya jaata. Tab tak "Unavailable · n/150".

---

## 10. Prediction aur uska result

**Banana (generation job):**
- Har ghante har market ki 1 prediction. Id = `market:model:ghanta` → duplicate impossible (restart, multiple instance, refresh sab safe).
- **Nifty:** sirf market khula ho, 09:30 ke baad. Target = min(abhi + 3 ghante, 15:30). 60 min se kam bache → skip. Agle din kabhi nahi jaata.
- **Crypto:** target = abhi + 6 ghante (UTC).

**Check karna (evaluation job, har 5 min):**
- Start price = creation time pe closed candle ka close; end = target time pe (Binance 1m ±3 min, Upstox 5m ±10 min, same session).
- Price na mile → pending, retry. 72 ghante baad bhi na mile → `unresolvable`.
- Nifty start aur end alag din ke → `unresolvable`.

**Outcome label (overlap nahi):**
| Return | Label |
|---|---|
| > +0.20% | UP |
| < −0.20% | DOWN |
| baaki (±0.20 shamil) | NEUTRAL |
Sahi = BULLISH↔UP, BEARISH↔DOWN, NEUTRAL↔NEUTRAL. Thresholds env se badal sakte ho (`NIFTY_OUTCOME_UP_PCT` etc.), har prediction apna threshold save karti hai.

**Storage:** `DATABASE_URL` ho toh Postgres (durable), warna JSON file (Render free pe restart pe ud jaati hai). Purani v3 entries `legacy` ban ke rehti hain, score nahi hoti.

**Decision (server pe):**
1. Data nahi → **WAIT FOR DATA**
2. Nifty market band → **WAIT**
3. < 30 non-overlapping outcomes, ya hit-rate ka 95% lower bound ≤ max(33%, always-neutral, majority class) → **PAPER TRADE ONLY**
4. NEUTRAL ya quality < 55 → **WAIT / NO TRADE**
5. Warna → **BULLISH / BEARISH SETUP** (research only)

Event (FOMC, US CPI, RBI MPC) forecast window mein ho → risk warning. Event ko bullish/bearish label nahi diya jaata.

---

## 11. Backtest — sach kya nikla (audit ke baad, 2026-10-11)

Command (dates fix karo taaki dobara chalane pe same result aaye):
```bash
npm run backtest -w backend -- --market crypto --start 2024-10-10 --end 2026-10-10 --out ../docs/backtests
npm run backtest -w backend -- --market nifty  --start 2025-10-10 --end 2026-10-10 --out ../docs/backtests
```
Reports: [docs/backtests/](docs/backtests/) — JSON, Markdown, reliability diagram (SVG). Har report mein data ka sha256, dates, commit likha hota hai.

**Kaise chalta hai:**
- Data ke last 20% = **test** — isko kisi bhi choice ke liye chhua nahi jaata. Pehle 80% = **development**.
- Development ko 5 tukdon mein baanta → 4 **walk-forward folds** (pichhle data pe seekho, agla tukda check karo). Har boundary pe overlapping windows **purge**.
- Har cheez (verdict threshold, logistic weights, scaling, calibration, base rates) sirf training rows se fit.
- Outcome threshold (±0.1% … ±1%) sirf development folds se chuna. "Persistent" tabhi jab 75% folds mein baseline ko haraye.
- Har model aur baseline **same windows, same labels** pe — accuracy, balanced accuracy, macro-F1, confusion, class mix, bootstrap CI.

**Baselines:** majority (training ka sabse common class), always-neutral, momentum (pichhli window ka direction), uniform (1/3 har class), empirical (training ki class frequency).

**Brier score samjho:** teeno class pe (p − y)² ka sum, 0 se 2. Kam = behtar. Sabko 1/3 do toh hamesha **0.667**. Isliye "0.866 → 0.663" koi jeet nahi thi — bas "kuch nahi jaanta" wale forecast ke barabar aaye. Asli bar = **empirical** forecast.

**Result:**
| | Crypto | Nifty |
|---|---|---|
| Development folds mein baseline ko haraya (hand-set) | kisi threshold pe nahi (0/4) | max 2/4 |
| Strongest baseline | Momentum, har threshold pe | mixed |
| Test macro-F1: hand-set vs momentum (±0.2%) | 0.324 vs 0.376 (haara) | 0.326 vs 0.253 (CI mein 0 shamil) |
| Calibrated probability vs class frequency | skill nahi | skill nahi |
| Logistic probability | thodi skill (+1.5 se +8%) ±0.5% se upar — par ye **move kitna bada** hoga bata raha (volatility), direction nahi | skill nahi |
| Trading (compounded, cost ke baad) | test −1.2% (gross +37%), par dev folds mein har baar −35% se −52% | test −1.9%, dev folds −2.7% se +1.1% |

**Matlab:** koi persistent edge nahi. Test period mein kabhi kabhi jeet dikhti hai par development folds usse support nahi karte — isliye use edge nahi maana. App **PAPER TRADE ONLY** pe hi rahega.

Pehle report ki galtiyan jo pakdi gayi: accuracy ko balanced accuracy se compare kiya tha; Brier ko sahi baseline se compare nahi kiya; trading mein % returns ko jod diya tha (compound nahi), alag windows pe trades liye; validation pe tune karke wahi report kiya; dates fix nahi thi. Sab theek kiya — details [MODEL_AUDIT.md](MODEL_AUDIT.md).

---

## 12. Aage kya karna hai (evidence ke basis pe)

1. PAPER TRADE ONLY rakho. Weights abhi mat badlo — koi tuning development folds mein tik nahi rahi.
2. Crypto pe naya model tabhi jab **momentum** ko zyada tar folds mein haraye.
3. Do step ka model try karo (experiment): pehle "move bada hoga ya nahi" (volatility), phir "kis taraf".
4. 6 ghante pe costs (0.2%) saara gross faayda kha jaate hain — trading tabhi socho jab direction ka edge folds mein tike.
5. Har cycle ka option chain, breadth, news snapshot save karo — tab inka bhi backtest hoga. `DATABASE_URL` lagao.
6. Har saal NSE holidays aur event calendar update karo.

> Research tool hai, financial advice nahi. Goal: edge ko **measure** karna, phir dheere dheere badhana.
