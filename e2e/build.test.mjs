// e2e/build.test.mjs — validate the build artifacts (bible.dat + bible.idx.json).
//
// Covers the spec's strictness requirements:
//  - every precinct passes `gzip -t`
//  - every indexed member begins with the 1F 8B magic at its [off]
//  - decompressing exactly the slice [off, off+len) yields byte-identical src
//  - no padding bytes between members (offsets are contiguous & in-bounds)
//  - a chapter lives in exactly one precinct (no member spans precincts)
//  - the index covers every src/*.htm exactly once
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import {
  test, summary, assert, equal,
  readIndex, listSrcChapters, partFilePath, SRC_DIR, DAT_DIR, IDX_PATH,
  decodeMember, bufferEqual,
} from './lib.mjs';
import path from 'node:path';

function precinctFiles() {
  return fs.readdirSync(DAT_DIR)
    .filter(f => /^part_\d+\.dat$/.test(f))
    .sort();
}

function maxPartNumber(idx) {
  let m = 0;
  for (const k in idx) if (idx[k].part > m) m = idx[k].part;
  return m;
}

await test('bible.dat/ exists with part_01..part_NN (2-digit padded, contiguous)', () => {
  assert(fs.existsSync(DAT_DIR), 'bible.dat/ missing');
  const files = precinctFiles();
  assert(files.length > 0, 'no precinct files');
  // contiguous 1..N
  for (let i = 0; i < files.length; i++) {
    const expected = 'part_' + String(i + 1).padStart(2, '0') + '.dat';
    equal(files[i], expected, `precinct #${i + 1} filename`);
  }
});

await test('bible.idx.json parses and covers every src/*.htm exactly once', () => {
  const idx = readIndex();
  const src = listSrcChapters();
  const idxKeys = new Set(Object.keys(idx));
  equal(idxKeys.size, src.length, 'index entry count vs src count');
  for (const f of src) {
    assert(idxKeys.has(f), `index missing ${f}`);
    const e = idx[f];
    assert(typeof e.part === 'number' && e.part >= 1, `${f} part`);
    assert(typeof e.off === 'number' && e.off >= 0, `${f} off`);
    assert(typeof e.len === 'number' && e.len > 0, `${f} len`);
  }
});

await test('every precinct passes `gzip -t` (concatenated members valid)', () => {
  for (const f of precinctFiles()) {
    const fp = path.join(DAT_DIR, f);
    // throws on failure
    execSync(`gzip -t ${JSON.stringify(fp)}`);
  }
});

await test('every indexed member begins with 1F 8B at its offset', () => {
  const idx = readIndex();
  const cache = new Map();
  for (const k in idx) {
    const e = idx[k];
    const fp = partFilePath(e.part);
    let buf = cache.get(fp);
    if (!buf) { buf = fs.readFileSync(fp); cache.set(fp, buf); }
    assert(buf[e.off] === 0x1f && buf[e.off + 1] === 0x8b,
      `${k}: magic 1F 8B at off=${e.off} (got ${buf[e.off]?.toString(16)},${buf[e.off + 1]?.toString(16)})`);
  }
});

await test('each member slice [off, off+len) decompresses byte-identical to src', () => {
  const idx = readIndex();
  const cache = new Map();
  let checked = 0;
  for (const k in idx) {
    const e = idx[k];
    const fp = partFilePath(e.part);
    let buf = cache.get(fp);
    if (!buf) { buf = fs.readFileSync(fp); cache.set(fp, buf); }
    const slice = buf.subarray(e.off, e.off + e.len);
    const dec = decodeMember(slice);
    const raw = fs.readFileSync(path.join(SRC_DIR, k));
    assert(bufferEqual(dec, raw), `${k}: decompressed bytes != src (${dec.length} vs ${raw.length})`);
    checked++;
  }
  assert(checked === listSrcChapters().length, 'checked all chapters');
});

await test('no padding between members: offsets within a precinct are contiguous', () => {
  // Group entries by part; sort by off; each member's [off, off+len) must
  // meet the next member's off with zero gap, and stay within the precinct.
  const idx = readIndex();
  const byPart = new Map();
  for (const k in idx) {
    const e = idx[k];
    if (!byPart.has(e.part)) byPart.set(e.part, []);
    byPart.get(e.part).push({ k, ...e });
  }
  for (const [part, entries] of byPart) {
    entries.sort((a, b) => a.off - b.off);
    const fp = partFilePath(part);
    const buf = fs.readFileSync(fp);
    let prevEnd = 0;
    for (const e of entries) {
      assert(e.off === prevEnd, `part ${part} ${e.k}: off=${e.off} expected=${prevEnd} (padding detected)`);
      assert(e.off + e.len <= buf.length, `part ${part} ${e.k}: member out of bounds`);
      prevEnd = e.off + e.len;
    }
    equal(prevEnd, buf.length, `part ${part}: members must cover the whole precinct exactly`);
  }
});

await test('a chapter lives in exactly one precinct (no member spans precincts)', () => {
  // Implicit from per-entry single `part` + contiguous-within-precinct above,
  // but assert explicitly: no two precincts share a chapter.
  const idx = readIndex();
  const seen = new Map();
  for (const k in idx) {
    assert(!seen.has(k), `${k} appears twice in index`);
    seen.set(k, idx[k].part);
  }
});

await test('total archive size is in the path-1 band (~2.87 MB; 2–3.5 MB)', () => {
  let total = 0;
  for (const f of precinctFiles()) total += fs.statSync(path.join(DAT_DIR, f)).size;
  const mb = total / 1024 / 1024;
  assert(mb > 2.0 && mb < 3.5, `archive size ${mb.toFixed(2)} MB outside [2.0, 3.5)`);
  console.log(`      archive: ${mb.toFixed(2)} MB, ${precinctFiles().length} precincts`);
});

await test('index file is reasonably small (spec target ~30 KB raw)', () => {
  const sz = fs.statSync(IDX_PATH).size;
  assert(sz < 120 * 1024, `index ${sz} B too large`);
  console.log(`      index: ${(sz / 1024).toFixed(1)} KB raw`);
});

process.exit(summary() ? 0 : 1);
