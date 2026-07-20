#!/usr/bin/env node
// acquire-es.js — acquire the Spanish Torres Amat (1825/1836) Bible for es/src/.
//
// Implements the acquisition pipeline in
// ~/memory/2026-07-19-bible-pwa-spanish-torres-amat-spec.md (§7).
//
// Source: es.wikisource.org "La Sagrada Biblia" (Félix Torres Amat), a
// scan-backed ProofreadPage corpus. The actual verse text lives in the
// Page: namespace (e.g. "Página:La Sagrada Biblia (XIII).djvu/30") as
// {{vers|chapter|verse}} templates. Each Index: page maps djvu page
// numbers → books via a <pagelist>.
//
// Phases (run independently, all cached under es/_raw/):
//   --probe          S2: enumerate Index pages, parse <pagelist>s, count
//                    proofread Page-quality per book, map to our 73-book /
//                    1334-chapter canon, print a coverage matrix. No fetch
//                    of page bodies.
//   --deep           (with --probe) also fetch every proofread page body and
//                    detect chapter starts ({{vers|N|1}}) → true chapter-
//                    level coverage. Slower (one cached call per page).
//   --fetch          S3 phase 1: fetch every proofread Page body for the
//                    selected tomos into es/_raw/ws/<tomo>/<page>.wikitext.
//   --build          S3 phase 3: parse cached wikitext, group into chapters,
//                    emit es/src/<CODE><NN>.htm in our template, plus book
//                    TOCs and copyright.htm.
//   --tomo XIII       restrict --fetch/--build/--deep to one tomo (roman or
//                    the exact index page label). May be repeated.
//   --sleep 1200     ms between uncached API calls (default 1200, ≥1 req/s).
//   --allow-partial  do not halt on incomplete coverage (dev only).
//
// Raw responses are cached to es/_raw/ws_api/ (JSON API) and
// es/_raw/ws/<tomo>/<page>.wikitext (page bodies) so re-runs after parser
// edits do not re-fetch. es/_raw/ is gitignored.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname);
const ES_DIR = path.join(ROOT, 'es');
const RAW_DIR = path.join(ES_DIR, '_raw');
const API_CACHE = path.join(RAW_DIR, 'ws_api');
const PAGE_CACHE = path.join(RAW_DIR, 'ws');
const SRC_DIR = path.join(ES_DIR, 'src');

const UA = 'bible-pwa-acquisition/1.0 (https://iguridi.github.io/bible; contact via GitHub)';
const API = 'https://es.wikisource.org/w/api.php';
const SLEEP_DEFAULT = 1200;

// ---------------------------------------------------------------------------
// Canon — the English corpus is the ground truth for parity (spec §11.2).
// 73 books, 1334 chapters. Book codes match en/src/*.htm filenames.
// ---------------------------------------------------------------------------

const CANON = {
  'GEN': 50, 'EXO': 40, 'LEV': 27, 'NUM': 36, 'DEU': 34, 'JOS': 24, 'JDG': 21, 'RUT': 4,
  '1SA': 31, '2SA': 24, '1KI': 22, '2KI': 25, '1CH': 29, '2CH': 36, 'EZR': 10, 'NEH': 13,
  'TOB': 14, 'JDT': 16, 'EST': 16, '1MA': 16, '2MA': 15, 'JOB': 42, 'PSA': 150, 'PRO': 31,
  'ECC': 12, 'SNG': 8, 'WIS': 19, 'SIR': 51, 'ISA': 66, 'JER': 52, 'LAM': 5, 'BAR': 6,
  'EZK': 48, 'DAN': 14, 'HOS': 14, 'JOL': 3, 'AMO': 9, 'OBA': 1, 'JON': 4, 'MIC': 7,
  'NAM': 3, 'HAB': 3, 'ZEP': 3, 'HAG': 2, 'ZEC': 14, 'MAL': 4,
  'MAT': 28, 'MRK': 16, 'LUK': 24, 'JHN': 21, 'ACT': 28, 'ROM': 16, '1CO': 16, '2CO': 13,
  'GAL': 6, 'EPH': 6, 'PHP': 4, 'COL': 4, '1TH': 5, '2TH': 3, '1TI': 6, '2TI': 4, 'TIT': 3,
  'PHM': 1, 'HEB': 13, 'JAS': 5, '1PE': 5, '2PE': 3, '1JN': 5, '2JN': 1, '3JN': 1, 'JUD': 1,
  'REV': 22,
};

// Spanish book display names (Torres Amat / Wikisource; spec §4) — used for
// es/index.html, book TOCs, and <title>s. Confirmed against Wikisource
// pagelist labels where available; rest are the modern Spanish fallback.
const ES_NAMES = {
  'GEN': 'Génesis', 'EXO': 'Éxodo', 'LEV': 'Levítico', 'NUM': 'Números',
  'DEU': 'Deuteronomio', 'JOS': 'Josué', 'JDG': 'Jueces', 'RUT': 'Ruth',
  '1SA': '1 Samuel', '2SA': '2 Samuel', '1KI': '1 Reyes', '2KI': '2 Reyes',
  '1CH': '1 Paralipómenos', '2CH': '2 Paralipómenos', 'EZR': 'Esdras',
  'NEH': 'Nehemías', 'TOB': 'Tobías', 'JDT': 'Judit', 'EST': 'Ester',
  '1MA': '1 Macabeos', '2MA': '2 Macabeos', 'JOB': 'Job', 'PSA': 'Salmos',
  'PRO': 'Proverbios', 'ECC': 'Eclesiastés', 'SNG': 'Cantares', 'WIS': 'Sabiduría',
  'SIR': 'Eclesiástico', 'ISA': 'Isaías', 'JER': 'Jeremías', 'LAM': 'Lamentaciones',
  'BAR': 'Baruc', 'EZK': 'Ezequiel', 'DAN': 'Daniel', 'HOS': 'Oseas', 'JOL': 'Joel',
  'AMO': 'Amós', 'OBA': 'Abdías', 'JON': 'Jonás', 'MIC': 'Miqueas', 'NAM': 'Nahúm',
  'HAB': 'Habacuc', 'ZEP': 'Sofonías', 'HAG': 'Ageo', 'ZEC': 'Zacarías',
  'MAL': 'Malaquías', 'MAT': 'Mateo', 'MRK': 'Marcos', 'LUK': 'Lucas', 'JHN': 'Juan',
  'ACT': 'Hechos', 'ROM': 'Romanos', '1CO': '1 Corintios', '2CO': '2 Corintios',
  'GAL': 'Gálatas', 'EPH': 'Efesios', 'PHP': 'Filipenses', 'COL': 'Colosenses',
  '1TH': '1 Tesalonicenses', '2TH': '2 Tesalonicenses', '1TI': '1 Timoteo',
  '2TI': '2 Timoteo', 'TIT': 'Tito', 'PHM': 'Filemón', 'HEB': 'Hebreos',
  'JAS': 'Santiago', '1PE': '1 Pedro', '2PE': '2 Pedro', '1JN': '1 Juan',
  '2JN': '2 Juan', '3JN': '3 Juan', 'JUD': 'Judas', 'REV': 'Apocalipsis',
};

// Spanish label (as it appears in the Wikisource <pagelist> or subpage
// title) → our 3-letter code. Keys are lowercased, accent-stripped for
// matching. Add aliases as new tomos reveal their exact labels.
const LABEL_TO_CODE = (() => {
  const strip = (s) => s.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const map = {};
  for (const [code, name] of Object.entries(ES_NAMES)) {
    map[strip(name)] = code;
    // bare ordinal + name without leading number
    map[strip(name.replace(/^\d+\s*/, ''))] = code;
  }
  // Archaic / alternate spellings seen on Wikisource or expected of Torres
  // Amat (1836 edition, etymological accents, long forms).
  const aliases = {
    Matheo: 'MAT', Marcos: 'MRK', Lucas: 'LUK', Juan: 'JHN',
    Hechos: 'ACT', Romanos: 'ROM', '1 Corintios': '1CO', '2 Corintios': '2CO',
    Galatas: 'GAL', 'Gálatas': 'GAL', Efesios: 'EPH', Filipenses: 'PHP',
    Colosenses: 'COL', '1 Tesalonicenses': '1TH', '2 Tesalonicenses': '2TH',
    '1 Timoteo': '1TI', '2 Timoteo': '2TI', Tito: 'TIT', Filemon: 'PHM',
    'Filemón': 'PHM', Hebreos: 'HEB', Santiago: 'JAS', '1 Pedro': '1PE',
    '2 Pedro': '2PE', '1 Juan': '1JN', '2 Juan': '2JN', '3 Juan': '3JN',
    Judas: 'JUD', Apocalipsis: 'REV',
    Genesis: 'GEN', Exodo: 'EXO', Levitico: 'LEV', Numeros: 'NUM',
    Deuteronomio: 'DEU', Josue: 'JOS', Jueces: 'JDG', Ruth: 'RUT',
    '1 Samuel': '1SA', '2 Samuel': '2SA', '1 Reyes': '1KI', '2 Reyes': '2KI',
    '1 Paralipomenos': '1CH', '2 Paralipomenos': '2CH',
    '1 Cronicas': '1CH', '2 Cronicas': '2CH', Esdras: 'EZR', Nehemias: 'NEH',
    Tobias: 'TOB', Judit: 'JDT', Ester: 'EST', '1 Macabeos': '1MA',
    '2 Macabeos': '2MA', Job: 'JOB', Salmos: 'PSA', Proverbios: 'PRO',
    Eclesiastes: 'ECC', Cantares: 'SNG', 'Cantar de los Cantares': 'SNG',
    Sabiduria: 'WIS', Eclesiastico: 'SIR', Isaias: 'ISA', Jeremias: 'JER',
    Lamentaciones: 'LAM', Baruc: 'BAR', Ezequiel: 'EZK', Daniel: 'DAN',
    Oseas: 'HOS', Joel: 'JOL', Amos: 'AMO', Abdias: 'OBA', Jonas: 'JON',
    Miqueas: 'MIC', Nahum: 'NAM', Habacuc: 'HAB', Sofonias: 'ZEP',
    Ageo: 'HAG', Zacarias: 'ZEC', Malaquias: 'MAL',
  };
  for (const [k, v] of Object.entries(aliases)) map[strip(k)] = v;
  return map;
})();

function labelToCode(label) {
  const strip = (s) => s.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  return LABEL_TO_CODE[strip(label)] || null;
}

// ---------------------------------------------------------------------------
// Cached, rate-limited HTTPS client.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let lastRequest = 0;
const sleepMs = SLEEP_DEFAULT;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchText(loc));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function cachedFetch(url, cacheFile) {
  if (fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile, 'utf8');
  }
  const now = Date.now();
  const wait = Math.max(0, lastRequest + sleepMs - now);
  if (wait) await sleep(wait);
  lastRequest = Date.now();
  const text = await fetchText(url);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, text);
  return text;
}

function cacheFileForApi(paramsKey, suffix = 'json') {
  // paramsKey is a stable string derived from the API params.
  const safe = paramsKey.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 180);
  return path.join(API_CACHE, `${safe}.${suffix}`);
}

async function api(params) {
  const url = `${API}?${params}&format=json`;
  const key = params.replace(/&format=json$/i, '');
  return cachedFetch(url, cacheFileForApi(key));
}

async function apiJson(params) {
  return JSON.parse(await api(params));
}

// ---------------------------------------------------------------------------
// Index enumeration + <pagelist> parsing.
// ---------------------------------------------------------------------------

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8,
  IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16 };

function romanToInt(s) { return ROMAN[String(s).toUpperCase()] || null; }

async function listIndexes() {
  // Index namespace = 104. apprefix matches after "Índice:".
  const titles = [];
  let cont = '';
  do {
    const p = `action=query&list=allpages&apnamespace=104&apprefix=La_Sagrada_Biblia&aplimit=500${cont ? `&apcontinue=${encodeURIComponent(cont)}` : ''}`;
    const d = await apiJson(p);
    for (const pg of d.query.allpages) titles.push(pg.title);
    cont = (d.continue && d.continue.apcontinue) || '';
  } while (cont);
  return titles;
}

// Parse the Index page wikitext <pagelist> blocks → list of
// { from, to, label } segments. Also extract Progreso and the IA source.
function parseIndex(wt) {
  const prog = (wt.match(/\|\s*Progreso\s*=\s*([^\n|]*)/) || [])[1] || '';
  const ia = (wt.match(/\|\s*Fuente\s*=\s*\{\{IA\|([^}|]+)/) || [])[1] || '';
  const segs = [];
  // Each <pagelist .../> is a self-closing template invocation.
  const re = /<pagelist\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(wt))) {
    const body = m[1];
    const seg = { from: null, to: null, label: null, rangeText: body.trim() };
    const fromM = body.match(/\bfrom\s*=\s*(\d+)/);
    const toM = body.match(/\bto\s*=\s*(\d+)/);
    if (fromM) seg.from = +fromM[1];
    if (toM) seg.to = +toM[1];
    // A label appears as "N=Label" e.g. "28=Matheo". The book label is the
    // first N=<word> where N is the seg.from (or any N=<text> with an
    // alphabetic label).
    const labelM = body.match(/\b(\d+)\s*=\s*([A-Za-zÁÉÍÓÚáéíóúÑñ0-9 .:-]+)/);
    if (labelM) { seg.label = labelM[2].trim(); seg.labelAt = +labelM[1]; }
    // Ranges like "1to6=-" or "28=Matheo" or "29=21" (the "21" is the
    // printed page number, not a book label). Only treat alphabetic labels
    // as book labels.
    if (seg.label && /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(seg.label)) {
      segs.push(seg);
    }
  }
  return { progreso: prog.trim(), iaSource: ia.trim(), segs };
}

// ---------------------------------------------------------------------------
// Page namespace enumeration + proofread quality.
// ---------------------------------------------------------------------------

// Quality levels: 0 = not proofread (raw/empty), 1 = not proofread,
// 2 = problematic, 3 = proofread, 4 = validated. We treat >= 3 as "has
// clean text we can use". pageprops carries prp_page_quality as "N|user".
async function listPagesWithQuality(djvuIndexName) {
  // djvuIndexName e.g. "La Sagrada Biblia (XIII).djvu" (the bare djvu title,
  // without the "Índice:" prefix). Page-namespace titles are
  // "Página:<djvuIndexName>/<num>".
  const prefix = djvuIndexName + '/';
  const out = [];
  let cont = '';
  do {
    const p = `action=query&generator=allpages&gapnamespace=102&gapprefix=${encodeURIComponent(prefix)}&gaplimit=500&prop=pageprops&ppprop=proofread_page_quality_level${cont ? `&gapcontinue=${encodeURIComponent(cont)}` : ''}`;
    const d = await apiJson(p);
    if (d.query && d.query.pages) {
      for (const pg of Object.values(d.query.pages)) {
        const num = +(/\/(\d+)$/.exec(pg.title) || [])[1];
        if (num == null || Number.isNaN(num)) continue;
        const pp = pg.pageprops || {};
        const q = +(pp.proofread_page_quality_level) || 0;
        out.push({ num, quality: q });
      }
    }
    cont = (d.continue && d.continue.gapcontinue) || '';
  } while (cont);
  out.sort((a, b) => a.num - b.num);
  return out;
}

// ---------------------------------------------------------------------------
// Page body fetch (Phase 1).
// ---------------------------------------------------------------------------

async function fetchPageBody(indexTitle, num) {
  const djvu = indexTitle.replace(/^Índice:/, '').replace(/^Index:/, '');
  const tomoLabel = djvu.replace(/^La Sagrada Biblia /, '').replace(/\.djvu$/, '');
  const safeTomo = tomoLabel.replace(/[^A-Za-z0-9]+/g, '_');
  const file = path.join(PAGE_CACHE, safeTomo, `${num}.wikitext`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  // OCR fallback: when no Wikisource Page: body exists, use the vision
  // transcription from es/_raw/ocr/pages/<NNNN>_vision.txt if present.
  // The vision output is already in {{vers|chap|verse}} form, which
  // parsePageVerses understands directly. The IA djvu name's numeric suffix
  // is the same as the Wikisource page number (1:1), so we look up by num.
  const ocrFile = path.join(RAW_DIR, 'ocr', 'pages', `${String(num).padStart(4, '0')}_vision.txt`);
  if (fs.existsSync(ocrFile)) return fs.readFileSync(ocrFile, 'utf8');
  const page = `Página:${djvu}/${num}`;
  const p = `action=parse&page=${encodeURIComponent(page)}&prop=wikitext`;
  const d = await apiJson(p);
  const wt = (d.parse && d.parse.wikitext && d.parse.wikitext['*']) || '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wt);
  return wt;
}

// ---------------------------------------------------------------------------
// Verse parsing — turn a Page-body wikitext into [{chapter, verse, text}].
// ---------------------------------------------------------------------------

// Page bodies use {{vers|chapter|verse}} TEXT. Some pages are prose
// continuations of the previous chapter (no {{vers}} until a new chapter
// starts); we handle that by carrying the current chapter forward.

const VERS_RE = /\{\{vers\|(?:c=)?(\d+)\|v=(\d+)\}\}\s*|\{\{vers\|v=(\d+)\|c=?(\d+)\}\}\s*|\{\{vers\|(\d+)\|(\d+)\}\}\s*/g;

function parsePageVerses(wt) {
  // Strip <noinclude> blocks (headers like {{CP|22|SAN MATHEO.}}) and
  // <pagequality> templates; keep <include> body.
  let body = wt.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, '');
  body = body.replace(/<pagequality[^]*?\/>/g, '');
  // Strip {{CP|...}} chapter-print headers and similar.
  body = body.replace(/\{\{CP\|[^}]*\}\}/g, '');
  // Remove <ref>...</ref> (footnotes — we drop them for now; TODO: capture).
  body = body.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/g, '');
  body = body.replace(/<ref\b[^>]*\/>/g, '');
  // Drop <section begin="..."/> / <section end="..."/> markers — they mark
  // chapter boundaries but the {{vers|N|1}} templates already encode that.
  // Replace with a sentinel so verse-text truncation can cut there.
  body = body.replace(/<section\b[^>]*\/>/g, '\u0000');
  const verses = [];
  let m;
  let curChapter = null;
  let lastEnd = 0;
  let pending = '';
  while ((m = VERS_RE.exec(body))) {
    // Three alternations in VERS_RE: (1) {{vers|c=N|v=N}}, (2) {{vers|v=N|c=N}},
    // (3) {{vers|N|N}}. Pick whichever pair matched.
    const chapter = +(m[1] || m[4] || m[5]);
    const verse = +(m[2] || m[3] || m[6]);
    const textBefore = body.slice(lastEnd, m.index);
    if (curChapter != null) {
      // textBefore is the body of the previous verse on this page
      // (continuation). Attach it to the last verse's text.
      if (verses.length && verses[verses.length - 1].chapter === curChapter) {
        verses[verses.length - 1].text += truncateAtChapterHeading(textBefore);
      }
    }
    curChapter = chapter;
    verses.push({ chapter, verse, text: '' });
    lastEnd = VERS_RE.lastIndex;
  }
  // Trailing text after the last {{vers}}: continuation of the last verse,
  // again truncated at any chapter heading.
  if (verses.length) {
    verses[verses.length - 1].text += truncateAtChapterHeading(body.slice(lastEnd));
  }
  for (const v of verses) {
    v.text = cleanWikiText(v.text);
    v.text = normalizeText(v.text);
  }
  return verses;
}

// Cut text at the first chapter-heading indicator so the following
// chapter's heading/summary does not get appended to the current verse.
// Indicators: a <section> marker (replaced with \u0000 above), a {{c|...}}
// centered block, {{grande|...}}/{{menor|...}} size blocks, or the literal
// word CAPÍTULO/CAPITULO.
function truncateAtChapterHeading(s) {
  const cut = s.search(/\u0000|\{\{c\||\{\{grande\||\{\{menor\||CAP[ÍI]TULO/);
  return cut >= 0 ? s.slice(0, cut) : s;
}

function cleanWikiText(s) {
  // Drop chapter-heading / centered / size blocks (not verse text).
  s = s.replace(/\{\{c\|[^}]*\}\}/g, '');
  s = s.replace(/\{\{grande\|[^}]*\}\}/g, '');
  s = s.replace(/\{\{menor\|[^}]*\}\}/g, '');
  // {{may|X}} -> X (emphasis/smallcaps); {{np}} -> '' (new-paragraph marker).
  s = s.replace(/\{\{may\|([^}]*)\}\}/g, '$1');
  s = s.replace(/\{\{np\}\}/g, '');
  s = s.replace(/\{\{listaref[^}]*\}\}/g, '');
  s = s.replace(/\{\{[Pp]ágina línea[^}]*\}\}/g, '');
  s = s.replace(/\{\{línea\}\}/g, '');
  s = s.replace(/\[\[(?:[Cc]ategoría|[Cc]ategory):[^\]]*\]\]/g, '');
  // Internal links: [[Target|Label]] -> Label, [[Target]] -> Target.
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
  // Bold/italic.
  s = s.replace(/'''/g, '').replace(/''/g, '');
  // <hr/>, leftover tags, section sentinels (\u0000 from parsePageVerses).
  s = s.replace(/<hr\s*\/?>/gi, '');
  s = s.replace(/<\/?(?:include|noinclude|onlyinclude)[^>]*>/gi, '');
  s = s.replace(/\u0000/g, ' ');
  // Any remaining {{template}} we did not handle -> drop.
  s = s.replace(/\{\{[^}]*\}\}/g, '');
  // Collapse whitespace but keep verse-internal spacing sane.
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, ' ').replace(/\s+$/g, '').replace(/^\s+/, '');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Spelling modernization (option C: keep archaic vocabulary/syntax, normalize
// spelling to modern RAE conventions). Applied at build time so the raw
// vision/Wikisource files stay as-is (reversible). Every rule is documented
// in ~/memory/2026-07-19-bible-pwa-spanish-normalization-ruleset.md.
// ---------------------------------------------------------------------------

// Word-boundary replacement that works with Spanish accented chars.
// \b in JS regex is ASCII-only, so we use explicit lookarounds.
function wbReplace(s, word, replacement) {
  // Boundary = start-of-string or a non-letter char before; similarly after.
  const re = new RegExp(
    '(^|[^A-Za-z\u00C0-\u017F])' +
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '([^A-Za-z\u00C0-\u017F]|$)',
    'g'
  );
  return s.replace(re, (_m, pre, post) => pre + replacement + post);
}

function normalizeText(s) {
  // --- Bug fixes (not modernization — these are unambiguous OCR artifacts) ---

  // 1. Hyphenated line-breaks: 'acom- pañado' -> 'acompañado'.
  //    (A lowercase letter, hyphen, space, lowercase letter. Safe because
  //    'Jesu-Christo' has NO space after the hyphen and won't match.)
  s = s.replace(/([a-z\u00E1\u00E9\u00ED\u00F3\u00FA\u00F1])- ([a-z\u00E1\u00E9\u00ED\u00F3\u00FA\u00F1])/g, '$1$2');

  // 2. Cross-page word splits (no hyphen): 'voso tros' -> 'vosotros'.
  //    Only two known cases in the NT; the OT will be audited after OCR.
  s = s.replace(/\bvoso tros\b/g, 'vosotros');
  s = s.replace(/\bnues tro\b/g, 'nuestro');

  // --- Etymological accents on single-letter words (19th-c. convention,
  //     all dropped in modern RAE Spanish). Safe because no modern Spanish
  //     word is a single accented letter; standalone context guarantees
  //     these are prepositions/conjunctions.
  //     á (preposition) -> a,  ó (conjunction "or") -> o,
  //     é (conjunction "and" before i-sounds) -> e,
  //     ú (conjunction "or" before o-sounds) -> u.
  s = wbReplace(s, 'á', 'a');
  s = wbReplace(s, 'ó', 'o');
  s = wbReplace(s, 'é', 'e');
  s = wbReplace(s, 'ú', 'u');
  s = wbReplace(s, 'Á', 'A');
  s = wbReplace(s, 'É', 'E');
  s = wbReplace(s, 'Ó', 'O');

  // --- Tier 1: Universal mechanical (order matters — do compounds first) ---
  s = s.replace(/Jesu-Christo/g, 'Jesucristo');
  s = s.replace(/JesuChristo/g, 'Jesucristo');   // model sometimes drops the hyphen
  s = s.replace(/Jesuchristo/g, 'Jesucristo');   // all-lowercase variant
  s = s.replace(/Christo-Jesus/g, 'Cristo-Jesús');
  s = wbReplace(s, 'Christo', 'Cristo');

  // --- Tier 2: Closed-set word replacements (proper nouns + common words) ---
  const tier2 = {
    'Jesus': 'Jesús', 'Moyses': 'Moisés', 'Sion': 'Sión',
    'Jose': 'José', 'Maria': 'María', 'dia': 'día',
    'tambien': 'también', 'estais': 'estáis', 'todavia': 'todavía',
    'leida': 'leída',
  };
  for (const [from, to] of Object.entries(tier2)) {
    s = wbReplace(s, from, to);
  }

  // --- Tier 3: Verb form accent restoration (curated — only true verb forms) ---
  const tier3 = {
    // -ia (imperfect/conditional 3rd sg)
    'habia': 'había', 'decia': 'decía', 'tenia': 'tenía', 'hacia': 'hacía',
    'debia': 'debía', 'sabia': 'sabía', 'seria': 'sería', 'podia': 'podía',
    'venia': 'venía', 'queria': 'quería',
    // -ian (imperfect/conditional 3rd pl)
    'habian': 'habían', 'decian': 'decían', 'tenian': 'tenían', 'hacian': 'hacían',
    'podian': 'podían', 'venian': 'venían', 'ponian': 'ponían', 'vivian': 'vivían',
    'salian': 'salían', 'sabian': 'sabían', 'vendian': 'vendían', 'creian': 'creían',
    'temian': 'temían', 'reñian': 'reñían', 'anuncian': 'anuncían', 'querian': 'querían',
    'respondian': 'respondían', 'seguian': 'seguían', 'discurrian': 'discurrían',
    'bebian': 'bebían', 'calumnian': 'calumnían', 'traian': 'traían', 'debian': 'debían',
    'parecian': 'parecían', 'habrian': 'habrían', 'acudian': 'acudían',
    'podrian': 'podrían', 'pedian': 'pedían', 'perseguian': 'perseguían',
    'desprecian': 'desprecían', 'cabian': 'cabían', 'herian': 'herían',
    'ofrecian': 'ofrecían', 'plañian': 'plañían', 'servian': 'servían',
    'tendian': 'tendían', 'tendrian': 'tendrían', 'vestian': 'vestían',
    'volvian': 'volvían',
    // -eis (2nd pl present)
    'teneis': 'tenéis', 'habeis': 'habéis',
  };
  for (const [from, to] of Object.entries(tier3)) {
    s = wbReplace(s, from, to);
  }

  // --- Tier 4: -cion -> -ción (universal modern Spanish rule) ---
  s = s.replace(/([a-z])cion\b/g, '$1ción');
  s = s.replace(/([a-z])cion([\s.,;:!?)])/g, '$1ción$2');

  return s;
}

// ---------------------------------------------------------------------------
// Build: assemble chapters from page verses and emit es/src/*.htm.
// ---------------------------------------------------------------------------

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function chapterFileName(code, chap) {
  // Width matches en/src/: GEN01.htm (2), PSA001.htm (3). Use 3 for PSA, 2
  // otherwise, mirroring English.
  const width = code === 'PSA' ? 3 : 2;
  return `${code}${pad(chap, width)}.htm`;
}

function prevChapterHref(code, chap) {
  if (chap <= 1) return '../index.html';
  return chapterFileName(code, chap - 1);
}
function nextChapterHref(code, chap, lastChap) {
  if (chap >= lastChap) return '../index.html';
  return chapterFileName(code, chap + 1);
}

function renderChapter(code, chap, lastChap, verses) {
  const name = ES_NAMES[code] || code;
  const title = `La Sagrada Biblia (Torres Amat) ${name} ${chap}`;
  const verseSpans = verses
    .map((v) => `<span class="verse" id="V${v.verse}">${v.verse}&#160;</span>${escapeHtml(v.text)}`)
    .join('  ');
  const tnav = [
    `<ul class='tnav'>`,
    `<li><a href='${code}.htm'>${escapeHtml(name)}</a></li>`,
    `<li><a href='${prevChapterHref(code, chap)}' aria-label='Capítulo anterior'>&lt;</a></li>`,
    `<li><a href='${nextChapterHref(code, chap, lastChap)}' aria-label='Capítulo siguiente'>&gt;</a></li>`,
    `</ul>`,
  ].join('');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<link rel="stylesheet" href="../gentiumplus.css" type="text/css" />
<meta name="viewport" content="user-scalable=yes, initial-scale=1, minimum-scale=1, width=device-width"/>
<title>${escapeHtml(title)}</title>
<meta name="keywords" content="La Sagrada Biblia, Torres Amat, es, Sagrada Biblia, Escritura, Biblia, Antiguo Testamento, Nuevo Testamento, Evangelio" />
</head>
<body>
<a class="skip-link" href="#main">Saltar al contenido</a>
<a class="home-mark" href="../index.html" aria-label="Todos los libros">☰</a>
${tnav}
<main class="main" id="main">
<div class='mt'>${escapeHtml(name)}
</div><div class='chapterlabel' id="V0"> ${chap}</div><div class='p'> ${verseSpans} </div>
<div class="footnote">
<hr />
</div>
</main>${tnav}
</body></html>
`;
}

function renderBookToc(code, lastChap) {
  const name = ES_NAMES[code] || code;
  const lis = [];
  for (let c = 1; c <= lastChap; c++) {
    lis.push(`<li><a href='${chapterFileName(code, c)}'>${c}</a></li>`);
  }
  // Group into <ul class='tnav'> of 5, mirroring en/src/GEN.htm.
  const uls = [];
  for (let i = 0; i < lis.length; i += 5) {
    uls.push(`<ul class='tnav'>\n${lis.slice(i, i + 5).join('\n')}\n</ul>`);
  }
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset='utf-8' />
<meta name='viewport' content='width=device-width, initial-scale=1.0, user-scalable=no' />
<title>La Sagrada Biblia (Torres Amat) ${escapeHtml(name)}</title>
<link href="../gentiumplus.css" rel='stylesheet' />
</head>
<body class='chlist latin'>
<a class="skip-link" href="#main">Saltar al contenido</a>
<main id="main">
<p class="site-title"><a href='../'>Biblia católica (Torres Amat)</a></p><h1><a href='../index.html'>${escapeHtml(name)}</a></h1>
${uls.join('')}<ul class='tnav'>
<li><a href='${chapterFileName(code, 1)}'>1</a></li>
</ul>
</main>
</body></html>
`;
}

function renderCopyright() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<link rel="stylesheet" href="../gentiumplus.css" type="text/css" />
<meta name="viewport" content="user-scalable=yes, initial-scale=1, minimum-scale=1, width=device-width"/>
<title>La Sagrada Biblia (Torres Amat)</title>
<meta name="keywords" content="La Sagrada Biblia, Torres Amat, es, Sagrada Biblia, Escritura, Biblia, Antiguo Testamento, Nuevo Testamento, Evangelio" />
</head>
<body>
<a class="skip-link" href="#main">Saltar al contenido</a>
<ul class='tnav'>
<li><a href='../index.html'>&#8593; Índice</a></li>
</ul>
<main class="main meta" id="main">
<h1>La Sagrada Biblia (Torres Amat)</h1>
<h2>Traducción de Félix Torres Amat (1772–1847), publicada en 1825 (edición de 1836), traducida de la Vulgata latina</h2>
<p><span class="meta-label">Idioma:</span> español<br />
<span class="meta-label">Registro:</span> arcaico (análogo español del Douay-Rheims)<br />
<span class="meta-label">Traducción de:</span> Félix Torres Amat<br />
<span class="meta-label">Fuentes:</span> <a href='https://es.wikisource.org/wiki/La_Sagrada_Biblia_(XIII)'>Wikisource</a> (La Sagrada Biblia, textos de Félix Torres Amat), <a href='https://www.cervantesvirtual.com/'>Biblioteca Virtual Miguel de Cervantes</a></p>
<p>Texto de dominio público (el autor falleció en 1847). Texto limpio obtenido mediante la API de MediaWiki de Wikisource; los libros no transcritos en Wikisource se completan a partir de la capa OCR de los tomos escaneados en la Biblioteca Virtual Miguel de Cervantes.</p>
<div class="fine">Traducción: Félix Torres Amat, 1825 (edición de 1836), dominio público. Versión católica completa con deuterocanónicos. Hecha para uso personal; no se garantiza exactitud o integridad.</div>
</main>
</body></html>
`;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Book subpages (ns 0) — the real book→djvu-page-range source.
//
// Wikisource organizes books as "La Sagrada Biblia (N)/<BookName>" ns-0
// subpages. Each subpage transcludes one or more
//   <pages index="La Sagrada Biblia (M).djvu" from=A to=B />
// blocks (note M may differ from N — e.g. Tomo XV's epistles live in the
// (XIV).djvu scan). The Page: namespace of that djvu index, pages A..B,
// holds the verse text.
// ---------------------------------------------------------------------------

async function listBookSubpages() {
  const titles = [];
  let cont = '';
  do {
    const p = `action=query&list=allpages&apnamespace=0&apprefix=La_Sagrada_Biblia&aplimit=500${cont ? `&apcontinue=${encodeURIComponent(cont)}` : ''}`;
    const d = await apiJson(p);
    for (const pg of d.query.allpages) titles.push(pg.title);
    cont = (d.continue && d.continue.apcontinue) || '';
  } while (cont);
  // Keep only book subpages: must contain "/", must not be a volume root,
  // and must not be a front/back-matter subpage (Prólogo, Diccionario,
// Máximas, Diccionario/A, ...).
  const SKIP = /^(Pr[oó]logo|Diccionario|M[aá]ximas)/i;
  return titles.filter((t) => {
    if (!/\//.test(t)) return false;          // volume root like "La Sagrada Biblia (XIII)"
    const sub = t.split('/').slice(1).join('/');
    if (SKIP.test(sub)) return false;
    if (/^\d+$/.test(sub)) return false;       // chapter redirect like "...: Deuteronomio:1"
    return true;
  });
}

function parsePagesTransclusions(wt) {
  // Extract every <pages index="X.djvu" from=A to=B /> (from/to optional,
  // order-insensitive, attribute values may be unquoted digits).
  const out = [];
  const re = /<pages\b([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(wt))) {
    const body = m[1];
    const idx = (body.match(/index\s*=\s*"([^"]+)"/) || body.match(/index\s*=\s*'([^']+)'/) || body.match(/index\s*=\s*(\S+)/) || [])[1];
    const from = (body.match(/\bfrom\s*=\s*["']?(\d+)/) || [])[1];
    const to = (body.match(/\bto\s*=\s*["']?(\d+)/) || [])[1];
    if (!idx || from == null) continue;
    out.push({ djvu: idx, from: +from, to: to == null ? +from : +to });
  }
  return out;
}

// Manual page ranges for the OCR gap books — the 12 NT books Wikisource
// did not transcribe (2CO->HEB), sourced from scanning the IA PDF
// (lasagradabiblian1415torr) for ADVERTENCIA/CAPITULO-PRIMERO page pairs.
// Page numbers are 1:1 with the djvu/Wikisource numbering. The vision OCR
// cache (es/_raw/ocr/pages/<NNNN>_vision.txt) fills these in via
// fetchPageBody's OCR fallback.
const OCR_GAP_RANGES = {
  // Each range starts at the epistle title page (CAPITULO PRIMERO + vv1-3)
  // and ends at the page before the next book's ADVERTENCIA. Advertencia
  // pages inside the range (e.g. GAL pp311-312) are harmless — no
  // {{vers}} markers, so the vision model returns empty and the build skips.
  '2CO': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 266, to: 308 }] },
  'GAL': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 309, to: 334 }] },
  'EPH': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 336, to: 355 }] },
  'PHP': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 357, to: 371 }] },
  'COL': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 373, to: 385 }] },
  '1TH': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 387, to: 399 }] },
  '2TH': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 401, to: 407 }] },
  '1TI': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 409, to: 425 }] },
  '2TI': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 427, to: 437 }] },
  'TIT': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 439, to: 445 }] },
  'PHM': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 447, to: 449 }] },
  'HEB': { djvu: 'La Sagrada Biblia (XIV).djvu', pages: [{ from: 451, to: 500 }] },
};

async function loadBookRanges() {
  const subs = await listBookSubpages();
  const ranges = {}; // code -> { code, label, subpage, djvu, pages: [{from,to}] }
  for (const sub of subs) {
    const label = sub.split('/').pop();
    const code = labelToCode(label);
    if (!code) {
      console.log(`  [warn] unrecognized book label "${label}" (${sub})`);
      continue;
    }
    const p = `action=parse&page=${encodeURIComponent(sub)}&prop=wikitext`;
    const d = await apiJson(p);
    const wt = (d.parse && d.parse.wikitext && d.parse.wikitext['*']) || '';
    const tc = parsePagesTransclusions(wt);
    if (!tc.length) continue;
    // A book may transclude the same djvu across several <pages> blocks
    // (e.g. Judas: 577-577 and 578-583). All blocks in our corpus share one
    // djvu per book; merge into a single djvu + page list.
    const djvu = tc[0].djvu;
    ranges[code] = { code, label, subpage: sub, djvu, pages: tc.map((t) => ({ from: t.from, to: t.to })) };
  }
  // Merge in the OCR gap ranges (only for books Wikisource doesn't have).
  for (const [code, r] of Object.entries(OCR_GAP_RANGES)) {
    if (!ranges[code]) {
      ranges[code] = { code, label: ES_NAMES[code] || code, subpage: '(OCR)', djvu: r.djvu, pages: r.pages };
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Phase orchestration.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { _: [], tomo: [], sleep: SLEEP_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--probe') a.probe = true;
    else if (k === '--deep') a.deep = true;
    else if (k === '--fetch') a.fetch = true;
    else if (k === '--build') a.build = true;
    else if (k === '--allow-partial') a.allowPartial = true;
    else if (k === '--book') a.book = argv[++i];
    else if (k === '--tomo') a.tomo.push(argv[++i]);
    else if (k === '--sleep') a.sleep = +argv[++i];
    else a._.push(k);
  }
  return a;
}

// Select book ranges by --tomo (roman numeral in the djvu index name) and/or
// --book (a single 3-letter code). With no filter, all book ranges selected.
function selectRanges(bookRanges, args) {
  const codes = Object.keys(bookRanges);
  if (args.book) return codes.filter((c) => c === args.book).map((c) => bookRanges[c]);
  if (!args.tomo.length) return codes.map((c) => bookRanges[c]);
  const want = new Set(args.tomo.map((t) => t.toUpperCase()));
  return codes.filter((c) => {
    const m = /\(([^)]+)\)/.exec(bookRanges[c].djvu);
    const rom = m && m[1].toUpperCase();
    return rom && want.has(rom);
  }).map((c) => bookRanges[c]);
}

async function loadIndexes() {
  const idx = await listIndexes();
  const out = [];
  for (const title of idx) {
    const p = `action=parse&page=${encodeURIComponent(title)}&prop=wikitext`;
    const d = await apiJson(p);
    const wt = (d.parse && d.parse.wikitext && d.parse.wikitext['*']) || '';
    const parsed = parseIndex(wt);
    out.push({ title, ...parsed });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.sleep) { /* override global */ Object.defineProperty(globalThis, '_sleep', { value: args.sleep }); }

  fs.mkdirSync(API_CACHE, { recursive: true });
  fs.mkdirSync(PAGE_CACHE, { recursive: true });

  if (args.probe) {
    await runProbe(args);
  } else if (args.fetch) {
    await runFetch(args);
  } else if (args.build) {
    await runBuild(args);
  } else {
    console.error('usage: acquire-es.js --probe [--deep] [--tomo XIII ...] [--sleep N] [--allow-partial]');
    console.error('       acquire-es.js --fetch [--tomo XIII ...] [--book CODE]');
    console.error('       acquire-es.js --build [--tomo XIII ...] [--book CODE]');
    process.exit(2);
  }
}

async function runProbe(args) {
  console.log('== S2: Wikisource coverage probe ==\n');
  const indexes = await loadIndexes();
  console.log(`Djvu Index pages: ${indexes.length}`);
  for (const ix of indexes) {
    console.log(`  ${ix.title}  (Progreso=${ix.progreso || '?'}, IA=${ix.iaSource || '?'})`);
  }
  console.log('');

  const bookRanges = await loadBookRanges();
  console.log(`Book subpages mapped: ${Object.keys(bookRanges).length}/73\n`);

  // Page-namespace proofread quality, cached per djvu index name.
  const qByDjvu = {};
  async function qFor(djvu) {
    if (!qByDjvu[djvu]) qByDjvu[djvu] = await listPagesWithQuality(djvu);
    return qByDjvu[djvu];
  }
  // Report per-djvu quality totals for every djvu we touch.
  const djvuSeen = new Set(Object.values(bookRanges).map((r) => r.djvu));
  for (const djvu of [...djvuSeen].sort()) {
    const pages = await qFor(djvu);
    const qcount = [0, 0, 0, 0, 0];
    for (const p of pages) qcount[p.quality] = (qcount[p.quality] || 0) + 1;
    const good = (qcount[3] || 0) + (qcount[4] || 0);
    console.log(`${djvu}: ${pages.length} pages, quality[0..4]=${qcount.join(',')}, proofread+validated=${good}`);
  }
  console.log('');

  console.log("== Book-level coverage (djvu pages in the book's range that are proofread) ==\n");
  const canonBooks = Object.keys(CANON);
  let coveredBooks = 0;
  let coveredChapters = 0; // approximate: a book counts as chapter-covered if all its pages are proofread
  const rows = [];
  for (const code of canonBooks) {
    const want = CANON[code];
    const r = bookRanges[code];
    if (!r) { rows.push(`${code} ${ES_NAMES[code]}: MISSING (no Wikisource subpage)`); continue; }
    const pages = await qFor(r.djvu);
    const nums = new Set(pages.map((p) => p.num));
    let inRange = 0, good = 0, missing = 0;
    for (const seg of r.pages) {
      for (let n = seg.from; n <= seg.to; n++) {
        inRange++;
        const p = pages.find((x) => x.num === n);
        if (!p) { missing++; continue; }
        if (p.quality >= 3) good++;
      }
    }
    const tag = good === 0 ? 'NO-PROOFREAD' : (missing === 0 && good === inRange ? 'CLEAN' : 'PARTIAL');
    rows.push(`${code} ${ES_NAMES[code]}: ${r.djvu} pp=${r.pages.map((s) => s.from + '-' + s.to).join(',')} (${inRange}pp), proofread ${good}/${inRange}, missing ${missing} [${tag}]`);
    if (good > 0) coveredBooks++;
    if (tag === 'CLEAN') coveredChapters += want;
  }
  for (const r of rows) console.log('  ' + r);
  console.log(`\nBooks with any proofread text: ${coveredBooks}/${canonBooks.length}`);
  console.log(`Approx. clean chapter coverage: ${coveredChapters}/${Object.values(CANON).reduce((a, b) => a + b, 0)}`);
}

async function runFetch(args) {
  const bookRanges = await loadBookRanges();
  const selected = selectRanges(bookRanges, args);
  if (!selected.length) { console.log('no books matched the filter'); return; }
  let fetched = 0, skipped = 0;
  for (const r of selected) {
    const pages = await listPagesWithQuality(r.djvu);
    const want = new Set();
    for (const seg of r.pages) for (let n = seg.from; n <= seg.to; n++) want.add(n);
    const todo = pages.filter((p) => want.has(p.num));
    console.log(`${r.code} ${ES_NAMES[r.code]}: ${r.djvu} pages ${[...want].sort((a,b)=>a-b).map(n=>String(n)).slice(0,3).join(',')}… (${todo.length} existing)`);
    for (const p of todo) {
      const wt = await fetchPageBody(r.djvu, p.num);
      if (wt && wt.trim()) fetched++; else skipped++;
    }
  }
  console.log(`\nFetched: ${fetched}, empty/skipped: ${skipped}`);
}

async function runBuild(args) {
  const bookRanges = await loadBookRanges();
  const selected = selectRanges(bookRanges, args);
  if (!selected.length) { console.log('no books matched the filter'); return; }
  fs.mkdirSync(SRC_DIR, { recursive: true });
  const summary = [];
  for (const r of selected) {
    const code = r.code;
    const lastChap = CANON[code];
    const chapters = {}; // chap -> { verseNum -> text }
    for (const seg of r.pages) {
      for (let n = seg.from; n <= seg.to; n++) {
        const wt = await fetchPageBody(r.djvu, n);
        if (!wt || !wt.trim()) continue;
        const verses = parsePageVerses(wt);
        for (const v of verses) {
          if (v.chapter < 1 || v.chapter > lastChap) continue;
          // Guard against Wikisource verse-number typos (e.g. {{vers|26|212}}
          // for verse 22). No canonical verse exceeds 176 (Psalm 119); drop
          // anything > 200 and flag it for the cleanup pass.
          if (v.verse > 200) {
            console.log(`  [warn] ${code} ch${v.chapter} v${v.verse} dropped (out-of-range; likely a source typo)`);
            continue;
          }
          if (!v.text) continue;
          chapters[v.chapter] = chapters[v.chapter] || {};
          // Later pages overwrite earlier for the same verse num (corrections
          // usually win); but if both have non-empty text, concatenate to
          // avoid dropping continuation text.
          if (chapters[v.chapter][v.verse] && chapters[v.chapter][v.verse] !== v.text) {
            chapters[v.chapter][v.verse] += ' ' + v.text;
          } else {
            chapters[v.chapter][v.verse] = v.text;
          }
          // Re-normalize after join to catch cross-page artifacts
          // (hyphen-breaks and word splits that span page boundaries).
          chapters[v.chapter][v.verse] = normalizeText(chapters[v.chapter][v.verse]);
        }
      }
    }
    const emitted = [];
    for (let c = 1; c <= lastChap; c++) {
      const byNum = chapters[c];
      if (!byNum) { emitted.push({ c, ok: false }); continue; }
      const verses = Object.keys(byNum).map(Number).sort((a, b) => a - b)
        .map((n) => ({ verse: n, text: byNum[n] }))
        .filter((v) => v.text);
      if (!verses.length) { emitted.push({ c, ok: false }); continue; }
      const html = renderChapter(code, c, lastChap, verses);
      fs.writeFileSync(path.join(SRC_DIR, chapterFileName(code, c)), html);
      emitted.push({ c, ok: true, verses: verses.length, maxV: verses[verses.length - 1].verse });
    }
    fs.writeFileSync(path.join(SRC_DIR, `${code}.htm`), renderBookToc(code, lastChap));
    const okCount = emitted.filter((e) => e.ok).length;
    const maxV = Math.max(...emitted.filter((e) => e.ok).map((e) => e.maxV || 0));
    summary.push(`${code} ${ES_NAMES[code]}: ${okCount}/${lastChap} chapters, max verse ${maxV}`);
    console.log(summary[summary.length - 1]);
  }

  if (!args.tomo.length && !args.book) {
    fs.writeFileSync(path.join(SRC_DIR, 'copyright.htm'), renderCopyright());
  }

  console.log('\n== Build summary ==');
  for (const s of summary) console.log('  ' + s);
}

main().catch((e) => {
  console.error('acquire-es: error:', e.stack || e);
  process.exit(1);
});
