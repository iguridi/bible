# Catholic English Bible (Douay-Rheims 1899)

Simple catholic bible with no ads and no fuzz.

Live: https://iguridi.github.io/bible

## Offline archive

The whole Bible is usable offline via a service worker that downloads
independent gzip members packed into ~50 KB "precincts" once, then decompresses
per chapter on demand using native `DecompressionStream('gzip')`. First paint
never waits on the full download — a chapter paints from a ~1.5 KB fetch while
the ~2.7 MB archive streams in the background.

See `~/Documents/1/butler/bible-offline-archive.md` for the full design.

### Build

```sh
node build-archive.js
```

Produces (committed, served by GitHub Pages):
- `bible.dat/part_01.dat … part_NN.dat` — precincts of concatenated
  independent gzip members (one member per chapter, no padding between them).
- `bible.idx.json` — `chapter -> {part, off, len}` map.

The build is deterministic (`gzip -n` semantics: `mtime=0`, no filename).

### Service worker

`sw.js` intercepts chapter navigations in strict order:
1. **Precinct cache** (DecompressionStream only): slice `[off, off+len)` (one
   whole member), pipe only those bytes through `DecompressionStream('gzip')`.
2. **Standalone cache**: a prior direct fetch / lazy-fallback copy.
3. **Network**: fetch the single chapter for instant first paint, cache it.
4. **Always** (DecompressionStream only): `event.waitUntil(syncPrecincts())`
   fills the archive in the background.

Old browsers without `DecompressionStream` (pre-Safari 16.4) silently fall
back to the lazy per-chapter cache — the SW never crashes.

### Tests

```sh
npm install        # playwright (devDependency)
npm test           # build-output tests + Playwright SW e2e tests
```
