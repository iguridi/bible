// sw.js — offline archive service worker for the Douay-Rheims PWA.
//
// Implements the design in ~/Documents/1/butler/bible-offline-archive.md:
// independent gzip members packed into member-aligned ~50 KB precincts,
// decoded natively via DecompressionStream('gzip') by slicing exactly one
// member out of a cached precinct before piping.
//
// Fetch order for a chapter navigation (src/<XX>.htm), strict:
//   1. Precinct cache  (DecompressionStream only): slice [off, off+len),
//      pipe only those bytes through DecompressionStream('gzip'), return
//      text/html. Offline + instant once the precinct is cached.
//   2. Standalone cache: a prior direct fetch (or the lazy fallback path).
//   3. Network: fetch the single ~1.5 KB-gzipped chapter for instant first
//      paint, stash it in the standalone cache, return it.
//   4. Always (DecompressionStream only): event.waitUntil(syncPrecincts())
//      so the archive fills in in the background without blocking paint.
//
// On old browsers without DecompressionStream the whole precinct strategy is
// skipped (lazy fallback): only branches 2 & 3 run, so the SW never throws on
// a ReferenceError and offline still works for previously-visited chapters.

'use strict';

const OFFLINE_VERSION = 52;
const ARCHIVE_CACHE = `archive_v${OFFLINE_VERSION}`;
const STANDALONE_CACHE = `standalone_v${OFFLINE_VERSION}`;

// Feature-detect once at module load. Branch the whole strategy on this so an
// old Safari (pre-16.4) never hits `new DecompressionStream('gzip')`.
// The `nocomp` query is a test-only hook to force the lazy-fallback branch on
// browsers that do support DecompressionStream; production registrations use
// a plain `sw.js` URL with no query, so this is inert in production.
const _swUrl = new URL(self.location.href);
const _forceNoDecomp = _swUrl.searchParams.has('nocomp');
const supportsDecompression = !_forceNoDecomp && (typeof DecompressionStream === 'function');

// All archive URLs are resolved relative to this SW's own location, which is
// the scope root (sw.js lives next to index.html / bible.dat / bible.idx.json).
const BASE_HREF = new URL('./', self.location.href).href;
const INDEX_URL = new URL('bible.idx.json', BASE_HREF).href;

function partUrl(n) {
  const name = 'part_' + String(n).padStart(2, '0') + '.dat';
  return new URL('bible.dat/' + name, BASE_HREF).href;
}

// ---- in-flight tracking -----------------------------------------------------
// A module-level Set keyed by precinct URL. SWs are ephemeral: a plain boolean
// resets every spin-down, and a precinct mid-fetch-but-not-yet-put would be
// re-requested on the next navigation. The Set dedupes while the SW is alive;
// when it sleeps the Set clears, which is fine because the pending requests
// died anyway and re-issue via the missing-from-cache check.
const inFlight = new Set();

// Warm the IndexedDB-backed Cache Storage databases on SW startup. On a
// cold-restarted SW (the browser stopped it after the background download
// finished and the user later navigates), the first cache operation would
// otherwise pay the IDB-open latency on the critical path of the first
// chapter response. Kicking off the opens at top level overlaps them with
// script eval / SW startup so they're usually done by the time the first
// fetch event fires.
const _warmCaches = Promise.all([
  caches.open(ARCHIVE_CACHE).catch(() => {}),
  caches.open(STANDALONE_CACHE).catch(() => {}),
]);

// ---- progress broadcast (page ↔ SW) ----------------------------------------
// Module-scope last-known progress so a query from a freshly-spun-up SW or a
// reloaded tab can be answered without re-walking the caches every time.
// Reset to 0/0 on SW spin-down, which is fine: the message handler re-derives
// from caches before replying when lastTotal === 0.
let lastHave = 0, lastTotal = 0;

// Broadcast a message to every controlled client. Used for progress updates
// (after each precinct cache.put), complete (loop end), and abort (outer catch).
async function broadcast(msg) {
  const clients = await self.clients.matchAll();
  for (const c of clients) c.postMessage(msg);
}

async function broadcastProgress(have, total) {
  lastHave = have; lastTotal = total;
  await broadcast({ type: 'progress', have, total });
}

// ---- index access -----------------------------------------------------------
let indexPromise = null;

// Cache-only read: returns the parsed index or null. Never hits the network —
// used on the chapter hot path so first paint is never blocked by an index
// fetch. The background syncPrecincts() call ensures the index lands in the
// cache via ensureIndex().
function cachedIndex() {
  return caches.match(INDEX_URL, { cacheName: ARCHIVE_CACHE })
    .then(r => r ? r.json() : null);
}

// Network-or-cache index load, used by the background sync. Memoised so
// concurrent navigations share one in-flight index fetch.
function ensureIndex() {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    let res = await caches.match(INDEX_URL, { cacheName: ARCHIVE_CACHE });
    if (res && res.ok) return res.json();
    res = await fetch(INDEX_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`index fetch failed: ${res.status}`);
    const cache = await caches.open(ARCHIVE_CACHE);
    await cache.put(INDEX_URL, res.clone());
    return res.clone().json();
  })();
  return indexPromise;
}

function partCountFromIndex(idx) {
  let max = 0;
  for (const k in idx) {
    const v = idx[k];
    if (v && typeof v.part === 'number' && v.part > max) max = v.part;
  }
  return max;
}

// ---- precinct sync (background, resumable) ----------------------------------
async function syncPrecincts() {
  if (!supportsDecompression) return;
  // No point fetching precincts offline; skipping also avoids offline-fetch
  // hangs and redundant cold cache walks on the first offline navigation.
  if (self.navigator && self.navigator.onLine === false) return;
  let idx;
  try {
    idx = await ensureIndex();
  } catch (e) {
    return; // no index yet; next navigation retries
  }
  const n = partCountFromIndex(idx);
  const cache = await caches.open(ARCHIVE_CACHE);
  let have = 0;
  lastTotal = n;
  // Single pass: count cached precincts silently (lastHave tracks the running
  // count so a query-progress reply stays accurate mid-pass) and broadcast
  // only on freshly-put precincts plus a final broadcast. This avoids
  // broadcasting a low `have` on a cold restart where every precinct is
  // already cached (which would flicker a persisted 100% bar back down) and
  // halves the cache work versus a separate seeding pass.
  try {
    for (let p = 1; p <= n; p++) {
      const url = partUrl(p);
      if (inFlight.has(url)) continue;
      // Resume granularity: a precinct already in cache is counted and
      // skipped; a missing one (iOS tab-kill, partial download) is re-fetched
      // whole. No byte-range tracking, no appends — precincts are separate
      // cache entries.
      if (await caches.match(url, { cacheName: ARCHIVE_CACHE })) {
        have++;
        lastHave = have;
        continue;
      }
      inFlight.add(url);
      let res;
      try {
        res = await fetch(url, { cache: 'no-store' });
      } catch (e) {
        // Transient network failure on a single part: swallow and retry on
        // the next sync. This is the only case the inner catch swallows.
        continue;
      } finally {
        inFlight.delete(url);
      }
      // A non-ok response (e.g. 500) or a QuotaExceededError from cache.put
      // escapes the inner catch and bubbles to the outer catch → abort.
      if (!res.ok) throw new Error(`precinct ${p} HTTP ${res.status}`);
      await cache.put(url, res.clone());
      have++;
      lastHave = have;
      broadcastProgress(have, n);
    }
    lastHave = have;
    broadcastProgress(have, n);
  } catch (e) {
    // Outer catch: a hard failure escaped the inner per-precinct swallow.
    // Flush last-known progress then signal abort. Next visit re-queries and
    // resumes only if have < total.
    lastHave = have;
    broadcastProgress(lastHave, lastTotal);
    broadcast({ type: 'abort' });
  }
}

// ---- query-progress (page ↔ SW) --------------------------------------------
// A reloaded tab needs to re-sync to the current download state, which is
// entry-point-independent: the archive may already be complete or partially
// fetched by a prior SW instance. The page queries on ready and on
// controllerchange; the SW replies to the asking client only (loop updates
// broadcast to all clients). waitUntil keeps the SW alive past the handler
// return so the async reply actually fires.
self.addEventListener('message', (event) => {
  if (!supportsDecompression) return;
  if (!event.data || event.data.type !== 'query-progress') return;
  event.waitUntil((async () => {
    if (lastTotal === 0) {
      const total = partCountFromIndex(await ensureIndex());
      let have = 0;
      for (let p = 1; p <= total; p++)
        if (await caches.match(partUrl(p), { cacheName: ARCHIVE_CACHE })) have++;
      lastHave = have; lastTotal = total;
    }
    event.source.postMessage({ type: 'progress', have: lastHave, total: lastTotal });
  })());
});

// ---- decode one member out of a precinct ------------------------------------
// The DecompressionStream invariant: it decodes concatenated multi-member
// streams and does NOT stop after the first member. So pipe ONLY the slice
// [off, off+len) — exactly one whole gzip member — never the precinct buffer.
async function decodeChapterFromPartResponse(partResponse, entry) {
  const buf = await partResponse.arrayBuffer();
  const end = entry.off + entry.len;
  if (end > buf.byteLength) return null;
  const slice = buf.slice(entry.off, end); // exactly one whole member
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([slice]).stream().pipeThrough(ds);
  const dec = await new Response(stream).arrayBuffer();
  return new Uint8Array(dec);
}

function precinctResponse(bytes) {
  return new Response(bytes, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Bible-Source': 'precinct',
    },
  });
}

// Re-wrap a cached/network response with an X-Bible-Source tag for
// testability (and to make the "precinct wins over standalone" ordering
// observable). Consumes the body.
async function tagResponse(res, source) {
  const body = await res.arrayBuffer();
  const h = new Headers(res.headers);
  h.set('X-Bible-Source', source);
  return new Response(body, { headers: h, status: res.status, statusText: res.statusText });
}

// ---- fetch handler ----------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;

  const isNavigate = req.mode === 'navigate';
  if (!isNavigate) {
    // Same-origin subresources (CSS, manifest, icons): network with a
    // standalone-cache fallback so offline chapters stay styled.
    event.respondWith(handleSubresource(req));
    return;
  }

  const isChapter = u.pathname.endsWith('.htm') && u.pathname.includes('/src/');
  const isIndex = u.pathname.endsWith('/') || u.pathname.endsWith('/index.html');

  if (isChapter) {
    event.respondWith(handleChapter(req, u));
    // Keep the SW alive past the primary response so the background
    // precinct download isn't killed mid-flight.
    event.waitUntil(syncPrecincts().catch(() => {}));
    return;
  }
  if (isIndex) {
    event.respondWith(handleIndex(req));
    event.waitUntil(syncPrecincts().catch(() => {}));
    return;
  }
  // Other navigations: default network.
});

async function handleChapter(req, u) {
  const filename = u.pathname.split('/').pop();

  // 1. Precinct cache (DecompressionStream only). Cache-only index read so
  //    first paint is never blocked by an index fetch.
  if (supportsDecompression) {
    try {
      const idx = await cachedIndex();
      const entry = idx && idx[filename];
      if (entry) {
        const partRes = await caches.match(partUrl(entry.part), { cacheName: ARCHIVE_CACHE });
        if (partRes) {
          const bytes = await decodeChapterFromPartResponse(partRes, entry);
          if (bytes) return precinctResponse(bytes);
        }
      }
    } catch (e) {
      // fall through to standalone / network
    }
  }

  // 2. Standalone cache (shared with the lazy fallback).
  const standalone = await caches.match(req, { cacheName: STANDALONE_CACHE });
  if (standalone) return tagResponse(standalone, 'standalone');

  // 3. Network (shared with the lazy fallback).
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(STANDALONE_CACHE);
      await cache.put(req, res.clone());
    }
    return tagResponse(res, 'network');
  } catch (e) {
    return new Response('Offline: chapter not yet downloaded.', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Bible-Source': 'offline-miss' },
    });
  }
}

async function handleIndex(req) {
  const standalone = await caches.match(req, { cacheName: STANDALONE_CACHE });
  if (standalone) return tagResponse(standalone, 'standalone');
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(STANDALONE_CACHE);
      await cache.put(req, res.clone());
    }
    return tagResponse(res, 'network');
  } catch (e) {
    return new Response('Offline: index not cached.', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Bible-Source': 'offline-miss' },
    });
  }
}

async function handleSubresource(req) {
  const standalone = await caches.match(req, { cacheName: STANDALONE_CACHE });
  if (standalone) return standalone;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(STANDALONE_CACHE);
      await cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504 });
  }
}

// ---- lifecycle --------------------------------------------------------------
self.addEventListener('install', (event) => {
  // Pre-cache the index on install so the SW can map any chapter URL to its
  // precinct without a network round-trip on the hot path. skipWaiting so the
  // first-visit SW activates immediately.
  self.skipWaiting();
  event.waitUntil((async () => {
    // Request persistent storage so the browser is far less likely to evict
    // the archive under disk pressure. Best-effort: some browsers prompt the
    // user, some silently grant/deny; a false result just means best-effort
    // LRU eviction remains in effect (the spec's resumable precinct design
    // already handles re-download gracefully).
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (e) { /* ignore */ }
    }
    try {
      const res = await fetch(INDEX_URL, { cache: 'no-store' });
      if (res.ok) {
        const cache = await caches.open(ARCHIVE_CACHE);
        await cache.put(INDEX_URL, res);
      }
    } catch (e) {
      // offline at install time: index will be fetched on first navigation
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Evict old versions of both caches. Dual-cache cleanup of the transient
    // standalone cache happens here (lazy, not per-precinct) to avoid the
    // serve-while-evicting race.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== ARCHIVE_CACHE && k !== STANDALONE_CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});
