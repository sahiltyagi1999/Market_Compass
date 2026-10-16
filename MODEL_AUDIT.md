# Model Audit — research-desk-v4 (2026-10-10)

## Confirmed bugs and fixes

| # | Bug (verified in v3 code) | Fix |
| --- | --- | --- |
| 1 | Outcome rules overlapped: BULLISH correct if > +0.2%, NEUTRAL correct if \|r\| ≤ 0.35%, so +0.25% counted for both. | Mutually exclusive labels: UP if r > +up, DOWN if r < −down, else NEUTRAL (boundaries inclusive to NEUTRAL). Thresholds configurable per market and stored on each prediction. |
| 2 | Predictions were resolved with the price at whatever time a page next loaded, not at the target time (often hours or a day later). | Start and end prices come from the candle close at the creation and target times (Binance 1m, ±3 min; Upstox 5m, ±10 min, same IST session). Missing data keeps a prediction pending; after 72 h it becomes `unresolvable`. |
| 3 | NIFTY 3 h targets after 12:30 resolved against next-day prices; recording window ended 15:15 while the close is 15:30. | Central NSE calendar (09:15–15:30 IST, official 2026 holidays). Targets capped at the close; no forecast with < 60 min left or in the first 15 min. Different-session start/end is `unresolvable`. |
| 4 | Predictions were generated only when someone loaded the dashboard; duplicates were possible across instances; hit rate treated overlapping hourly windows as independent. | Server-side generation each cycle with id `market:model:hourSlot` (insert-if-absent) and a separate 5-minute evaluation job. Headline metrics use non-overlapping windows; raw counts are shown separately. |
| 5 | History in `backend/data/predictions.json` on Render free (ephemeral) — reset on every restart. | Storage adapter: Postgres via `DATABASE_URL` (unique key, conditional resolve) or an atomic JSON file. v3 entries imported as `legacy` (kept, never scored) with a `.v3-backup`. UI and `/api/health` state whether storage is durable. |
| 6 | Flat price series gave RSI = 100 (maximum bullish). | Flat series returns 50. |
| 7 | RSI/EMA/MACD were reported from 15 candles (EMA 26 not even seeded); NIFTY had no warm-up so indicators were missing until ~12:05 IST. | Warm-up minimums (RSI ≥ 42, EMA/MACD ≥ 52 closes) with the previous session prepended; momentum, volatility, ATR and regime use current-session candles only. Candles de-duplicated, sorted, invalid rows dropped, unclosed candles removed. |
| 8 | Evidence list used a separate set of display weights that did not match how the score was computed. | Evidence contributions are the exact decomposition of the score (they sum to it) and each item has a role: direction / risk / context. |
| 9 | Aggregate "put OI up ⇒ bullish" skew and a linear PCR rule drove the options analyst. | PCR, aggregate OI skew and max pain are context only. New near-ATM OI-flow feature classifies OI change by premium change after removing delta × spot change and theta decay (on live data this moved OI flow from +1.00, a pure echo of a 1.3% rally, to +0.13). |
| 10 | Falling BTC dominance was scored as bullish regardless of market direction. | Dominance is context, interpreted with basket direction and ETH/BTC relative strength. |
| 11 | When Fear & Greed was down, a proxy built from already-scored inputs was scored again and labelled as Fear & Greed. | Proxy is labelled "Market mood proxy (not Fear & Greed)" and excluded from the score. |
| 12 | `scaled()` returned NaN for NaN inputs and accepted zero/negative ranges. | Returns `undefined` (missing) for non-finite values or ranges ≤ 0; missing inputs never vote. |
| 13 | The frontend recomputed the research decision with its own rules (and a 15:30 close while the backend used 15:15). | Decision and session are computed once on the server; the UI renders them verbatim. |
| 14 | "Confidence" and the bull/neutral/bear split looked like probabilities. | Renamed "Signal quality (uncalibrated)"; split labelled heuristic; calibrated probability is shown only after 150 independent outcomes, fitted on earlier data and scored on later data. |

Checked and already correct: confidence was clamped to [28, 89]; risk weight 0 never moved direction; analysts without data were excluded; heuristic probabilities always summed to 100.

## Formulas (current)

- `scaled(v, r) = clamp(v / r, −1, 1)`, undefined when `v` is not finite or `r ≤ 0`.
- Analyst score = 100 × mean(normalised direction inputs); confidence = base + perInput × inputs (news: headline count/source diversity).
- Final score = Σ(score × weight × conf) / Σ(weight × conf) over voting analysts; weights 30/30/22/0.
- Contribution of input *i* of analyst *a* = 100 × nᵢ × (wₐcₐ / Σwc) / inputsₐ. Contributions sum to the score.
- Verdict: ≥ +30 BULLISH, ≤ −30 BEARISH, else NEUTRAL; UNAVAILABLE without price/technical/positioning evidence.
- Signal quality = clamp(28 + 42·coverage + 15·agreement + 0.12·|score| + riskAdj, 28, 89), riskAdj = clamp(0.12 × risk score × risk conf/100, −12, 4) or −4 without risk data.
- Near-ATM OI flow = Σ signed |ΔOI| / Σ |ΔOI| over ATM ± 5 strikes, sign from the residual premium change (premium Δ − δ·ΔS − θ·days).
- Decision gate: setups require ≥ 30 non-overlapping outcomes and a Wilson 95% lower bound above max(1/3, always-neutral hit rate), plus signal quality ≥ 55.

## Features

Implemented: strike-wise options (ATM, nearby PCR, OI zones, IV skew, days to expiry, local max pain, delta-adjusted OI flow); Nifty 50 breadth (A/D, % above VWAP, concentration, sector indices, Bank Nifty relative); near-month futures VWAP distance and relative volume; opening gap, ATR, efficiency-ratio regime; GIFT Nifty, US 30 futures, USD/INR, Brent; previous-session FII/DII; BTC 1h/4h returns; funding rate and 30-day percentile, futures OI change, perp premium (Binance → OKX); spot order-book imbalance; official FOMC/CPI/RBI event calendar; per-source freshness, stale exclusion and provider health; 15-minute locked snapshots.

Scored vs context: only A/D breadth and OI flow were added to the score (both replace weaker inputs in the positioning analyst). Every other new feature is context until the backtester or forward record shows it adds information.

Deferred (data limits): historical option chains, breadth and news for replay; US 10Y yield (no free real-time source); liquidations (no complete free feed); on-chain metrics; same-time-of-day relative volume for the index itself (index has no volume; futures proxy used); RBI announcement time (not published in the schedule).

## Evaluation audit (2026-10-11)

The first backtest report (2026-10-10) was re-examined before any tuning. Production scoring was **not** changed. Every figure below comes from the reproducible runs in [docs/backtests/](docs/backtests/) (data pinned by date and sha256; see each `.md` for fingerprints).

### Confirmed evaluation bugs (fixed)

| # | Problem in the 2026-10-10 report | Effect | Fix |
|---|---|---|---|
| E1 | Summary compared crypto model **accuracy** (34.1%) with momentum **balanced accuracy** (35.8%). | Apples-to-oranges claim. | Every classifier and baseline now reports accuracy, balanced accuracy, macro-F1, per-class precision/recall/F1, confusion matrix, actual and predicted class mix and intervals on the identical windows and labels. |
| E2 | "Calibration clearly improves (Brier 0.866 → 0.663)". The metric was the standard summed 3-class Brier (0–2, lower better), but it was only compared with the uncalibrated heuristic. A uniform 1/3 forecast scores 0.667 and the training class frequencies scored 0.671 on that test. | The "improvement" was matching a no-information forecast, not skill. | Uniform and empirical (training class-frequency) baselines, Brier skill vs empirical with paired bootstrap intervals, log loss, Murphy decomposition (reliability / resolution / uncertainty), class-wise reliability diagrams, and ROC AUC for discrimination. |
| E3 | Trading "net −74.9%" was the **sum** of per-trade % returns, from trades picked greedily among directional calls (a different window set than the classification metrics), with a validation-tuned threshold; no drawdown, exposure or benchmark. | Not an equity return; not comparable to anything. | Documented simulator ([trading.ts](backend/src/backtest/trading.ts)): one decision per non-overlapping evaluation window, long/short/flat, entry at decision close, exit at target close, 100% equity compounded, flat round-trip cost; reports gross/net compounded and additive returns, max drawdown, win rate, average win/loss, profit factor, exposure, turnover, costs, cost sensitivity, and no-trade / always-long / buy-and-hold benchmarks. |
| E4 | Verdict threshold tuned on the validation split and validation metrics then reported for it; ablation run on the same split. | Optimistic validation numbers. | Thresholds are fitted on training rows; selection uses walk-forward folds; ablation uses the last development fold only; the final test is scored once. |
| E5 | `end = Date.now()`; no recorded split dates, data fingerprints or commit. | Not reproducible. | `--start/--end` pinning, sha256 per series, git commit/dirty flag, exact command, split date ranges and exclusion counts in every artifact. |
| E6 | Single chronological split. | No evidence of persistence. | Expanding walk-forward (4 folds) on development data, purged at every boundary; "persistent" requires positive mean lift and wins in ≥ 75% of folds. |
| E7 | Live app would show calibrated probabilities whenever 150 outcomes existed, even without skill. | Could present no-skill numbers as calibrated. | New `no_skill` status: calibrated probabilities are shown only if held-out Brier beats the training class-frequency forecast ([predictionService.ts](backend/src/predictionService.ts)). |
| E8 | Live decision gate compared hit rate only with chance and always-neutral. | A model that just matches the majority class could pass. | Gate also requires beating the majority-class hit rate on the same sample ([decision.ts](backend/src/decision.ts)). |

Checked and correct: Brier formula (standard multiclass), class ordering (probabilities keyed by class name), calibration fitted on training windows only and scored on later windows, non-overlap selection identical for model and baselines, UNAVAILABLE never scored or traded.

### Methodological limitations (not bugs)

- Replay covers price-derived inputs only (crypto: technicals, breadth, Fear & Greed; NIFTY: technicals and VIX). Options, breadth, news and derivatives have no stored history.
- NIFTY has ~1 year: 98 independent test windows, so intervals are wide.
- Class mix drifts over time (crypto ±0.2%: development U40/N22/D38 vs test U36/N29/D35), so even the empirical forecast loses to uniform on that test.
- Macro-F1 rewards predicting all classes; constant baselines score F1 = 0 on two classes. Balanced accuracy, macro-F1 and momentum comparisons must be read together.
- Bootstrap intervals treat non-overlapping windows as independent; regime persistence makes them somewhat too narrow.
- Two test evaluations were reported per market (pre-registered ±0.2% and the development-selected threshold); no other test use.
- Trading assumes execution at the decision close and flat costs; no funding, borrow, latency or market impact.

### Baseline definitions

majority = most frequent training class; always-neutral; momentum = sign of the previous window's return beyond ±t%; uniform = 1/3 each; empirical = Laplace-smoothed training class frequencies. All are fitted on the same training rows as the models.

### Threshold sensitivity (development walk-forward only)

Mean over 4 folds; lift = model macro-F1 − best of majority / always-neutral / momentum in the same fold.

| Market | t | Dev label mix U/N/D | Hand-set F1 | Logistic F1 | Momentum F1 | Hand-set lift (folds > 0) | Logistic lift (folds > 0) | Hand-set abstain | Brier skill vs empirical: calibrated / logistic |
|---|---|---|---|---|---|---|---|---|---|
| Crypto | 0.1% | 45/12/43 | 0.272 | 0.305 | 0.354 | −0.081 (0/4) | −0.049 (0/4) | 41% | −0.004 / −0.007 |
| Crypto | 0.2% | 40/22/38 | 0.290 | 0.290 | 0.356 | −0.066 (0/4) | −0.066 (0/4) | 49% | −0.001 / +0.001 |
| Crypto | 0.3% | 35/32/33 | 0.285 | 0.344 | 0.354 | −0.069 (0/4) | −0.010 (2/4) | 46% | +0.001 / +0.012 |
| Crypto | 0.5% | 27/48/25 | 0.304 | 0.301 | 0.373 | −0.069 (0/4) | −0.072 (0/4) | 54% | +0.001 / +0.032 |
| Crypto | 0.75% | 19/63/18 | 0.304 | 0.298 | 0.370 | −0.066 (0/4) | −0.072 (0/4) | 54% | −0.006 / +0.037 |
| Crypto | 1% | 14/73/13 | 0.331 | 0.319 | 0.374 | −0.042 (0/4) | −0.054 (0/4) | 60% | −0.018 / +0.048 |
| NIFTY | 0.1% | 35/29/36 | 0.349 | 0.314 | 0.386 | −0.037 (1/4) | −0.072 (0/4) | 29% | −0.019 / +0.010 |
| NIFTY | 0.2% | 23/51/26 | 0.324 | 0.202 | 0.307 | +0.017 (2/4) | −0.105 (0/4) | 26% | −0.006 / +0.019 |
| NIFTY | 0.3% | 16/66/18 | 0.294 | 0.254 | 0.317 | −0.023 (2/4) | −0.062 (0/4) | 53% | −0.006 / −0.023 |
| NIFTY | 0.5% | 7/85/8 | 0.254 | 0.296 | 0.360 | −0.110 (1/4) | −0.068 (0/4) | 32% | −0.003 / +0.016 |

Wider thresholds move most windows into NEUTRAL (crypto 22% → 73%, NIFTY 51% → 85%), raise the hand-set abstention rate and make constant-NEUTRAL baselines look accurate. **No threshold gives the hand-set or logistic model a persistent lift over the best baseline** (best: NIFTY ±0.2%, 2/4 folds). The rule picked crypto ±1% and NIFTY ±0.2% as the least-bad options. On crypto, momentum is the strongest baseline at every threshold. Hand-set balanced accuracy beat both momentum and chance in at most 2/4 folds at any threshold.

The only consistent positive signal is **logistic probability skill on crypto at t ≥ 0.5%** (Brier skill vs empirical positive in 4/4 folds, +1.5% to +8.2%). Its largest standardised coefficients are ATR and realised volatility with the same sign for UP and DOWN and the opposite sign for NEUTRAL, so it forecasts *move size*, not direction.

### Untouched test results

Fitted once on all development data; test windows never used for any choice.

**Crypto** (test 2026-05-17 → 2026-10-10, 582 non-overlapping 6 h windows; verdict threshold ±50 fitted on development)

| t | Classifier | Accuracy [Wilson] | Balanced acc [boot] | Macro-F1 [boot] | Predicted U/N/D |
|---|---|---|---|---|---|
| 0.2% (pre-registered; actual 36/29/35) | hand-set | 36.4% [33, 40] | 0.390 [0.360, 0.423] | 0.324 [0.286, 0.360] | 8/72/20 |
| | logistic | 35.4% [32, 39] | 0.333 [0.301, 0.362] | 0.264 [0.233, 0.293] | 72/0/28 |
| | majority (UP) | 35.6% [32, 40] | 0.333 | 0.175 | 100/0/0 |
| | always-neutral | 29.2% [26, 33] | 0.333 | 0.151 | 0/100/0 |
| | momentum | 37.6% [34, 42] | 0.376 [0.337, 0.416] | 0.376 [0.337, 0.416] | 36/29/35 |
| 1% (selected; actual 11/80/10) | hand-set | 66.5% [63, 70] | 0.447 [0.394, 0.505] | 0.429 [0.379, 0.478] | 8/72/20 |
| | logistic | 79.4% [76, 82] | 0.337 [0.330, 0.350] | 0.305 [0.290, 0.329] | 1/99/0 |
| | majority / always-neutral | 79.5% [76, 83] | 0.333 | 0.295 | 0/100/0 |
| | momentum | 68.0% [64, 72] | 0.375 [0.332, 0.418] | 0.375 [0.331, 0.417] | 11/80/10 |

Paired macro-F1 lift, hand-set − momentum: −0.052 [−0.100, −0.010] at ±0.2%; +0.054 [+0.005, +0.105] at ±1%. The ±1% test win contradicts all four development folds (0/4) and the ±0.2% loss, so it is treated as a period effect, not an edge.

**NIFTY** (test 2026-07-31 → 2026-10-09, 98 non-overlapping windows ≤ 3 h; ±0.2% pre-registered and selected; actual 21/48/31; verdict ±20)

| Classifier | Accuracy [Wilson] | Balanced acc [boot] | Macro-F1 [boot] | Predicted U/N/D |
|---|---|---|---|---|
| hand-set | 34.7% [26, 45] | 0.329 [0.231, 0.425] | 0.326 [0.229, 0.417] | 24/40/36 |
| logistic | 48.0% [38, 58] | 0.333 | 0.216 | 0/100/0 |
| majority / always-neutral | 48.0% [38, 58] | 0.333 | 0.216 | 0/100/0 |
| momentum | 44.9% [35, 55] | 0.325 [0.278, 0.375] | 0.253 [0.191, 0.326] | 7/88/5 |

Hand-set − momentum macro-F1: +0.073 [−0.030, +0.175]; balanced accuracy is at chance.

### Probability quality (standard multiclass Brier: Σ over 3 classes of (p − y)², range 0–2, lower is better; uniform = 0.667; log loss uniform = ln 3 = 1.099)

| Market, t | Heuristic | Score-calibrated | Logistic | Uniform | Empirical | Calibrated − empirical [boot] | Logistic − empirical [boot] |
|---|---|---|---|---|---|---|---|
| Crypto 0.2% | 0.820 | 0.675 | 0.661 | 0.667 | 0.671 | +0.004 [−0.002, +0.009] | −0.010 [−0.016, −0.004] |
| Crypto 1% | 0.824 | 0.355 | 0.341 | 0.667 | 0.352 | +0.003 [−0.003, +0.009] | −0.011 [−0.020, −0.003] |
| NIFTY 0.2% | 0.758 | 0.620 | 0.627 | 0.667 | 0.634 | −0.014 [−0.043, +0.015] | −0.007 [−0.017, +0.004] |

The heuristic split is significantly worse than every baseline (poor reliability). Score calibration does not beat class frequencies. Logistic beats them slightly on crypto (consistent with development) but not on NIFTY. Discrimination (ROC AUC) of the hand-set score is 0.51–0.55, close to none; logistic reaches 0.64 for UP at ±1% crypto (move-size information). Reliability diagrams: [crypto ±0.2%](docs/backtests/crypto-2024-10-10_2026-10-10-reliability-0.2.svg), [crypto ±1%](docs/backtests/crypto-2024-10-10_2026-10-10-reliability-1.svg), [NIFTY ±0.2%](docs/backtests/nifty-2025-10-10_2026-10-10-reliability-0.2.svg).

### Trading (documented simulator; compounded)

| Market | Strategy | Trades | Win rate | Gross | Net | Max DD | Profit factor | Benchmarks (net) |
|---|---|---|---|---|---|---|---|---|
| Crypto (0.20% round trip) | hand-set | 165 (46L/119S) | 46.1% | +37.4% | −1.2% | 18.8% | 1.00 | buy & hold +5.1%; always-long same windows −67.2%; no trade 0% |
| | momentum (±0.2%) | 412 | 38.1% | +44.5% | −36.6% | 41.4% | 0.74 | |
| NIFTY (0.05% round trip) | hand-set | 59 (24L/35S) | 47.5% | +1.1% | −1.9% | 4.7% | 0.77 | buy & hold −7.5%; always-long −7.1%; no trade 0% |

Crypto hand-set net at 0 / 0.05 / 0.1 / 0.2 / 0.3% cost: +37.4 / +26.6 / +16.6 / −1.2 / −16.2%. But across the four development folds its gross return was −19.8%, +2.0%, −10.7%, −4.1% and net −35% to −52% (±0.2%), so the test-period gross gain does not persist. NIFTY development folds: gross +0.1% to +4.1%, net −2.7% to +1.1%. No configuration shows a reliable net edge; none beats no-trade after costs across folds.

### Reproduce

```bash
npm test                                   # 119 backend + 7 frontend tests
npm run typecheck && npm run build
npm run backtest -w backend -- --market crypto --start 2024-10-10 --end 2026-10-10 --out ../docs/backtests
npm run backtest -w backend -- --market nifty  --start 2025-10-10 --end 2026-10-10 --out ../docs/backtests   # needs UPSTOX_ANALYTICS_TOKEN
```

Artifacts: `docs/backtests/<market>-<start>_<end>.{json,md}` and reliability SVGs. Runs take about 90 s (crypto) and 5 s (NIFTY); identical inputs reproduce identical metrics (bootstrap seed 20261011). The 2026-10-11 runs used commit 7f504d9 plus uncommitted working-tree changes (recorded as dirty).

## Tests and checks

- Backend: 119 vitest tests, including: macro-F1, class distributions, standard Brier (uniform = 2/3, log loss = ln 3), Murphy decomposition, ROC AUC with ties, seeded bootstrap reproducibility, same-window baseline comparison, training-only fitting, walk-forward and test purging, **test-outcome tampering leaves threshold selection and fitted models unchanged**, trading edge cases (no trades, NEUTRAL/UNAVAILABLE never trade, compounding vs additive, costs, drawdown, overlap rejection, benchmarks), `no_skill` calibration status and the majority-class decision gate.
- Frontend: 7 render tests (adds the `no_skill` display).
- `npm run typecheck` and `npm run build` pass. No linter is configured in this repository.

## Remaining risks

- Thresholds, ranges and weights remain hand-set, and the audit finds no persistent directional edge for them or for a regularised logistic model on the replayed inputs.
- The 2026 NSE holiday list and event calendar are static; add 2027 before January.
- Option-flow interpretation is first-order and has no history to validate against yet.
- JSON storage is not durable on Render free; set `DATABASE_URL`.

## Recommendations (from measured evidence)

1. **Keep PAPER TRADE ONLY.** Neither market shows persistent out-of-sample improvement over baselines, and no strategy beats no-trade after costs across folds.
2. **Do not adopt ±1% (crypto) or retune weights yet.** The only test-period wins contradict development folds.
3. **Use momentum as the bar on crypto.** It is the strongest baseline at every threshold; any new model must beat it in most walk-forward folds.
4. **Separate move size from direction.** The one consistent signal is logistic probability skill driven by volatility; test a two-stage design (P(|move| > t), then direction) as an experiment only.
5. **Costs dominate at 6 h.** Crypto hand-set gross gains are erased at 0.2% round trip; only revisit trading after a directional edge persists across folds at realistic costs.
6. **Collect missing history.** Store option-chain, breadth and news snapshots each cycle so the untested NIFTY features can be backtested; configure Postgres so the forward record accumulates.
