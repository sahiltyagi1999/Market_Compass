import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const refreshIfStale = vi.fn(() => true);
vi.mock('./dashboardSchedule.js', () => ({
  getDashboard: vi.fn(),
  refreshIfStale,
  snapshotStatus: () => ({ generatedAt: null, nextUpdateAt: null, ageSeconds: null, current: false, refreshing: true })
}));

const { app } = await import('./app.js');
let base = '';
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('health endpoints', () => {
  it('serves a no-I/O liveness check', async () => {
    const response = await fetch(`${base}/api/health/live`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('answers cron keep-alive pings (GET and HEAD, no Origin header) and kicks a stale refresh', async () => {
    const response = await fetch(`${base}/api/keepalive`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, refreshStarted: true, snapshot: { current: false, refreshing: true } });
    expect(refreshIfStale).toHaveBeenCalled();
    const head = await fetch(`${base}/api/keepalive`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });
});
