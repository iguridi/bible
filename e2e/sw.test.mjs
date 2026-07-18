// e2e/sw.test.mjs — end-to-end service-worker tests via Playwright.
//
// Exercises the spec's runtime contract:
//  - first paint from a tiny network fetch (online), byte-identical to src
//  - background syncPrecincts() fills the archive cache without blocking paint
//  - offline chapter read from a precinct via DecompressionStream slice decode
//  - offline index served from the standalone cache
//  - strict fetch order: precinct beats standalone when both hold a chapter
//  - resume: a deleted precinct is re-fetched on the next navigation's sync
//  - lazy fallback: with DecompressionStream disabled, the SW never crashes;
//    offline works only for previously-visited chapters (precincts ignored)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  createStaticServer, startServer, summary, test, assert, equal,
  readIndex, partFilePath, SRC_DIR, ROOT, bodyEqualsSrc,
} from './lib.mjs';

const SRC_GEN01 = path.join(SRC_DIR, 'GEN01.htm');
const SRC_JHN03 = path.join(SRC_DIR, 'JHN03.htm');
const SRC_PSA023 = path.join(SRC_DIR, 'PSA023.htm');

const idx = readIndex();
const PART_COUNT = (() => { let m = 0; for (const k in idx) if (idx[k].part > m) m = idx[k].part; return m; })();

function partUrlOnPage(n, origin) {
  return `${origin}/bible.dat/part_${String(n).padStart(2, '0')}.dat`;
}

// Wait until the SW is active & controlling the page.
async function waitSWReady(page) {
  await page.evaluate(async () => {
    if (!navigator.serviceWorker) throw new Error('no SW support');
    await navigator.serviceWorker.ready;
  });
}

// A navigation after the SW is active is what kicks off the background
// syncPrecincts() loop via event.waitUntil. The first page load registered
// the SW too late to be controlled, so the caller must navigate once more.
async function kickSync(page) {
  await page.goto(`${BASE}/src/GEN01.htm`);
}

// Poll until every precinct is in the archive cache (or timeout).
async function waitForAllPrecincts(page, origin, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(async (n) => {
      const urls = [];
      for (let i = 1; i <= n; i++) {
        urls.push(`${location.origin}/bible.dat/part_${String(i).padStart(2, '0')}.dat`);
      }
      let have = 0;
      for (const u of urls) if (await caches.match(u)) have++;
      return have;
    }, PART_COUNT);
    if (got === PART_COUNT) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`precinct sync timed out after ${timeoutMs}ms`);
}

async function bibleSourceHeader(resp) {
  const h = await resp.allHeaders();
  return (h['x-bible-source'] || null);
}

const server = createStaticServer();
const BASE = await startServer(server);
const ORIGIN = new URL(BASE).origin;

const browser = await chromium.launch();

// ---- a fresh context per logical group so cache storage is isolated --------
async function newCtx() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { ctx, page };
}

// 1. First paint online comes from the network and is byte-identical to src.
await test('first paint online: network, byte-identical to src/GEN01.htm', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    const resp = await page.goto(`${BASE}/src/GEN01.htm`);
    assert(resp, 'no navigation response');
    equal(await bibleSourceHeader(resp), 'network', 'first-visit source');
    const body = await resp.body();
    const raw = fs.readFileSync(SRC_GEN01);
    assert(bodyEqualsSrc(body, raw), `GEN01 body mismatch (${body.length} vs ${raw.length})`);
    const text = body.toString('utf8');
    assert(text.includes('In the beginning God created heaven'), 'Genesis 1 text missing');
  } finally { await ctx.close(); }
});

// 2. Background sync fills precincts; offline read decodes a precinct member.
await test('offline chapter served from precinct (DecompressionStream slice decode)', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    await kickSync(page);
    await waitForAllPrecincts(page, ORIGIN);
    await ctx.setOffline(true);
    const resp = await page.goto(`${BASE}/src/JHN03.htm`);
    assert(resp, 'no offline response');
    equal(resp.status(), 200, 'offline chapter status');
    equal(await bibleSourceHeader(resp), 'precinct', 'offline source');
    const body = await resp.body();
    const raw = fs.readFileSync(SRC_JHN03);
    assert(bodyEqualsSrc(body, raw), `JHN03 body mismatch (${body.length} vs ${raw.length})`);
  } finally { await ctx.close(); }
});

// 3. Offline index served from the standalone cache.
await test('offline index served from standalone cache', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');           // first load (pre-SW-control)
    await waitSWReady(page);
    await page.goto(BASE + '/');           // controlled -> cached into standalone
    await kickSync(page);
    await waitForAllPrecincts(page, ORIGIN);
    await ctx.setOffline(true);
    const resp = await page.goto(`${BASE}/`);
    assert(resp, 'no offline index response');
    equal(resp.status(), 200, 'offline index status');
    equal(await bibleSourceHeader(resp), 'standalone', 'offline index source');
    const html = await resp.text();
    assert(html.includes('Catholic English Bible'), 'index title missing');
  } finally { await ctx.close(); }
});

// 4. Strict fetch order: precinct wins over a standalone copy.
await test('strict order: precinct beats standalone for a chapter', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    await kickSync(page);
    await waitForAllPrecincts(page, ORIGIN);
    // Manually plant a standalone copy of PSA023 so both caches hold it.
    await page.evaluate(async () => {
      const cache = await caches.keys().then(ks => caches.open(ks.find(k => k.startsWith('standalone_'))));
      const res = await fetch(`${location.origin}/src/PSA023.htm`);
      await cache.put(`${location.origin}/src/PSA023.htm`, res);
    });
    await ctx.setOffline(true);
    const resp = await page.goto(`${BASE}/src/PSA023.htm`);
    assert(resp, 'no response');
    equal(await bibleSourceHeader(resp), 'precinct', 'precinct must win over standalone');
    const body = await resp.body();
    const raw = fs.readFileSync(SRC_PSA023);
    assert(bodyEqualsSrc(body, raw), 'PSA023 body mismatch');
  } finally { await ctx.close(); }
});

// 5. Resume: a deleted precinct is re-fetched on the next navigation's sync.
await test('resume: missing precinct is re-fetched on next navigation', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    await kickSync(page);
    await waitForAllPrecincts(page, ORIGIN);
    // Delete part_05 from the archive cache.
    const target = partUrlOnPage(5, ORIGIN);
    const deleted = await page.evaluate(async (url) => {
      const keys = await caches.keys();
      const cache = await caches.open(keys.find(k => k.startsWith('archive_')));
      return cache.delete(url);
    }, target);
    assert(deleted, 'delete part_05');
    // A navigation triggers event.waitUntil(syncPrecincts()); the missing
    // precinct must be re-fetched and re-cached.
    await page.goto(`${BASE}/src/GEN01.htm`);
    const deadline = Date.now() + 60000;
    let have = false;
    while (Date.now() < deadline) {
      have = await page.evaluate(async (url) => !!await caches.match(url), target);
      if (have) break;
      await page.waitForTimeout(200);
    }
    assert(have, 'part_05 was not re-fetched');
  } finally { await ctx.close(); }
});

// 6. Lazy fallback: DecompressionStream disabled — SW never crashes; offline
//    works only for previously-visited chapters; unvisited chapters miss.
await test('lazy fallback (no DecompressionStream): standalone-only, no crash', async () => {
  const { ctx, page } = await newCtx();
  // Force the lazy-fallback branch by registering sw.js with a `nocomp` query
  // (a test-only hook in sw.js). Route the index navigation to a tiny page that
  // registers that SW; the SW script itself is served unchanged by the static
  // server and reads its own ?nocomp to disable DecompressionStream.
  await page.route(`${BASE}/`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><script>navigator.serviceWorker.register("sw.js?nocomp").catch(()=>{})</script>',
  }));
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    // Sanity: the active SW must have supportsDecompression === false. Probe
    // by checking that no precinct gets cached even after a wait.
    await page.goto(`${BASE}/src/GEN01.htm`);          // visited -> standalone
    await page.waitForTimeout(2000);
    let precinctCached = await page.evaluate(async (n) => {
      for (let i = 1; i <= n; i++) {
        const u = `${location.origin}/bible.dat/part_${String(i).padStart(2, '0')}.dat`;
        if (await caches.match(u)) return true;
      }
      return false;
    }, PART_COUNT);
    assert(!precinctCached, 'lazy fallback must not download precincts');

    await ctx.setOffline(true);
    // a) visited chapter is served from the standalone cache.
    const respA = await page.goto(`${BASE}/src/GEN01.htm`);
    assert(respA, 'no response for visited chapter');
    equal(respA.status(), 200, 'visited chapter served offline');
    equal(await bibleSourceHeader(respA), 'standalone', 'visited chapter source');
    const bodyA = await respA.body();
    assert(bodyEqualsSrc(bodyA, fs.readFileSync(SRC_GEN01)), 'GEN01 body mismatch (fallback)');

    // b) unvisited chapter misses (no precinct strategy, no standalone copy).
    const respB = await page.goto(`${BASE}/src/JHN03.htm`);
    assert(respB, 'no response for unvisited chapter');
    equal(respB.status(), 504, 'unvisited chapter must miss offline');
    equal(await bibleSourceHeader(respB), 'offline-miss', 'unvisited chapter source tag');
  } finally {
    await page.unroute(`${BASE}/`);
    await ctx.close();
  }
});

// 7. First paint is not blocked by the archive download: a chapter navigation
//    resolves quickly even though 2.87 MB is still streaming in.
await test('first paint not blocked by background precinct download', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    const t0 = Date.now();
    const resp = await page.goto(`${BASE}/src/GEN01.htm`);
    const dt = Date.now() - t0;
    assert(resp, 'no response');
    equal(await bibleSourceHeader(resp), 'network', 'first-visit source (network)');
    // First paint must be fast (well under the multi-second archive download).
    assert(dt < 5000, `first paint took ${dt}ms (expected fast network fetch)`);
  } finally { await ctx.close(); }
});

// 8. Progress bar: 2px top bar reaches ready and stays at 100%; a reload in
//    the same context (archive already complete) reaches ready again.
await test('progress bar: reaches ready and stays at 100%; reload-after-complete reaches ready', async () => {
  const { ctx, page } = await newCtx();
  try {
    await page.goto(BASE + '/');
    await waitSWReady(page);
    await kickSync(page);
    await waitForAllPrecincts(page, ORIGIN);
    // Navigate to the index (SW-controlled) so syncPrecincts runs and the bar
    // mounts; it must reach ready and then PERSIST at 100% (no fade/remove).
    await page.goto(BASE + '/');
    await page.waitForFunction(
      () => { const b = document.getElementById('dl-bar'); return b && b.getAttribute('data-state') === 'ready'; },
      { timeout: 30000 }
    );
    equal(await page.evaluate(() => document.getElementById('dl-bar').style.getPropertyValue('--w')), '100%', 'bar at 100% after ready');
    await page.waitForTimeout(1000);
    assert(await page.evaluate(() => !!document.getElementById('dl-bar')), 'bar persists after ready (not removed)');
    // Reload-after-complete (same context, archive cached): bar remounts,
    // query returns have===total, bar goes straight to ready at 100%.
    await page.goto(BASE + '/');
    await page.waitForFunction(
      () => { const b = document.getElementById('dl-bar'); return b && b.getAttribute('data-state') === 'ready'; },
      { timeout: 30000 }
    );
    equal(await page.evaluate(() => document.getElementById('dl-bar').style.getPropertyValue('--w')), '100%', 'bar at 100% after reload');
  } finally { await ctx.close(); }
});

// 9. Abort path: a 500 on part_03 aborts the sync; the aborted bar persists.
//    Unroute and reload and the next sync recovers to ready.
await test('progress bar abort: 500 on part_03 → aborted bar stays; reload recovers to ready', async () => {
  const { ctx, page } = await newCtx();
  const part03 = `${BASE}/bible.dat/part_03.dat`;
  // context.route (not page.route) is required: SW-initiated fetches are
  // intercepted at the context level, not the page level.
  await ctx.route(part03, (route) => route.fulfill({ status: 500, body: 'err' }));
  try {
    await page.goto(BASE + '/');           // first load (pre-SW-control)
    await waitSWReady(page);
    // A controlled index navigation triggers syncPrecincts; the loop fetches
    // part_01, part_02, then hits part_03's 500 → outer catch → abort.
    await page.goto(BASE + '/');
    await page.waitForFunction(
      () => { const b = document.getElementById('dl-bar'); return b && b.getAttribute('data-state') === 'aborted'; },
      { timeout: 30000 }
    );
    // Aborted bar persists (partial width, muted red) — not removed.
    await page.waitForTimeout(1000);
    assert(await page.evaluate(() => !!document.getElementById('dl-bar')), 'aborted bar persists (not removed)');
    // Unroute the 500 and kick a fresh sync; part_03 is still missing (never
    // cached), so the retry re-fetches it and the rest, reaching ready.
    await ctx.unroute(part03);
    await kickSync(page);
    await waitForAllPrecincts(page, ORIGIN);
    await page.goto(BASE + '/');
    await page.waitForFunction(
      () => { const b = document.getElementById('dl-bar'); return b && b.getAttribute('data-state') === 'ready'; },
      { timeout: 30000 }
    );
  } finally { await ctx.close(); }
});

await browser.close();
server.close();
process.exit(summary() ? 0 : 1);
