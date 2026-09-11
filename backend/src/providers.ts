import { calculateTechnicals } from './indicators.js';
import { enrichNewsWithAi } from './aiNews.js';
import { attachTrackRecords } from './predictionStore.js';
import { scoreCrypto, scoreNifty } from './scoring.js';
import { analyseHeadlines, type RawHeadline } from './sentiment.js';
import type { Candle, CryptoSnapshot, DashboardResponse, NiftySnapshot, SourceStatus } from './types.js';

type QuotePayload = {
  data?: Record<string, {
    last_price?: number;
    cp?: number;
    timestamp?: string;
  }>;
};

type UpstoxStrike = {
  strike_price?: number;
  underlying_spot_price?: number;
  call_options?: {
    market_data?: { oi?: number; prev_oi?: number; bid_price?: number; ask_price?: number };
    option_greeks?: { iv?: number };
  };
  put_options?: {
    market_data?: { oi?: number; prev_oi?: number; bid_price?: number; ask_price?: number };
    option_greeks?: { iv?: number };
  };
};

type CoinGeckoGlobal = {
  data?: {
    market_cap_change_percentage_24h_usd?: number;
    market_cap_percentage?: { btc?: number };
    updated_at?: number;
  };
};

type CoinGeckoCoin = {
  price_change_percentage_24h_in_currency?: number;
  last_updated?: string;
};

type BinanceTicker = {
  symbol?: string;
  lastPrice?: string;
  bidPrice?: string;
  askPrice?: string;
  priceChangePercent?: string;
  closeTime?: number;
};

type CoinLoreGlobal = {
  mcap_change?: string | number;
  btc_d?: string | number;
};

type NewsBundle = {
  headlines: RawHeadline[];
  statuses: SourceStatus[];
};

type FearGreedResponse = {
  data?: Array<{ value?: string; value_classification?: string; timestamp?: string }>;
};

type UpstoxNewsResponse = {
  data?: Record<string, Array<{
    heading?: string;
    summary?: string;
    article_link?: string;
    published_time?: number;
  }>>;
};

const cache = new Map<string, { expiresAt: number; value: unknown }>();

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function spreadPercent(bid?: number, ask?: number) {
  if (!bid || !ask || ask < bid) return undefined;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? ((ask - bid) / midpoint) * 100 : undefined;
}

async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value as T;
  const value = await loader();
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

async function fetchJson<T>(url: string, init?: RequestInit, ttlMs = 0): Promise<T> {
  return cached(url, ttlMs, async () => {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
  });
}

async function fetchText(url: string, ttlMs = 0) {
  return cached(url, ttlMs, async () => {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'MarketCompassIndia/1.0 (+local research dashboard)' }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  });
}

function upstoxHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function applyAiNews(
  market: 'nifty' | 'crypto',
  snapshot: NiftySnapshot | CryptoSnapshot,
  sources: SourceStatus[],
  marketContext: unknown
) {
  if (!snapshot.sentiment) {
    sources.push({
      name: 'OpenAI news analyst',
      status: 'missing',
      message: 'No headlines were available for semantic analysis.',
      optional: true
    });
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

function decodeXml(value: string) {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, entity: string) => entities[entity] ?? match)
    .trim();
}

function xmlTag(item: string, tag: string) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

export function parseRssNews(xml: string, fallbackSource: string): RawHeadline[] {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    const published = xmlTag(item, 'pubDate') || xmlTag(item, 'dc:date');
    const date = new Date(published || Date.now());
    return {
      title: xmlTag(item, 'title').replace(/<[^>]+>/g, '').trim(),
      source: xmlTag(item, 'source') || fallbackSource,
      url: xmlTag(item, 'link'),
      publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
    };
  }).filter((item) => item.title && item.url);
}

async function fetchRssNews(url: string, source: string) {
  return parseRssNews(await fetchText(url, 5 * 60 * 1000), source);
}

async function fetchNewsBundle(feeds: Array<{ name: string; loader: () => Promise<RawHeadline[]> }>): Promise<NewsBundle> {
  const settled = await Promise.allSettled(feeds.map((feed) => feed.loader()));
  const statuses: SourceStatus[] = [];
  const groups: RawHeadline[][] = [];
  settled.forEach((result, index) => {
    const name = feeds[index].name;
    if (result.status === 'fulfilled' && result.value.length) {
      groups.push(result.value);
      statuses.push({ name, status: 'live', message: `${result.value.length} headlines loaded.`, optional: true });
    } else {
      statuses.push({
        name,
        status: result.status === 'fulfilled' ? 'missing' : 'error',
        message: result.status === 'fulfilled' ? 'No current headlines returned.' : errorMessage(result.reason, 'Feed failed.'),
        optional: true
      });
    }
  });

  const cutoff = Date.now() - 4 * 24 * 60 * 60 * 1000;
  const headlines: RawHeadline[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest && headlines.length < 45; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (!item || new Date(item.publishedAt).getTime() < cutoff) continue;
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      headlines.push(item);
    }
  }
  return { headlines, statuses };
}

async function fetchGoogleNews(query: string, locale: 'IN' | 'US'): Promise<RawHeadline[]> {
  const language = locale === 'IN' ? 'en-IN' : 'en-US';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${language}&gl=${locale}&ceid=${locale}:en`;
  const xml = await fetchText(url, 5 * 60 * 1000);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 30).map((match) => {
    const item = match[1];
    const source = xmlTag(item, 'source') || 'Google News';
    const fullTitle = xmlTag(item, 'title');
    const suffix = ` - ${source}`;
    return {
      title: fullTitle.endsWith(suffix) ? fullTitle.slice(0, -suffix.length) : fullTitle,
      source,
      url: xmlTag(item, 'link'),
      publishedAt: new Date(xmlTag(item, 'pubDate') || Date.now()).toISOString()
    };
  }).filter((item) => item.title && item.url);
}

function fetchNiftyNews() {
  return fetchNewsBundle([
    { name: 'Yahoo Finance NIFTY RSS', loader: () => fetchRssNews('https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENSEI&region=IN&lang=en-IN', 'Yahoo Finance') },
    { name: 'Economic Times Markets RSS', loader: () => fetchRssNews('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times') },
    { name: 'Google News RSS', loader: () => fetchGoogleNews('(NIFTY 50 OR Sensex OR NSE OR India VIX) when:2d', 'IN') }
  ]);
}

function fetchCryptoNews() {
  return fetchNewsBundle([
    { name: 'Yahoo Finance Bitcoin RSS', loader: () => fetchRssNews('https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US', 'Yahoo Finance') },
    { name: 'CoinDesk RSS', loader: () => fetchRssNews('https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk') },
    { name: 'Cointelegraph RSS', loader: () => fetchRssNews('https://cointelegraph.com/rss', 'Cointelegraph') },
    { name: 'Google News RSS', loader: () => fetchGoogleNews('(Bitcoin OR Ethereum OR cryptocurrency) when:2d', 'US') }
  ]);
}

async function fetchUpstoxNews(token: string, instrumentKey: string): Promise<RawHeadline[]> {
  const url = `https://api.upstox.com/v2/news?category=instrument_keys&instrument_keys=${encodeURIComponent(instrumentKey)}&page_size=30`;
  const body = await fetchJson<UpstoxNewsResponse>(url, { headers: upstoxHeaders(token) }, 5 * 60 * 1000);
  return Object.values(body.data || {}).flat().map((item) => ({
    title: item.heading || item.summary || '',
    source: 'Upstox News',
    url: item.article_link || '',
    publishedAt: new Date(item.published_time || Date.now()).toISOString()
  })).filter((item) => item.title && item.url);
}

async function fetchUpstoxQuote(token: string, instrumentKey: string) {
  const body = await fetchJson<QuotePayload>(
    `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`,
    { headers: upstoxHeaders(token) },
    20_000
  );
  const quote = body.data?.[instrumentKey] || Object.values(body.data || {})[0];
  return {
    price: toNumber(quote?.last_price),
    previousClose: toNumber(quote?.cp),
    updatedAt: typeof quote?.timestamp === 'string' ? quote.timestamp : undefined
  };
}

async function fetchNearestExpiry(token: string, instrumentKey: string) {
  const body = await fetchJson<{ data?: Array<{ expiry?: string }> }>(
    `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`,
    { headers: upstoxHeaders(token) },
    30 * 60 * 1000
  );
  return [...new Set((body.data || []).map((item) => item.expiry).filter((item): item is string => Boolean(item)))].sort()[0];
}

async function fetchUpstoxOptionSnapshot(token: string, instrumentKey: string) {
  const expiry = await fetchNearestExpiry(token, instrumentKey);
  if (!expiry) throw new Error('No active expiry returned');
  const body = await fetchJson<{ data?: UpstoxStrike[] }>(
    `https://api.upstox.com/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${encodeURIComponent(expiry)}`,
    { headers: upstoxHeaders(token) },
    30_000
  );
  const rows = body.data || [];
  if (!rows.length) throw new Error('Option chain is empty');
  const aggregate = (side: 'call_options' | 'put_options') => rows.reduce(
    (acc, row) => {
      const market = row[side]?.market_data;
      const oi = toNumber(market?.oi) || 0;
      const prevOi = toNumber(market?.prev_oi) || oi;
      acc.oi += oi;
      acc.prevOi += prevOi;
      return acc;
    },
    { oi: 0, prevOi: 0 }
  );
  const spot = toNumber(rows[0]?.underlying_spot_price);
  const atmRow = spot == null
    ? rows[0]
    : [...rows].sort((left, right) => Math.abs((left.strike_price || spot) - spot) - Math.abs((right.strike_price || spot) - spot))[0];
  const call = atmRow?.call_options;
  const put = atmRow?.put_options;
  const calls = aggregate('call_options');
  const puts = aggregate('put_options');
  const percentChange = (current: number, previous: number) => previous > 0 ? ((current - previous) / previous) * 100 : undefined;
  const callSpread = spreadPercent(toNumber(call?.market_data?.bid_price), toNumber(call?.market_data?.ask_price));
  const putSpread = spreadPercent(toNumber(put?.market_data?.bid_price), toNumber(put?.market_data?.ask_price));
  const callIv = toNumber(call?.option_greeks?.iv);
  const putIv = toNumber(put?.option_greeks?.iv);
  return {
    expiry,
    spot,
    pcr: calls.oi > 0 ? puts.oi / calls.oi : undefined,
    callOiChangePercent: percentChange(calls.oi, calls.prevOi),
    putOiChangePercent: percentChange(puts.oi, puts.prevOi),
    atmSpreadPercent: callSpread != null && putSpread != null ? (callSpread + putSpread) / 2 : callSpread ?? putSpread,
    atmIv: callIv != null && putIv != null ? (callIv + putIv) / 2 : callIv ?? putIv
  };
}

function parseCandle(row: unknown[]): Candle | null {
  const timeValue = typeof row[0] === 'number' ? row[0] : new Date(String(row[0])).getTime();
  const values = row.slice(1, 6).map(toNumber);
  if (!Number.isFinite(timeValue) || values.some((value) => value == null)) return null;
  return {
    time: timeValue,
    open: values[0]!,
    high: values[1]!,
    low: values[2]!,
    close: values[3]!,
    volume: values[4]!
  };
}

async function fetchUpstoxCandles(token: string, instrumentKey: string) {
  const body = await fetchJson<{ data?: { candles?: unknown[][] } }>(
    `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/5`,
    { headers: upstoxHeaders(token) },
    30_000
  );
  return (body.data?.candles || []).map(parseCandle).filter((item): item is Candle => Boolean(item));
}

function indiaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function fetchUpstoxMaxPain(token: string, instrumentKey: string, expiry: string) {
  const url = 'https://api.upstox.com/v2/market/max-pain'
    + `?instrument_key=${encodeURIComponent(instrumentKey)}`
    + `&expiry=${encodeURIComponent(expiry)}&date=${indiaDate()}&bucket_interval=60`;
  const body = await fetchJson<{ data?: { max_pain?: number } }>(
    url,
    { headers: upstoxHeaders(token) },
    5 * 60 * 1000
  );
  return toNumber(body.data?.max_pain);
}

async function collectNiftyCard() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || '';
  const niftyKey = process.env.UPSTOX_NIFTY_KEY || 'NSE_INDEX|Nifty 50';
  const vixKey = process.env.UPSTOX_VIX_KEY || 'NSE_INDEX|India VIX';
  const sources: SourceStatus[] = [];
  const snapshot: NiftySnapshot = {};
  const newsPromise = fetchNiftyNews();

  if (!token) {
    sources.push({ name: 'Upstox market desk', status: 'missing', message: 'Add UPSTOX_ANALYTICS_TOKEN for price, candles, VIX and options.' });
    const news = await newsPromise;
    sources.push(...news.statuses);
    if (news.headlines.length) {
      snapshot.sentiment = analyseHeadlines(news.headlines);
      snapshot.updatedAt = new Date().toISOString();
      await applyAiNews('nifty', snapshot, sources, { marketData: 'unavailable', deterministicNewsScore: snapshot.sentiment.score });
    } else await applyAiNews('nifty', snapshot, sources, { marketData: 'unavailable' });
    return scoreNifty(snapshot, sources);
  }

  const [niftyQuote, vixQuote, optionChain, candles, news, upstoxNews] = await Promise.allSettled([
    fetchUpstoxQuote(token, niftyKey),
    fetchUpstoxQuote(token, vixKey),
    fetchUpstoxOptionSnapshot(token, niftyKey),
    fetchUpstoxCandles(token, niftyKey),
    newsPromise,
    fetchUpstoxNews(token, niftyKey)
  ]);

  if (niftyQuote.status === 'fulfilled') {
    snapshot.spot = niftyQuote.value.price;
    snapshot.previousClose = niftyQuote.value.previousClose;
    snapshot.updatedAt = niftyQuote.value.updatedAt;
    sources.push({ name: 'Upstox NIFTY quote', status: 'live', message: 'Spot and previous close loaded.' });
  } else sources.push({ name: 'Upstox NIFTY quote', status: 'error', message: errorMessage(niftyQuote.reason, 'Quote failed.') });

  if (vixQuote.status === 'fulfilled') {
    snapshot.vix = vixQuote.value.price;
    snapshot.vixPreviousClose = vixQuote.value.previousClose;
    sources.push({ name: 'Upstox India VIX', status: 'live', message: 'Volatility regime loaded.' });
  } else sources.push({ name: 'Upstox India VIX', status: 'error', message: errorMessage(vixQuote.reason, 'VIX failed.') });

  if (optionChain.status === 'fulfilled') {
    const option = optionChain.value;
    snapshot.spot = snapshot.spot ?? option.spot;
    snapshot.pcr = option.pcr;
    snapshot.callOiChangePercent = option.callOiChangePercent;
    snapshot.putOiChangePercent = option.putOiChangePercent;
    snapshot.atmSpreadPercent = option.atmSpreadPercent;
    snapshot.atmIv = option.atmIv;
    sources.push({ name: 'Upstox option chain', status: 'live', message: `Nearest expiry ${option.expiry} aggregated.` });
    try {
      snapshot.maxPain = await fetchUpstoxMaxPain(token, niftyKey, option.expiry);
      sources.push({ name: 'Upstox max pain', status: 'live', message: 'Expiry max-pain level loaded.' });
    } catch (error) {
      sources.push({ name: 'Upstox max pain', status: 'error', message: errorMessage(error, 'Max pain failed.') });
    }
  } else {
    sources.push({ name: 'Upstox option chain', status: 'error', message: errorMessage(optionChain.reason, 'Option chain failed.') });
  }

  if (candles.status === 'fulfilled' && candles.value.length) {
    snapshot.technical = calculateTechnicals(candles.value);
    sources.push({ name: 'Upstox 5m candles', status: 'live', message: `${candles.value.length} intraday candles analysed.` });
  } else {
    sources.push({ name: 'Upstox 5m candles', status: 'error', message: candles.status === 'rejected' ? errorMessage(candles.reason, 'Candles failed.') : 'No current-session candles.' });
  }

  const rawNews: RawHeadline[] = [];
  if (news.status === 'fulfilled') {
    rawNews.push(...news.value.headlines);
    sources.push(...news.value.statuses);
  } else sources.push({ name: 'Market news feeds', status: 'error', message: errorMessage(news.reason, 'News failed.'), optional: true });
  if (upstoxNews.status === 'fulfilled') {
    rawNews.push(...upstoxNews.value);
    sources.push({ name: 'Upstox instrument news', status: 'live', message: `${upstoxNews.value.length} token-backed headlines loaded.`, optional: true });
  } else sources.push({ name: 'Upstox instrument news', status: 'error', message: errorMessage(upstoxNews.reason, 'News failed.'), optional: true });
  if (rawNews.length) snapshot.sentiment = analyseHeadlines(rawNews);
  await applyAiNews('nifty', snapshot, sources, {
    spot: snapshot.spot,
    previousClose: snapshot.previousClose,
    indiaVix: snapshot.vix,
    pcr: snapshot.pcr,
    callOiChangePercent: snapshot.callOiChangePercent,
    putOiChangePercent: snapshot.putOiChangePercent,
    atmIv: snapshot.atmIv,
    maxPain: snapshot.maxPain,
    rsi: snapshot.technical?.rsi,
    emaSpreadPct: snapshot.technical?.emaSpreadPct
  });
  snapshot.updatedAt = snapshot.updatedAt || new Date().toISOString();
  return scoreNifty(snapshot, sources);
}

async function fetchBinanceTicker(symbol: string) {
  const body = await fetchJson<BinanceTicker>(
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`,
    undefined,
    20_000
  );
  return {
    price: toNumber(body.lastPrice),
    changePct: toNumber(body.priceChangePercent),
    spreadPct: spreadPercent(toNumber(body.bidPrice), toNumber(body.askPrice)),
    updatedAt: body.closeTime ? new Date(body.closeTime).toISOString() : undefined
  };
}

async function fetchBinanceCandles() {
  const rows = await fetchJson<unknown[][]>(
    'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=120',
    undefined,
    60_000
  );
  return rows.map(parseCandle).filter((item): item is Candle => Boolean(item));
}

function coingeckoHeaders() {
  const apiKey = process.env.COINGECKO_DEMO_API_KEY;
  return apiKey ? { 'x-cg-demo-api-key': apiKey } : undefined;
}

async function fetchCryptoGlobal() {
  try {
    const body = await fetchJson<CoinGeckoGlobal>('https://api.coingecko.com/api/v3/global', { headers: coingeckoHeaders() }, 2 * 60 * 1000);
    const marketCapChangePct = toNumber(body.data?.market_cap_change_percentage_24h_usd);
    const btcDominance = toNumber(body.data?.market_cap_percentage?.btc);
    if (marketCapChangePct == null && btcDominance == null) throw new Error('CoinGecko returned no global metrics.');
    return { marketCapChangePct, btcDominance, source: 'CoinGecko global' };
  } catch {
    const body = await fetchJson<CoinLoreGlobal[]>('https://api.coinlore.net/api/global/', undefined, 2 * 60 * 1000);
    const global = body[0];
    if (!global) throw new Error('CoinLore returned no global metrics.');
    return {
      marketCapChangePct: toNumber(global.mcap_change),
      btcDominance: toNumber(global.btc_d),
      source: 'CoinLore global fallback'
    };
  }
}

async function fetchCryptoBreadth() {
  try {
    const body = await fetchJson<CoinGeckoCoin[]>(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h',
      { headers: coingeckoHeaders() },
      2 * 60 * 1000
    );
    const moves = body.map((coin) => toNumber(coin.price_change_percentage_24h_in_currency)).filter((value): value is number => value != null);
    if (!moves.length) throw new Error('CoinGecko returned no breadth metrics.');
    return { moves, source: 'CoinGecko breadth' };
  } catch {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT', 'AVAXUSDT', 'LINKUSDT'];
    const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const body = await fetchJson<BinanceTicker[]>(url, undefined, 60_000);
    const moves = body.map((ticker) => toNumber(ticker.priceChangePercent)).filter((value): value is number => value != null);
    if (!moves.length) throw new Error('Binance returned no breadth metrics.');
    return { moves, source: 'Binance top-10 breadth fallback' };
  }
}

async function collectCryptoCard() {
  const sources: SourceStatus[] = [];
  const snapshot: CryptoSnapshot = {};
  const [tickers, global, topCoins, candles, fearGreed, news] = await Promise.allSettled([
    Promise.all([fetchBinanceTicker('BTCUSDT'), fetchBinanceTicker('ETHUSDT')]),
    fetchCryptoGlobal(),
    fetchCryptoBreadth(),
    fetchBinanceCandles(),
    fetchJson<FearGreedResponse>('https://api.alternative.me/fng/?limit=1&format=json', undefined, 10 * 60 * 1000),
    fetchCryptoNews()
  ]);

  if (tickers.status === 'fulfilled') {
    const [btc, eth] = tickers.value;
    snapshot.btcPrice = btc.price;
    snapshot.btcChangePct = btc.changePct;
    snapshot.btcSpreadPercent = btc.spreadPct;
    snapshot.ethPrice = eth.price;
    snapshot.ethChangePct = eth.changePct;
    snapshot.ethSpreadPercent = eth.spreadPct;
    snapshot.updatedAt = btc.updatedAt || eth.updatedAt;
    sources.push({ name: 'Binance public tickers', status: 'live', message: 'BTC and ETH 24h market data loaded.' });
  } else sources.push({ name: 'Binance public tickers', status: 'error', message: errorMessage(tickers.reason, 'Ticker fetch failed.') });

  if (global.status === 'fulfilled') {
    snapshot.marketCapChangePct = global.value.marketCapChangePct;
    snapshot.btcDominance = global.value.btcDominance;
    sources.push({ name: global.value.source, status: 'live', message: 'Market cap and BTC dominance loaded.' });
  } else sources.push({ name: 'CoinGecko global', status: 'error', message: errorMessage(global.reason, 'Global data failed.') });

  if (topCoins.status === 'fulfilled') {
    const moves = topCoins.value.moves;
    if (moves.length) snapshot.breadthPositiveRatio = moves.filter((value) => value > 0).length / moves.length;
    sources.push({ name: topCoins.value.source, status: 'live', message: `${moves.length} large-cap assets analysed.` });
  } else sources.push({ name: 'CoinGecko breadth', status: 'error', message: errorMessage(topCoins.reason, 'Breadth failed.') });

  if (candles.status === 'fulfilled' && candles.value.length) {
    snapshot.technical = calculateTechnicals(candles.value);
    sources.push({ name: 'Binance hourly candles', status: 'live', message: `${candles.value.length} BTC candles analysed.` });
  } else sources.push({ name: 'Binance hourly candles', status: 'error', message: candles.status === 'rejected' ? errorMessage(candles.reason, 'Candles failed.') : 'No candles returned.' });

  if (fearGreed.status === 'fulfilled') {
    snapshot.fearGreed = toNumber(fearGreed.value.data?.[0]?.value);
    snapshot.fearGreedLabel = fearGreed.value.data?.[0]?.value_classification;
    sources.push({ name: 'Alternative.me Fear & Greed', status: 'live', message: 'Keyless sentiment gauge loaded.', optional: true });
  } else sources.push({ name: 'Alternative.me Fear & Greed', status: 'error', message: errorMessage(fearGreed.reason, 'Sentiment gauge failed.'), optional: true });

  if (news.status === 'fulfilled') {
    if (news.value.headlines.length) snapshot.sentiment = analyseHeadlines(news.value.headlines);
    sources.push(...news.value.statuses);
  } else sources.push({ name: 'Crypto news feeds', status: 'error', message: errorMessage(news.reason, 'News failed.'), optional: true });

  await applyAiNews('crypto', snapshot, sources, {
    btcPrice: snapshot.btcPrice,
    btcChangePct24h: snapshot.btcChangePct,
    ethChangePct24h: snapshot.ethChangePct,
    marketCapChangePct24h: snapshot.marketCapChangePct,
    btcDominance: snapshot.btcDominance,
    breadthPositiveRatio: snapshot.breadthPositiveRatio,
    fearGreed: snapshot.fearGreed,
    rsi: snapshot.technical?.rsi,
    emaSpreadPct: snapshot.technical?.emaSpreadPct,
    realisedVolatilityPct: snapshot.technical?.volatilityPct
  });

  snapshot.updatedAt = snapshot.updatedAt || new Date().toISOString();
  return scoreCrypto(snapshot, sources);
}

export async function buildDashboard(): Promise<DashboardResponse> {
  const [nifty, crypto] = await Promise.all([collectNiftyCard(), collectCryptoCard()]);
  const cards = [nifty, crypto];
  try {
    await attachTrackRecords(cards);
  } catch (error) {
    console.error('Prediction tracking failed:', error);
  }
  return {
    generatedAt: new Date().toISOString(),
    modelVersion: 'research-desk-v2-ai',
    cards,
    notes: [
      'Probabilities are model-implied, not statistically calibrated until enough forward outcomes are collected.',
      'Signals are research aids, not financial advice; no model can guarantee market direction.'
    ]
  };
}
