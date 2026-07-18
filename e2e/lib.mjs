// e2e/lib.mjs — shared helpers: static server + tiny test harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
export const SRC_DIR = path.join(ROOT, 'src');
export const DAT_DIR = path.join(ROOT, 'bible.dat');
export const IDX_PATH = path.join(ROOT, 'bible.idx.json');

const MIME = {
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.dat': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

export function createStaticServer(root = ROOT) {
  return http.createServer((req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const fp = path.join(root, p);
      if (!fp.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
      fs.stat(fp, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': st.size,
        });
        fs.createReadStream(fp).pipe(res);
      });
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
}

export function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// ---- tiny test harness ------------------------------------------------------
let _pass = 0, _fail = 0;
const _fails = [];

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export function equal(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

export async function test(name, fn) {
  try {
    await fn();
    _pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    _fail++;
    _fails.push({ name, err: e });
    console.log(`  \u2717 ${name}\n      ${e && e.stack ? e.stack.split('\n').join('\n      ') : e}`);
  }
}

export function summary() {
  console.log(`\n${_pass} passed, ${_fail} failed`);
  return _fail === 0;
}

// ---- shared build-output helpers --------------------------------------------
export function readIndex() {
  return JSON.parse(fs.readFileSync(IDX_PATH, 'utf8'));
}

export function listSrcChapters() {
  return fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.htm')).sort();
}

export function partFilePath(n) {
  const name = 'part_' + String(n).padStart(2, '0') + '.dat';
  return path.join(DAT_DIR, name);
}

// gunzip exactly one gzip member (the slice [off, off+len)) and compare to src
export function decodeMember(slice) {
  // Node's gunzipSync decodes a single-member (or multi-member) gzip stream.
  // Feeding exactly one member yields exactly that chapter's bytes.
  return zlib.gunzipSync(slice);
}

export function bufferEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// All 1409 src/*.htm files begin with a UTF-8 BOM (EF BB BF). The browser
// strips it from a navigation response body, so a byte comparison against the
// raw file must tolerate an optional leading BOM on either side.
export function stripBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3);
  }
  return buf;
}

export function bodyEqualsSrc(body, raw) {
  return bufferEqual(body, raw) || bufferEqual(stripBom(body), stripBom(raw));
}
