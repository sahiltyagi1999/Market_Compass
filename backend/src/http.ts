export interface Fetched<T> {
  value: T;
  retrievedAt: number;
  fromCache: boolean;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly rateLimited: boolean) {
    super(message);
  }
}

const cache = new Map<string, { expiresAt: number; value: Fetched<unknown> }>();
const DEFAULT_TIMEOUT_MS = 10_000;

/** Each prediction cycle starts clean so nothing carries over between cycles. */
export function clearHttpCache() {
  cache.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const retryable = response.status === 429 || response.status >= 500;
    if (response.ok || !retryable || attempt >= 1) {
      if (!response.ok) {
        throw new HttpError(
          response.status === 429 ? `Rate limited (429) by ${new URL(url).host}` : `${response.status} ${response.statusText}`,
          response.status,
          response.status === 429
        );
      }
      return response;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 600);
  }
}

async function cachedFetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<Fetched<T>> {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return { ...(existing.value as Fetched<T>), fromCache: true };
  const value: Fetched<T> = { value: await loader(), retrievedAt: Date.now(), fromCache: false };
  if (ttlMs > 0) cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

export function fetchJsonMeta<T>(url: string, init?: RequestInit, ttlMs = 0, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return cachedFetch<T>(`json:${url}`, ttlMs, async () => (await request(url, init, timeoutMs)).json() as Promise<T>);
}

export async function fetchJson<T>(url: string, init?: RequestInit, ttlMs = 0, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return (await fetchJsonMeta<T>(url, init, ttlMs, timeoutMs)).value;
}

export async function fetchText(url: string, ttlMs = 0, headers?: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const fetched = await cachedFetch(`text:${url}`, ttlMs, async () => (await request(url, {
    headers: { 'User-Agent': 'MarketCompassIndia/1.0 (+local research dashboard)', ...headers }
  }, timeoutMs)).text());
  return fetched.value;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function toNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
