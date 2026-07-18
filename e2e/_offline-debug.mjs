import { chromium } from 'playwright';
import { createStaticServer, startServer, readIndex } from './lib.mjs';

const idx = readIndex();
const PART_COUNT = (() => { let m = 0; for (const k in idx) if (idx[k].part > m) m = idx[k].part; return m; })();

const server = createStaticServer();
const BASE = await startServer(server);
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Log every request the page makes.
page.on('request', (r) => console.log('REQ', r.method(), r.url()));
page.on('response', (r) => console.log('RES', r.status(), r.url()));

await page.goto(BASE + '/');
await page.evaluate(async () => { await navigator.serviceWorker.ready; });
// Navigate to a chapter to kick sync AND to get the SW controlling.
await page.goto(`${BASE}/src/GEN01.htm`);
// Wait for all precincts.
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  const got = await page.evaluate(async (n) => {
    let have = 0;
    for (let i = 1; i <= n; i++) if (await caches.match(`${location.origin}/bible.dat/part_${String(i).padStart(2,'0')}.dat`)) have++;
    return have;
  }, PART_COUNT);
  if (got === PART_COUNT) break;
  await page.waitForTimeout(200);
}
// Is the CSS in the standalone cache?
const cssCached = await page.evaluate(async () => !!(await caches.match(`${location.origin}/src/gentiumplus.css`)));
console.log('CSS in (any) cache?', cssCached);
const cssStandalone = await page.evaluate(async () => !!(await caches.match(`${location.origin}/src/gentiumplus.css`, { cacheName: 'standalone_v1' })));
console.log('CSS in standalone_v1?', cssStandalone);

// Go offline and time the first offline chapter (a fresh chapter not yet visited).
await ctx.setOffline(true);
const t0 = Date.now();
const resp = await page.goto(`${BASE}/src/JHN03.htm`);
console.log('first offline chapter ms=', Date.now() - t0, 'status=', resp.status());
const t1 = Date.now();
const resp2 = await page.goto(`${BASE}/src/JHN03.htm`);
console.log('second offline chapter ms=', Date.now() - t1, 'status=', resp2.status());

await ctx.close();
await browser.close();
server.close();
