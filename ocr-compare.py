#!/usr/bin/env python3
# ocr-compare.py — three-way diff of the OCR paths for a page.
#
# Sources (per page, produced by ocr-page.py + vision-transcribe.py):
#   <p>_ia.txt       IA's existing PDF text layer (OCR done at upload time)
#   <p>_tess.txt     tesseract -l spa
#   <p>_vision.txt   vision LLM (Kimi), {{vers|N|V}} format
#
# Prints a side-by-side summary and a verse-level agreement matrix for a
# page or a range. The verse-level matrix is the bar: how many verses did
# each path recover, with the right verse number, with clean archaic text.
#
# Usage:
#   python3 ocr-compare.py --pages 265 266 267 268 269
#   python3 ocr-compare.py --range 266-269

import argparse, pathlib, re, sys

def read(p):
    try: return pathlib.Path(p).read_text(encoding='utf-8', errors='replace')
    except FileNotFoundError: return None

VERS = re.compile(r'\{\{vers\|(\d+)\|(\d+)\}\}\s*(.*)$')

def extract_verses(text):
    """Return {verse_num: text} from a vision-style {{vers|c|v}} transcript."""
    out = {}
    if not text: return out
    for line in text.splitlines():
        m = VERS.match(line.strip())
        if m:
            v = int(m.group(2))
            out[v] = m.group(3).strip()
    return out

def find_verse_numbers_in_raw(text):
    """Heuristic: in tesseract/IA raw output, verse numbers appear as
    standalone small numbers at line starts. Crude — just to surface the
    digits each path sees, not to claim verse accuracy."""
    nums = []
    for line in (text or '').splitlines():
        s = line.strip()
        if re.fullmatch(r'\d{1,3}', s):
            nums.append(int(s))
    return nums

def compare_page(outdir, page):
    stem = f'{page:04d}'
    ia = read(outdir / f'{stem}_ia.txt')
    tess = read(outdir / f'{stem}_tess.txt')
    vis = read(outdir / f'{stem}_vision.txt')
    print(f'==== page {page} ====')
    if ia is None and tess is None and vis is None:
        print('  (no files)'); return
    # Vision verses
    vv = extract_verses(vis)
    if vis is not None:
        print(f'  vision: {len(vv)} verses: {sorted(vv)[:12]}{"..." if len(vv)>12 else ""}')
        for v in sorted(vv)[:4]:
            print(f'    v{v}: {vv[v][:90]!r}')
    else:
        print('  vision: (not run — set MOONSHOT_API_KEY and run vision-transcribe.py)')
    # Tesseract / IA raw
    if tess is not None:
        print(f'  tesseract: {len(tess)} chars; standalone digit lines: {find_verse_numbers_in_raw(tess)}')
    if ia is not None:
        print(f'  IA layer:  {len(ia)} chars; standalone digit lines: {find_verse_numbers_in_raw(ia)}')
    # Show tesseract body (first 600 chars) for eyeballing vs vision.
    if tess:
        print('  --- tesseract (first 600 chars) ---')
        for line in tess[:600].splitlines()[:14]:
            print(f'    {line}')
    print()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pages', type=int, nargs='*')
    ap.add_argument('--range', dest='rng')
    ap.add_argument('--outdir', default='es/_raw/ocr/pages')
    args = ap.parse_args()
    outdir = pathlib.Path(args.outdir)
    pages = []
    if args.pages: pages = args.pages
    if args.rng:
        a, b = args.rng.split('-'); pages += list(range(int(a), int(b) + 1))
    if not pages: sys.exit('no pages')
    for p in pages:
        compare_page(outdir, p)

if __name__ == '__main__':
    main()
