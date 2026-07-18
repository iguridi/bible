#!/usr/bin/env node
// build-archive.js
//
// Produces the offline archive artifacts described in
//   ~/Documents/1/butler/bible-offline-archive.md
//
// Output (committed, served by GitHub Pages):
//   bible.dat/part_01.dat ... part_NN.dat   — precincts of concatenated
//                                            independent gzip members.
//   bible.idx.json                          — chapter -> {part, off, len}.
//
// Strictness (from the spec): each chapter is gzip'd independently with a
// deterministic header (gzip -n semantics: mtime=0, no filename), then members
// are concatenated with NO padding bytes between them. The next member's
// 1F 8B magic must immediately follow the previous member's trailing
// CRC/ISIZE. Any injected byte shifts every subsequent offset and corrupts
// the index.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const DAT_DIR = path.join(ROOT, 'bible.dat');
const IDX_PATH = path.join(ROOT, 'bible.idx.json');

// ~50 KB per precinct: the sweet spot from the spec. Small enough that the
// decode path (which loads the whole precinct into an ArrayBuffer) is trivial
// on low-end Android; large enough that ~2.87 MB splits into ~57 precincts
// (fine resume granularity under iOS tab-kill, modest HTTP request count).
const TARGET_PRECINCT_BYTES = 50 * 1024;

function partFileName(n, width) {
  return 'part_' + String(n).padStart(width, '0') + '.dat';
}

function listChapters() {
  const all = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.htm'))
    .sort();
  if (all.length === 0) throw new Error('no .htm files found in src/');
  return all;
}

// Independent gzip member, deterministic (gzip -n equivalent):
// mtime=0, no filename, no comment, OS byte 0xff (unknown) -> reproducible
// across Node versions / platforms. level 9.
function gzipMember(buf) {
  const gz = zlib.gzipSync(buf, { level: 9, mtime: 0, filename: '', os: 0xff });
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) {
    throw new Error('gzip member missing 1F 8B magic');
  }
  return gz;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  const chapters = listChapters();
  console.log(`[build] ${chapters.length} .htm files in src/`);

  // 1. Compress every chapter into its own independent gzip member.
  const members = chapters.map(name => {
    const raw = fs.readFileSync(path.join(SRC_DIR, name));
    return { name, raw, gz: gzipMember(raw) };
  });

  // 2. Pack members into member-aligned precincts. No member spans two
  //    precincts. Start a new precinct when adding the next member would
  //    push the current one past TARGET (and the current one is non-empty).
  //    Track each member's (part, off, len) as we go — single source of truth,
  //    no second-pass replay.
  const precinctParts = []; // Array<Buffer[]>
  const index = Object.create(null);
  let cur = null;       // current precinct Buffer[]
  let curSize = 0;      // current precinct byte size
  let curOff = 0;       // offset within current precinct for the next member

  for (const m of members) {
    if (cur && curSize + m.gz.length > TARGET_PRECINCT_BYTES && curSize > 0) {
      precinctParts.push(cur);
      cur = null;
    }
    if (!cur) { cur = []; curSize = 0; curOff = 0; }

    index[m.name] = { part: precinctParts.length + 1, off: curOff, len: m.gz.length };
    cur.push(m.gz);
    curSize += m.gz.length;
    curOff += m.gz.length;
  }
  if (cur) precinctParts.push(cur);

  const partCount = precinctParts.length;
  const padWidth = Math.max(2, String(partCount).length);

  // 3. Reset output dir + write precinct files by pure Buffer.concat
  //    (no separators, no padding — byte-exact concatenation).
  rmrf(DAT_DIR);
  fs.mkdirSync(DAT_DIR, { recursive: true });

  let totalGz = 0;
  precinctParts.forEach((parts, i) => {
    const blob = Buffer.concat(parts); // byte-exact, no padding ever
    fs.writeFileSync(path.join(DAT_DIR, partFileName(i + 1, padWidth)), blob);
    totalGz += blob.length;
  });

  // Minimal, stable JSON (no whitespace) — keeps the index tiny.
  fs.writeFileSync(IDX_PATH, JSON.stringify(index));

  const totalRaw = members.reduce((a, m) => a + m.raw.length, 0);
  console.log(`[build] ${partCount} precincts, ${totalGz} bytes (${(totalGz/1024/1024).toFixed(2)} MB)`);
  console.log(`[build] raw ${(totalRaw/1024/1024).toFixed(2)} MB -> gzip ${(totalGz/1024/1024).toFixed(2)} MB`);
  console.log(`[build] index: ${IDX_PATH} (${fs.statSync(IDX_PATH).size} bytes)`);
  console.log(`[build] done.`);
}

if (require.main === module) {
  main();
}
