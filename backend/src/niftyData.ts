import { fetchJson, fetchText, toNumber } from './http.js';
import { relativeVolume, vwap } from './indicators.js';
import { istDateKey, previousTradingDay, sessionBounds } from './marketSession.js';
import type { Candle, FuturesSnapshot, GlobalCue, InstitutionalFlow, NiftyBreadth } from './types.js';
import { closedCandles, fetchFullQuotes, fetchHistoricalCandles, fetchIntradayCandles, fetchLtp, upstoxHeaders } from './upstox.js';

export interface Constituent {
  symbol: string;
  isin: string;
  industry: string;
}

const CONSTITUENT_URLS = [
  'https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv',
  'https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv',
  'https://archives.nseindia.com/content/indices/ind_nifty50list.csv'
];
const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

/** Parses the official index constituent CSV: Company Name,Industry,Symbol,Series,ISIN Code. */
export function parseConstituentCsv(csv: string): Constituent[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()?.split(',').map((cell) => cell.trim().toLowerCase()) ?? [];
  const col = (name: string) => header.findIndex((cell) => cell.startsWith(name));
  const symbol = col('symbol');
  const isin = col('isin');
  const industry = col('industry');
  if (symbol < 0 || isin < 0) throw new Error('Unexpected constituent CSV header.');
  return lines
    .map((line) => line.split(','))
    .map((cells) => ({ symbol: cells[symbol]?.trim(), isin: cells[isin]?.trim(), industry: cells[industry]?.trim() ?? '' }))
    .filter((row) => /^INE[A-Z0-9]{9}$/.test(row.isin ?? '') && row.symbol) as Constituent[];
}

/** Constituents change a few times a year; cache the list for 12 hours. */
export async function fetchConstituents(): Promise<{ list: Constituent[]; source: string }> {
  let lastError: unknown;
  for (const url of CONSTITUENT_URLS) {
    try {
      const list = parseConstituentCsv(await fetchText(url, 12 * 60 * 60 * 1000, BROWSER_HEADERS));
      if (list.length >= 45) return { list, source: new URL(url).host };
      lastError = new Error(`Only ${list.length} constituents parsed.`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Constituent list unavailable.');
}

export const SECTOR_INDICES: Array<{ key: string; name: string }> = [
  { key: 'NSE_INDEX|Nifty Bank', name: 'Bank' },
  { key: 'NSE_INDEX|Nifty Fin Service', name: 'Financial Services' },
  { key: 'NSE_INDEX|Nifty IT', name: 'IT' },
  { key: 'NSE_INDEX|Nifty Auto', name: 'Auto' },
  { key: 'NSE_INDEX|Nifty Pharma', name: 'Pharma' },
  { key: 'NSE_INDEX|Nifty Metal', name: 'Metal' },
  { key: 'NSE_INDEX|Nifty FMCG', name: 'FMCG' }
];

export interface BreadthQuote {
  lastPrice?: number;
  previousClose?: number;
  averagePrice?: number;
}

/** Pure breadth computation from constituent quotes (missing quotes are skipped, not counted as unchanged). */
export function computeBreadth(
  quotes: BreadthQuote[],
  sectors: Array<{ name: string; changePct: number }>,
  niftyChangePct?: number
): NiftyBreadth | null {
  const valid = quotes.filter((quote) => (quote.lastPrice ?? 0) > 0 && (quote.previousClose ?? 0) > 0);
  if (!valid.length) return null;
  const changes = valid.map((quote) => ((quote.lastPrice! - quote.previousClose!) / quote.previousClose!) * 100);
  const advances = changes.filter((value) => value > 0).length;
  const declines = changes.filter((value) => value < 0).length;
  const withVwap = valid.filter((quote) => (quote.averagePrice ?? 0) > 0);
  const absolute = changes.map(Math.abs).sort((left, right) => right - left);
  const totalMove = absolute.reduce((sum, value) => sum + value, 0);
  const topShare = totalMove > 0 ? absolute.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalMove : undefined;
  const bank = sectors.find((sector) => sector.name === 'Bank');
  return {
    constituents: valid.length,
    advances,
    declines,
    unchanged: valid.length - advances - declines,
    advanceDeclineRatio: declines > 0 ? Number((advances / declines).toFixed(2)) : null,
    aboveVwapPct: withVwap.length ? (withVwap.filter((quote) => quote.lastPrice! > quote.averagePrice!).length / withVwap.length) * 100 : null,
    // Equal-weighted proxy: share of total absolute movement from the 5 biggest movers.
    concentration: topShare == null ? null : topShare >= 0.5 ? 'narrow' : topShare <= 0.3 ? 'broad' : 'mixed',
    sectors: sectors
      .map((sector) => ({
        name: sector.name,
        changePct: Number(sector.changePct.toFixed(2)),
        relativeToNiftyPct: niftyChangePct == null ? null : Number((sector.changePct - niftyChangePct).toFixed(2))
      }))
      .sort((left, right) => right.changePct - left.changePct),
    bankNiftyRelativePct: bank && niftyChangePct != null ? Number((bank.changePct - niftyChangePct).toFixed(2)) : null
  };
}

export async function fetchNiftyBreadth(token: string, niftyChangePct?: number) {
  const { list, source } = await fetchConstituents();
  const [full, sectorLtp] = await Promise.all([
    fetchFullQuotes(token, list.map((item) => `NSE_EQ|${item.isin}`)),
    fetchLtp(token, SECTOR_INDICES.map((item) => item.key)).catch(() => null)
  ]);
  const sectors = SECTOR_INDICES.flatMap((sector) => {
    const quote = sectorLtp?.quotes.get(sector.key);
    if (!quote?.price || !quote.previousClose) return [];
    return [{ name: sector.name, changePct: ((quote.price - quote.previousClose) / quote.previousClose) * 100 }];
  });
  const lastTrade = full.quotes.map((quote) => quote.lastTradeTime).filter((value): value is number => value != null).sort((a, b) => a - b);
  return {
    breadth: computeBreadth(full.quotes, sectors, niftyChangePct),
    source,
    /** Median last-trade time across constituents. */
    observedAt: lastTrade.length ? lastTrade[Math.floor(lastTrade.length / 2)] : undefined,
    retrievedAt: full.retrievedAt
  };
}

type SearchResponse = { data?: Array<{ instrument_key?: string; instrument_type?: string; underlying_symbol?: string; expiry?: string | number }> };

/** Near-month NIFTY futures key via the instrument search API (cached 6h). */
export async function fetchNiftyFuturesKey(token: string, now: number) {
  const body = await fetchJson<SearchResponse>(
    'https://api.upstox.com/v2/instruments/search?query=NIFTY&segments=FUT&records=30',
    { headers: upstoxHeaders(token) },
    6 * 60 * 60 * 1000
  );
  const today = istDateKey(now);
  const candidates = (body.data || [])
    .filter((row) => row.instrument_type === 'FUT' && row.underlying_symbol === 'NIFTY' && row.instrument_key)
    .map((row) => ({ key: row.instrument_key!, expiry: typeof row.expiry === 'number' ? istDateKey(row.expiry) : String(row.expiry ?? '').slice(0, 10) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.expiry) && row.expiry >= today)
    .sort((left, right) => left.expiry.localeCompare(right.expiry));
  if (!candidates.length) throw new Error('No active NIFTY futures contract found.');
  return candidates[0];
}

/**
 * Futures VWAP distance and relative volume. The index itself reports no
 * volume, so the near-month future is the tradable proxy. Near rollover the
 * previous sessions' volume for this contract is lower, inflating relative volume.
 */
export async function fetchNiftyFutures(token: string, now: number): Promise<FuturesSnapshot> {
  const contract = await fetchNiftyFuturesKey(token, now);
  const today = istDateKey(now);
  const priorDays: string[] = [];
  let cursor = today;
  for (let index = 0; index < 5; index += 1) {
    cursor = previousTradingDay(cursor);
    priorDays.push(cursor);
  }
  const [intraday, history] = await Promise.all([
    fetchIntradayCandles(token, contract.key, 5),
    fetchHistoricalCandles(token, contract.key, priorDays[priorDays.length - 1], priorDays[0], 5)
  ]);
  const todayCandles = closedCandles(intraday, 5 * 60_000, now).filter((candle) => istDateKey(candle.time) === today);
  const sessionVwap = vwap(todayCandles);
  const lastPrice = todayCandles.at(-1)?.close;
  const bySession = (day: string): { start: number; candles: Candle[] } => ({
    start: sessionBounds(day).open,
    candles: history.filter((candle) => istDateKey(candle.time) === day)
  });
  return {
    instrumentKey: contract.key,
    vwap: sessionVwap,
    lastPrice,
    vwapDistancePct: sessionVwap && lastPrice ? ((lastPrice - sessionVwap) / sessionVwap) * 100 : undefined,
    relativeVolume: todayCandles.length
      ? relativeVolume({ start: sessionBounds(today).open, candles: todayCandles }, priorDays.map(bySession), now)
      : undefined
  };
}

/**
 * Global cues from Upstox global instruments. GLOBAL_INDEX keys work with the
 * LTP API; GLOBAL_INDICATOR keys (USD/INR, Brent) only return candles, so
 * their latest daily candle is used and labelled as such.
 */
export async function fetchGlobalCues(token: string, now: number): Promise<GlobalCue[]> {
  const cues: GlobalCue[] = [];
  const live = [
    { key: 'GLOBAL_INDEX|SGX NIFTY', name: 'GIFT Nifty', note: 'Provider latency about 2 minutes.' },
    { key: 'GLOBAL_INDEX|DOW FUTURES', name: 'US 30 futures', note: 'Provider latency about 20 seconds.' }
  ];
  const ltp = await fetchLtp(token, live.map((item) => item.key)).catch(() => null);
  for (const item of live) {
    const quote = ltp?.quotes.get(item.key);
    if (!quote?.price) continue;
    cues.push({
      key: item.key.split('|')[1].toLowerCase().replace(/\s+/g, '-'),
      name: item.name,
      price: quote.price,
      changePct: quote.previousClose ? Number((((quote.price - quote.previousClose) / quote.previousClose) * 100).toFixed(2)) : null,
      observedAt: new Date(ltp!.retrievedAt).toISOString(),
      note: item.note
    });
  }
  const daily = [
    { key: 'GLOBAL_INDICATOR|USDINR', name: 'USD/INR' },
    { key: 'GLOBAL_INDICATOR|BZUSD', name: 'Brent crude' }
  ];
  const to = istDateKey(now);
  const from = istDateKey(now - 10 * 86_400_000);
  await Promise.all(daily.map(async (item) => {
    try {
      const body = await fetchJson<{ data?: { candles?: unknown[][] } }>(
        `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(item.key)}/days/1/${to}/${from}`,
        { headers: upstoxHeaders(token) },
        30 * 60 * 1000
      );
      const rows = (body.data?.candles || [])
        .map((row) => ({ time: new Date(String(row[0])).getTime(), close: toNumber(row[4]) }))
        .filter((row): row is { time: number; close: number } => Number.isFinite(row.time) && row.close != null)
        .sort((left, right) => left.time - right.time);
      const last = rows.at(-1);
      const previous = rows.at(-2);
      if (!last) return;
      cues.push({
        key: item.key.split('|')[1].toLowerCase(),
        name: item.name,
        price: last.close,
        changePct: previous ? Number((((last.close - previous.close) / previous.close) * 100).toFixed(2)) : null,
        observedAt: new Date(last.time).toISOString(),
        note: `Latest daily candle (${istDateKey(last.time)}); not intraday.`
      });
    } catch {
      // Optional context: a failure simply omits this cue.
    }
  }));
  return cues;
}

type FlowResponse = { data?: Record<string, Array<{ time_stamp?: number; buy_amount?: number; sell_amount?: number }>> };

/**
 * Latest FII/DII cash-market net flows. Publication time is not documented,
 * so only figures for sessions before today (IST) are used; today's flows
 * are never treated as known during today's session.
 */
export async function fetchInstitutionalFlows(token: string, now: number): Promise<InstitutionalFlow | undefined> {
  const dataType = encodeURIComponent('NSE_EQ|CASH');
  const [fii, dii] = await Promise.all(['fii', 'dii'].map((kind) => fetchJson<FlowResponse>(
    `https://api.upstox.com/v2/market/${kind}?data_type=${dataType}&interval=1D`,
    { headers: upstoxHeaders(token) },
    60 * 60 * 1000
  )));
  const today = istDateKey(now);
  const latest = (body: FlowResponse) => (body.data?.['NSE_EQ|CASH'] || [])
    .filter((row) => row.time_stamp != null && istDateKey(row.time_stamp) < today)
    .sort((left, right) => (right.time_stamp ?? 0) - (left.time_stamp ?? 0))[0];
  const fiiRow = latest(fii);
  const diiRow = latest(dii);
  const row = fiiRow ?? diiRow;
  if (!row?.time_stamp) return undefined;
  const net = (item?: { buy_amount?: number; sell_amount?: number }) => {
    const buy = toNumber(item?.buy_amount);
    const sell = toNumber(item?.sell_amount);
    return buy != null && sell != null ? Number((buy - sell).toFixed(2)) : null;
  };
  return {
    date: istDateKey(row.time_stamp),
    fiiNetCr: fiiRow && istDateKey(fiiRow.time_stamp!) === istDateKey(row.time_stamp) ? net(fiiRow) : null,
    diiNetCr: diiRow && istDateKey(diiRow.time_stamp!) === istDateKey(row.time_stamp) ? net(diiRow) : null,
    note: 'Previous-session cash-market net (₹ crore). Publication time is undocumented, so today\'s figures are never used intraday.'
  };
}
