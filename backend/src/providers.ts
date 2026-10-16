import { enrichNewsWithAi } from './aiNews.js';
import { fetchCryptoDerivatives, fetchSpotOrderBookImbalance } from './cryptoData.js';
import { attachEvents } from './events.js';
import { clearHttpCache, errorMessage, fetchJson, fetchJsonMeta, toNumber } from './http.js';
import { calculateTechnicals, returnOverBars } from './indicators.js';
import { istDateKey, isTradingDay, marketStatus, previousTradingDay, sessionBounds } from './marketSession.js';
import { DEFAULT_CONFIG, type ModelConfig } from './modelConfig.js';
import { fetchCryptoNews, fetchNiftyNews, fetchUpstoxNews } from './news.js';
import { fetchGlobalCues, fetchInstitutionalFlows, fetchNiftyBreadth, fetchNiftyFutures } from './niftyData.js';
import { analyseOptionChain, spreadPercent, type UpstoxChainRow } from './optionsAnalysis.js';
import { scoreCrypto, scoreNifty } from './scoring.js';
import { analyseHeadlines, type RawHeadline } from './sentiment.js';
import type { Candle, CryptoSnapshot, MarketCard, NiftySnapshot, SourceStatus } from './types.js';
import { closedCandles, fetchHistoricalCandles, fetchIntradayCandles, fetchLtp, upstoxHeaders, upstoxToken } from './upstox.js';

export { isCryptoHeadlineRelevant, isNiftyHeadlineRelevant, parseRssNews } from './news.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Each scheduled prediction cycle starts from a clean slate. */
export function clearProviderCache() {
  clearHttpCache();
}

/**
 * Builds a source status with freshness. When `maxAgeSeconds` is given and
 * the observation is older, the status is 'stale' and callers must not score it.
 */
export function sourceStatus(
  name: string,
  message: string,
  options: { observedAt?: number; retrievedAt?: number; maxAgeSeconds?: number; optional?: boolean; fromCache?: boolean; now?: number } = {}
): SourceStatus {
  const now = options.now ?? Date.now();
  const ageSeconds = options.observedAt != null ? Math.max(0, Math.round((now - options.observedAt) / 1000)) : undefined;
  const stale = options.maxAgeSeconds != null && ageSeconds != null && ageSeconds > options.maxAgeSeconds;
  return {
    name,
    status: stale ? 'stale' : 'live',
    message: stale ? `${message} Stale: ${Math.round(ageSeconds! / 60)} min old (limit ${Math.round(options.maxAgeSeconds! / 60)} min).` : message,
    optional: options.optional,
    observedAt: options.observedAt != null ? new Date(options.observedAt).toISOString() : undefined,
    retrievedAt: new Date(options.retrievedAt ?? now).toISOString(),
    ageSeconds,
    maxAgeSeconds: options.maxAgeSeconds,
    fromCache: options.fromCache
  };
}

function failed(name: string, error: unknown, fallback: string, optional?: boolean): SourceStatus {
  return { name, status: 'error', message: errorMessage(error, fallback), optional, retrievedAt: new Date().toISOString() };
}

export function calculateMarketMoodProxy(snapshot: CryptoSnapshot) {
  const components = [
    snapshot.btcChangePct == null ? undefined : 50 + snapshot.btcChangePct * 5,
    snapshot.marketCapChangePct == null ? undefined : 50 + snapshot.marketCapChangePct * 5,
    snapshot.breadthPositiveRatio == null ? undefined : snapshot.breadthPositiveRatio * 100,
    snapshot.technical?.rsi,
    snapshot.technical?.emaSpreadPct == null ? undefined : 50 + snapshot.technical.emaSpreadPct * 10,
    snapshot.sentiment == null ? undefined : 50 + snapshot.sentiment.deterministicScore / 2
  ].filter((value): value is number => value != null && Number.isFinite(value));
  if (!components.length) return undefined;
  return Math.round(clamp(components.reduce((sum, value) => sum + clamp(value, 0, 100), 0) / components.length, 0, 100));
}

async function applyAiNews(
  market: 'nifty' | 'crypto',
  snapshot: NiftySnapshot | CryptoSnapshot,
  sources: SourceStatus[],
  marketContext: unknown
) {
  if (!snapshot.sentiment) {
    sources.push({ name: 'OpenAI news analyst', status: 'missing', message: 'No headlines were available for semantic analysis.', optional: true });
    return;
  }
  try {
    const enriched = await enrichNewsWithAi(market, snapshot.sentiment, marketContext);
    snapshot.sentiment = enriched.sentiment;
    snapshot.aiAnalysis = enriched.analysis;
    sources.push(enriched.source);
  } catch (error) {
    sources.push({
      name: 'OpenAI news analyst',
      status: 'error',
      message: `AI unavailable; deterministic fallback active. ${errorMessage(error, 'Analysis failed.')}`,
      optional: true
    });
  }
}

async function fetchNearestExpiry(token: string, instrumentKey: string, now: number) {
  const body = await fetchJson<{ data?: Array<{ expiry?: string }> }>(
    `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`,
    { headers: upstoxHeaders(token) },
    30 * 60 * 1000
  );
  const today = istDateKey(now);
  return [...new Set((body.data || []).map((item) => item.expiry).filter((item): item is string => Boolean(item) && item! >= today))].sort()[0];
}

async function fetchOptionChain(token: string, instrumentKey: string, now: number) {
  const expiry = await fetchNearestExpiry(token, instrumentKey, now);
  if (!expiry) throw new Error('No active expiry returned');
  const fetched = await fetchJsonMeta<{ data?: UpstoxChainRow[] }>(
    `https://api.upstox.com/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${encodeURIComponent(expiry)}`,
    { headers: upstoxHeaders(token) },
    0
  );
  const rows = fetched.value.data || [];
  if (!rows.length) throw new Error(`Option chain is empty for ${expiry}`);
  return { rows, retrievedAt: fetched.retrievedAt, expiry };
}

/** The session the latest data belongs to: today once it has opened, otherwise the previous trading day. */
export function latestSessionDate(now: number) {
  const today = istDateKey(now);
  if (isTradingDay(today) && now >= sessionBounds(today).open) return today;
  return previousTradingDay(today);
}

async function fetchNiftyCandles(token: string, instrumentKey: string, now: number) {
  const session = latestSessionDate(now);
  const warmup = previousTradingDay(session);
  const isToday = session === istDateKey(now);
  const [current, history] = await Promise.all([
    isToday ? fetchIntradayCandles(token, instrumentKey, 5) : Promise.resolve([] as Candle[]),
    fetchHistoricalCandles(token, instrumentKey, warmup, isToday ? warmup : session, 5)
  ]);
  const candles = closedCandles([...history, ...current], 5 * 60_000, now)
    .filter((candle) => [warmup, session].includes(istDateKey(candle.time)));
  return { candles, session, sessionStart: sessionBounds(session).open };
}

async function collectNiftyCard(now: number, config: ModelConfig): Promise<MarketCard> {
  const token = upstoxToken();
  const niftyKey = process.env.UPSTOX_NIFTY_KEY || 'NSE_INDEX|Nifty 50';
  const vixKey = process.env.UPSTOX_VIX_KEY || 'NSE_INDEX|India VIX';
  const sources: SourceStatus[] = [];
  const snapshot: NiftySnapshot = {};
  const newsPromise = fetchNiftyNews();
  const status = marketStatus(now);

  if (!token) {
    sources.push({ name: 'Upstox market desk', status: 'missing', message: 'Add UPSTOX_ANALYTICS_TOKEN for price, candles, VIX, options and breadth.' });
    const news = await newsPromise;
    sources.push(...news.statuses);
    if (news.headlines.length) snapshot.sentiment = analyseHeadlines(news.headlines);
    snapshot.updatedAt = new Date(now).toISOString();
    await applyAiNews('nifty', snapshot, sources, { marketData: 'unavailable', deterministicNewsScore: snapshot.sentiment?.score });
    return scoreNifty(snapshot, sources, { config, now });
  }

  // While the market is open, quotes and candles older than these limits are stale.
  const liveMaxAge = status.open ? 15 * 60 : undefined;
  const [quotes, chain, candles, news, upstoxNews, futures, cues, flows] = await Promise.allSettled([
    fetchLtp(token, [niftyKey, vixKey]),
    fetchOptionChain(token, niftyKey, now),
    fetchNiftyCandles(token, niftyKey, now),
    newsPromise,
    fetchUpstoxNews(token, niftyKey),
    fetchNiftyFutures(token, now),
    fetchGlobalCues(token, now),
    fetchInstitutionalFlows(token, now)
  ]);

  let lastCandleClose: number | undefined;
  if (candles.status === 'fulfilled' && candles.value.candles.length) {
    const { candles: rows, sessionStart, session } = candles.value;
    lastCandleClose = rows[rows.length - 1].time + 5 * 60_000;
    const source = sourceStatus('Upstox 5m candles', `${rows.length} closed candles (session ${session} plus previous-session warm-up).`, { observedAt: lastCandleClose, maxAgeSeconds: liveMaxAge, now });
    sources.push(source);
    if (source.status === 'live') {
      snapshot.technical = calculateTechnicals(rows, { sessionStart });
      snapshot.sessionOpen = rows.find((candle) => candle.time >= sessionStart)?.open;
    }
  } else {
    sources.push(candles.status === 'rejected' ? failed('Upstox 5m candles', candles.reason, 'Candles failed.') : { name: 'Upstox 5m candles', status: 'missing', message: 'No candles returned.' });
  }

  if (quotes.status === 'fulfilled') {
    const nifty = quotes.value.quotes.get(niftyKey);
    const vix = quotes.value.quotes.get(vixKey);
    // LTP has no quote timestamp; the latest closed candle is the freshness proxy during market hours.
    const quoteSource = sourceStatus('Upstox NIFTY quote', 'Spot and previous close loaded (no provider timestamp; freshness checked via latest candle).', {
      observedAt: status.open ? lastCandleClose : undefined,
      retrievedAt: quotes.value.retrievedAt,
      maxAgeSeconds: liveMaxAge,
      now
    });
    if (nifty?.price && quoteSource.status === 'live') {
      snapshot.spot = nifty.price;
      snapshot.previousClose = nifty.previousClose;
      snapshot.updatedAt = new Date(quotes.value.retrievedAt).toISOString();
      sources.push(quoteSource);
    } else sources.push(nifty?.price ? quoteSource : { name: 'Upstox NIFTY quote', status: 'missing', message: 'Quote returned no price.' });
    if (vix?.price) {
      snapshot.vix = vix.price;
      snapshot.vixPreviousClose = vix.previousClose;
      sources.push(sourceStatus('Upstox India VIX', 'Volatility regime loaded.', { retrievedAt: quotes.value.retrievedAt, now }));
    } else sources.push({ name: 'Upstox India VIX', status: 'missing', message: 'VIX returned no price.' });
  } else {
    sources.push(failed('Upstox NIFTY quote', quotes.reason, 'Quote failed.'));
  }

  if (chain.status === 'fulfilled') {
    const { rows, retrievedAt, expiry } = chain.value;
    const underlyingChange = snapshot.spot != null && snapshot.previousClose != null ? snapshot.spot - snapshot.previousClose : undefined;
    const analysis = analyseOptionChain(rows, { expiry, now, underlyingChange, elapsedDays: 1 });
    snapshot.options = analysis.detail;
    // Never let the chain's spot replace a quote that was rejected as stale.
    if (!sources.some((source) => source.name === 'Upstox NIFTY quote' && source.status === 'stale')) snapshot.spot = snapshot.spot ?? analysis.spot;
    snapshot.pcr = analysis.detail.totalPcr ?? undefined;
    snapshot.maxPain = analysis.detail.maxPain ?? undefined;
    snapshot.atmIv = analysis.detail.atmIv ?? undefined;
    snapshot.atmSpreadPercent = analysis.atmSpreadPercent;
    snapshot.callOiChangePercent = analysis.callOiChangePercent;
    snapshot.putOiChangePercent = analysis.putOiChangePercent;
    sources.push(sourceStatus('Upstox option chain', `Expiry ${expiry}: ${analysis.detail.strikesUsed * 2 + 1} near-ATM strikes analysed${analysis.detail.flowAdjusted ? ' (delta/theta-adjusted premiums)' : ' (raw premiums: no spot change available)'}${analysis.rejectedRows ? `, ${analysis.rejectedRows} invalid rows dropped` : ''}.`, { retrievedAt, now }));
  } else sources.push(failed('Upstox option chain', chain.reason, 'Option chain failed.'));

  const changePct = snapshot.spot && snapshot.previousClose ? ((snapshot.spot - snapshot.previousClose) / snapshot.previousClose) * 100 : undefined;
  const breadthResult = await fetchNiftyBreadth(token, changePct).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  if (breadthResult.ok && breadthResult.value.breadth) {
    const source = sourceStatus('Nifty 50 breadth', `${breadthResult.value.breadth.constituents} constituents quoted (list from ${breadthResult.value.source}).`, {
      observedAt: breadthResult.value.observedAt,
      retrievedAt: breadthResult.value.retrievedAt,
      maxAgeSeconds: liveMaxAge,
      optional: true,
      now
    });
    sources.push(source);
    if (source.status === 'live') snapshot.breadth = breadthResult.value.breadth;
  } else sources.push(failed('Nifty 50 breadth', breadthResult.ok ? new Error('No constituent quotes.') : breadthResult.error, 'Breadth failed.', true));

  if (futures.status === 'fulfilled') {
    snapshot.futures = futures.value;
    sources.push(sourceStatus('NIFTY futures (VWAP/volume proxy)', `${futures.value.instrumentKey}: ${futures.value.vwap ? 'session VWAP computed' : 'no session candles yet'}.`, { optional: true, now }));
  } else sources.push(failed('NIFTY futures (VWAP/volume proxy)', futures.reason, 'Futures failed.', true));

  if (cues.status === 'fulfilled' && cues.value.length) {
    snapshot.globalCues = cues.value;
    sources.push(sourceStatus('Upstox global cues', `${cues.value.map((cue) => cue.name).join(', ')} loaded (context only).`, { optional: true, now }));
  } else sources.push(cues.status === 'rejected' ? failed('Upstox global cues', cues.reason, 'Global cues failed.', true) : { name: 'Upstox global cues', status: 'missing', message: 'No global cues returned.', optional: true });

  if (flows.status === 'fulfilled' && flows.value) {
    snapshot.institutionalFlows = flows.value;
    sources.push(sourceStatus('Upstox FII/DII flows', `Cash-market flows for ${flows.value.date} (previous session).`, { optional: true, now }));
  } else sources.push(flows.status === 'rejected' ? failed('Upstox FII/DII flows', flows.reason, 'Flows failed.', true) : { name: 'Upstox FII/DII flows', status: 'missing', message: 'No published flows.', optional: true });

  const rawNews: RawHeadline[] = [];
  if (news.status === 'fulfilled') {
    rawNews.push(...news.value.headlines);
    sources.push(...news.value.statuses);
  } else sources.push(failed('Market news feeds', news.reason, 'News failed.', true));
  if (upstoxNews.status === 'fulfilled') {
    rawNews.push(...upstoxNews.value);
    sources.push(sourceStatus('Upstox instrument news', `${upstoxNews.value.length} token-backed headlines loaded.`, { optional: true, now }));
  } else sources.push(failed('Upstox instrument news', upstoxNews.reason, 'News failed.', true));
  if (rawNews.length) snapshot.sentiment = analyseHeadlines(rawNews, now);
  await applyAiNews('nifty', snapshot, sources, {
    spot: snapshot.spot,
    previousClose: snapshot.previousClose,
    indiaVix: snapshot.vix,
    nearbyPcr: snapshot.options?.nearbyPcr,
    oiFlow: snapshot.options?.oiFlow,
    atmIv: snapshot.atmIv,
    advances: snapshot.breadth?.advances,
    declines: snapshot.breadth?.declines,
    rsi: snapshot.technical?.rsi,
    emaSpreadPct: snapshot.technical?.emaSpreadPct
  });
  snapshot.updatedAt = snapshot.updatedAt || new Date(now).toISOString();
  return scoreNifty(snapshot, sources, { config, now });
}

type CoinGeckoGlobal = { data?: { market_cap_change_percentage_24h_usd?: number; market_cap_percentage?: { btc?: number }; updated_at?: number } };
type BinanceTicker = { symbol?: string; lastPrice?: string; bidPrice?: string; askPrice?: string; priceChangePercent?: string; closeTime?: number };
type FearGreedResponse = { data?: Array<{ value?: string; value_classification?: string; timestamp?: string }> };

async function fetchBinanceTicker(symbol: string) {
  const body = await fetchJson<BinanceTicker>(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`);
  return {
    price: toNumber(body.lastPrice),
    changePct: toNumber(body.priceChangePercent),
    spreadPct: spreadPercent(toNumber(body.bidPrice), toNumber(body.askPrice)),
    observedAt: toNumber(body.closeTime)
  };
}

export function parseBinanceKlines(rows: unknown[][], now: number): Candle[] {
  return rows
    .filter((row) => Number(row[6]) <= now)
    .map((row) => ({
      time: Number(row[0]),
      open: toNumber(row[1]) ?? Number.NaN,
      high: toNumber(row[2]) ?? Number.NaN,
      low: toNumber(row[3]) ?? Number.NaN,
      close: toNumber(row[4]) ?? Number.NaN,
      volume: toNumber(row[5]) ?? 0
    }));
}

async function fetchBinanceCandles(now: number) {
  const rows = await fetchJson<unknown[][]>('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=150');
  return parseBinanceKlines(rows, now);
}

function coingeckoHeaders() {
  const apiKey = process.env.COINGECKO_DEMO_API_KEY;
  return apiKey ? { 'x-cg-demo-api-key': apiKey } : undefined;
}

async function fetchCryptoGlobal() {
  try {
    const body = await fetchJson<CoinGeckoGlobal>('https://api.coingecko.com/api/v3/global', { headers: coingeckoHeaders() });
    const marketCapChangePct = toNumber(body.data?.market_cap_change_percentage_24h_usd);
    const btcDominance = toNumber(body.data?.market_cap_percentage?.btc);
    if (marketCapChangePct == null && btcDominance == null) throw new Error('CoinGecko returned no global metrics.');
    const updated = toNumber(body.data?.updated_at);
    return { marketCapChangePct, btcDominance, source: 'CoinGecko global', observedAt: updated ? updated * 1000 : undefined };
  } catch {
    const body = await fetchJson<Array<{ btc_d?: string | number }>>('https://api.coinlore.net/api/global/');
    const global = body[0];
    if (!global) throw new Error('CoinLore returned no global metrics.');
    // CoinLore's change window disagrees with CoinGecko's, so it never replaces the change input.
    return { marketCapChangePct: undefined, btcDominance: toNumber(global.btc_d), source: 'CoinLore dominance fallback', observedAt: undefined };
  }
}

const BASKET = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT', 'AVAXUSDT', 'LINKUSDT'];

async function fetchCryptoBreadth() {
  const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(BASKET))}`;
  const body = await fetchJson<BinanceTicker[]>(url);
  const moves = body.map((ticker) => toNumber(ticker.priceChangePercent)).filter((value): value is number => value != null);
  if (!moves.length) throw new Error('Binance returned no breadth metrics.');
  return { moves, source: 'Binance fixed-basket breadth' };
}

async function collectCryptoCard(now: number, config: ModelConfig): Promise<MarketCard> {
  const sources: SourceStatus[] = [];
  const snapshot: CryptoSnapshot = {};
  const [tickers, global, basket, candles, fearGreed, news, derivatives, book] = await Promise.allSettled([
    Promise.all([fetchBinanceTicker('BTCUSDT'), fetchBinanceTicker('ETHUSDT')]),
    fetchCryptoGlobal(),
    fetchCryptoBreadth(),
    fetchBinanceCandles(now),
    fetchJson<FearGreedResponse>('https://api.alternative.me/fng/?limit=1&format=json'),
    fetchCryptoNews(),
    fetchCryptoDerivatives(),
    fetchSpotOrderBookImbalance()
  ]);

  if (tickers.status === 'fulfilled') {
    const [btc, eth] = tickers.value;
    const source = sourceStatus('Binance public tickers', 'BTC and ETH 24h market data loaded.', { observedAt: btc.observedAt, maxAgeSeconds: 5 * 60, now });
    sources.push(source);
    if (source.status === 'live') {
      snapshot.btcPrice = btc.price;
      snapshot.btcChangePct = btc.changePct;
      snapshot.btcSpreadPercent = btc.spreadPct;
      snapshot.ethPrice = eth.price;
      snapshot.ethChangePct = eth.changePct;
      snapshot.ethSpreadPercent = eth.spreadPct;
      snapshot.updatedAt = new Date(btc.observedAt ?? now).toISOString();
    }
  } else sources.push(failed('Binance public tickers', tickers.reason, 'Ticker fetch failed.'));

  if (global.status === 'fulfilled') {
    snapshot.marketCapChangePct = global.value.marketCapChangePct;
    snapshot.btcDominance = global.value.btcDominance;
    sources.push(sourceStatus(global.value.source, 'Global context loaded (context only).', { observedAt: global.value.observedAt, maxAgeSeconds: 60 * 60, optional: true, now }));
  } else sources.push(failed('CoinGecko global', global.reason, 'Global data failed.', true));

  if (basket.status === 'fulfilled') {
    const moves = basket.value.moves;
    snapshot.breadthPositiveRatio = moves.filter((value) => value > 0).length / moves.length;
    snapshot.basketAverageChangePct = moves.reduce((sum, value) => sum + value, 0) / moves.length;
    sources.push(sourceStatus(basket.value.source, `${moves.length} large-cap assets analysed.`, { now }));
  } else sources.push(failed('Binance fixed-basket breadth', basket.reason, 'Breadth failed.'));

  if (candles.status === 'fulfilled' && candles.value.length) {
    const rows = candles.value;
    const lastClose = rows[rows.length - 1].time + 60 * 60_000;
    const source = sourceStatus('Binance hourly candles', `${rows.length} closed BTC candles analysed.`, { observedAt: lastClose, maxAgeSeconds: 2 * 60 * 60, now });
    sources.push(source);
    if (source.status === 'live') {
      snapshot.technical = calculateTechnicals(rows);
      snapshot.btcReturn1hPct = returnOverBars(rows, 1);
      snapshot.btcReturn4hPct = returnOverBars(rows, 4);
    }
  } else sources.push(candles.status === 'rejected' ? failed('Binance hourly candles', candles.reason, 'Candles failed.') : { name: 'Binance hourly candles', status: 'missing', message: 'No candles returned.' });

  if (fearGreed.status === 'fulfilled' && toNumber(fearGreed.value.data?.[0]?.value) != null) {
    const row = fearGreed.value.data![0];
    const observedAt = toNumber(row.timestamp) ? toNumber(row.timestamp)! * 1000 : undefined;
    const source = sourceStatus('Alternative.me Fear & Greed', 'Daily index loaded (attribution: alternative.me).', { observedAt, maxAgeSeconds: 48 * 60 * 60, optional: true, now });
    sources.push(source);
    if (source.status === 'live') {
      snapshot.fearGreed = toNumber(row.value);
      snapshot.fearGreedLabel = row.value_classification;
    }
  } else sources.push(fearGreed.status === 'rejected' ? failed('Alternative.me Fear & Greed', fearGreed.reason, 'Sentiment gauge failed.', true) : { name: 'Alternative.me Fear & Greed', status: 'missing', message: 'No index value returned.', optional: true });

  if (news.status === 'fulfilled') {
    if (news.value.headlines.length) snapshot.sentiment = analyseHeadlines(news.value.headlines, now);
    sources.push(...news.value.statuses);
  } else sources.push(failed('Crypto news feeds', news.reason, 'News failed.', true));

  if (derivatives.status === 'fulfilled') {
    snapshot.derivatives = { ...derivatives.value, orderBookImbalance: book.status === 'fulfilled' ? book.value : null };
    sources.push(sourceStatus(derivatives.value.source, 'Funding, open interest and premium loaded (context only).', { optional: true, now }));
  } else {
    if (book.status === 'fulfilled') snapshot.derivatives = { source: 'Binance spot order book', fundingRatePct: null, fundingPercentile: null, openInterest: null, openInterestChangePct: null, basisPct: null, orderBookImbalance: book.value };
    sources.push(failed('Crypto derivatives', derivatives.reason, 'Derivatives failed.', true));
  }

  if (snapshot.fearGreed == null) {
    const proxy = calculateMarketMoodProxy(snapshot);
    if (proxy != null) {
      snapshot.fearGreed = proxy;
      snapshot.fearGreedLabel = 'Market data proxy';
      snapshot.fearGreedIsProxy = true;
      sources.push({ name: 'Market mood proxy', status: 'live', message: 'Fear & Greed unavailable; a local proxy is shown but not scored (its inputs are already scored).', optional: true });
    }
  }

  await applyAiNews('crypto', snapshot, sources, {
    btcPrice: snapshot.btcPrice,
    btcChangePct24h: snapshot.btcChangePct,
    btcReturn4hPct: snapshot.btcReturn4hPct,
    ethChangePct24h: snapshot.ethChangePct,
    breadthPositiveRatio: snapshot.breadthPositiveRatio,
    fearGreed: snapshot.fearGreedIsProxy ? undefined : snapshot.fearGreed,
    fundingRatePct: snapshot.derivatives?.fundingRatePct,
    rsi: snapshot.technical?.rsi,
    emaSpreadPct: snapshot.technical?.emaSpreadPct,
    realisedVolatilityPct: snapshot.technical?.volatilityPct
  });

  snapshot.updatedAt = snapshot.updatedAt || new Date(now).toISOString();
  return scoreCrypto(snapshot, sources, { config, now });
}

const providerHealth = new Map<string, { failures: number; lastStatus: string; lastMessage: string; lastSuccessAt?: string; lastFailureAt?: string }>();

function trackHealth(cards: MarketCard[]) {
  for (const source of cards.flatMap((card) => card.sources)) {
    const entry = providerHealth.get(source.name) ?? { failures: 0, lastStatus: '', lastMessage: '' };
    entry.lastStatus = source.status;
    entry.lastMessage = source.message;
    if (source.status === 'live') entry.lastSuccessAt = source.retrievedAt;
    else if (source.status === 'error' || source.status === 'stale') {
      entry.failures += 1;
      entry.lastFailureAt = new Date().toISOString();
    }
    providerHealth.set(source.name, entry);
  }
}

export function getProviderHealth() {
  return Object.fromEntries(providerHealth);
}

export async function buildCards(now = Date.now(), config: ModelConfig = DEFAULT_CONFIG) {
  const cards = await Promise.all([collectNiftyCard(now, config), collectCryptoCard(now, config)]);
  for (const card of cards) attachEvents(card, now);
  trackHealth(cards);
  return cards;
}
