import { errorMessage, fetchJson, fetchText } from './http.js';
import type { RawHeadline } from './sentiment.js';
import type { SourceStatus } from './types.js';
import { upstoxHeaders } from './upstox.js';

export interface NewsBundle {
  headlines: RawHeadline[];
  statuses: SourceStatus[];
}

type UpstoxNewsResponse = {
  data?: Record<string, Array<{
    heading?: string;
    summary?: string;
    article_link?: string;
    published_time?: number;
  }>>;
};

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
      title: xmlTag(item, 'title').replace(/\]\]>$/, '').replace(/<[^>]+>/g, '').trim(),
      source: xmlTag(item, 'source') || fallbackSource,
      url: xmlTag(item, 'link'),
      publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
    };
  }).filter((item) => item.title && item.url);
}

async function fetchRssNews(url: string, source: string) {
  return parseRssNews(await fetchText(url, 5 * 60 * 1000), source);
}

export function isNiftyHeadlineRelevant(title: string) {
  return /\b(nifty(?:\s*50)?|sensex|india vix|bank nifty|nse|bse|indian (?:shares?|stocks?|equities|equity|markets?)|india(?:'s)? (?:stock|share|equity|financial) market|rupee|reserve bank of india|rbi|sebi|foreign (?:portfolio )?investors?|fpis?|fiis?|federal reserve|fed (?:chair|rates?|rate cut|rate hike)|crude oil|brent|us tariffs?)\b/i.test(title);
}

export function isCryptoHeadlineRelevant(title: string) {
  return /\b(bitcoin|btc|ethereum|ether|eth|crypto(?:currency|currencies)?|blockchain|digital assets?|stablecoins?|coinbase|binance|solana|xrp|dogecoin|crypto miner|bitcoin miner|clarity act)\b/i.test(title);
}

async function fetchNewsBundle(
  feeds: Array<{ name: string; loader: () => Promise<RawHeadline[]> }>,
  isRelevant: (title: string) => boolean
): Promise<NewsBundle> {
  const settled = await Promise.allSettled(feeds.map((feed) => feed.loader()));
  const statuses: SourceStatus[] = [];
  const groups: RawHeadline[][] = [];
  settled.forEach((result, index) => {
    const name = feeds[index].name;
    const relevant = result.status === 'fulfilled'
      ? result.value.filter((item) => isRelevant(item.title))
      : [];
    if (relevant.length) {
      groups.push(relevant);
      statuses.push({
        name,
        status: 'live',
        message: `${relevant.length} relevant headlines selected from ${result.status === 'fulfilled' ? result.value.length : 0}.`,
        optional: true
      });
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

export function fetchNiftyNews() {
  return fetchNewsBundle([
    { name: 'Yahoo Finance NIFTY RSS', loader: () => fetchRssNews('https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENSEI&region=IN&lang=en-IN', 'Yahoo Finance') },
    { name: 'Economic Times Markets RSS', loader: () => fetchRssNews('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times') },
    { name: 'Google News RSS', loader: () => fetchGoogleNews('(NIFTY 50 OR Sensex OR NSE OR India VIX) when:2d', 'IN') }
  ], isNiftyHeadlineRelevant);
}

export function fetchCryptoNews() {
  return fetchNewsBundle([
    { name: 'Yahoo Finance Bitcoin RSS', loader: () => fetchRssNews('https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US', 'Yahoo Finance') },
    { name: 'CoinDesk RSS', loader: () => fetchRssNews('https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk') },
    { name: 'Cointelegraph RSS', loader: () => fetchRssNews('https://cointelegraph.com/rss', 'Cointelegraph') },
    { name: 'Google News RSS', loader: () => fetchGoogleNews('(Bitcoin OR Ethereum OR cryptocurrency) when:2d', 'US') }
  ], isCryptoHeadlineRelevant);
}

export async function fetchUpstoxNews(token: string, instrumentKey: string): Promise<RawHeadline[]> {
  const url = `https://api.upstox.com/v2/news?category=instrument_keys&instrument_keys=${encodeURIComponent(instrumentKey)}&page_size=30`;
  const body = await fetchJson<UpstoxNewsResponse>(url, { headers: upstoxHeaders(token) }, 5 * 60 * 1000);
  return Object.values(body.data || {}).flat().map((item) => ({
    title: item.heading || item.summary || '',
    source: 'Upstox News',
    url: item.article_link || '',
    publishedAt: new Date(item.published_time || Date.now()).toISOString()
  })).filter((item) => item.title && item.url);
}
