#!/usr/bin/env python3
# ocr-page.py — render a PDF page to PNG and run the non-vision OCR paths.
#
# Produces, for a given IA PDF page number (1:1 with the djvu/Wikisource
# page numbering):
#   es/_raw/ocr/pages/<p>_image.png        — 300 DPI render (input to vision)
#   es/_raw/ocr/pages/<p>_ia.txt           — IA's existing PDF text layer
#   es/_raw/ocr/pages/<p>_tess.txt         — tesseract -l spa output
#   es/_raw/ocr/pages/<p>_tess.tsv         — tesseract TSV (word + bbox)
#
# The vision path (vision-transcribe.py) consumes <p>_image.png and writes
# <p>_vision.txt. The compare step (ocr-compare.py) diffs all three.
#
# Usage:
#   python3 ocr-page.py --pdf es/_raw/ocr/lasagradabiblian1415torr.pdf \
#                       --pages 265 266 267 268 269
#   python3 ocr-page.py --pdf ... --range 265-500

import argparse, os, subprocess, sys, pathlib

def render_and_ocr(pdf, page, outdir, dpi=300, skip_existing=False):
    import fitz
    doc = fitz.open(pdf)
    if page < 1 or page > doc.page_count:
        print(f'  [skip] page {page} out of range (1..{doc.page_count})')
        return False
    img = outdir / f'{page:04d}_image.png'
    ia  = outdir / f'{page:04d}_ia.txt'
    tess= outdir / f'{page:04d}_tess.txt'
    tsv = outdir / f'{page:04d}_tess.tsv'
    if skip_existing and img.exists() and ia.exists() and tess.exists():
        return True
    page_obj = doc[page - 1]
    page_obj.get_pixmap(dpi=dpi).save(str(img))
    ia_text = page_obj.get_text()
    ia.write_text(ia_text)
    # tesseract: text + TSV (word-level boxes, useful for verse-number
    # disambiguation downstream — verse numbers sit in the left margin and
    # are smaller than body text).
    subprocess.run(['tesseract', str(img), str(tess).rsplit('.',1)[0],
                    '-l', 'spa', '--psm', '6'], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['tesseract', str(img), str(tsv).rsplit('.',1)[0],
                    '-l', 'spa', '--psm', '6', 'tsv'], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', required=True)
    ap.add_argument('--pages', type=int, nargs='*')
    ap.add_argument('--range', dest='rng')
    ap.add_argument('--outdir', default='es/_raw/ocr/pages')
    ap.add_argument('--dpi', type=int, default=300)
    ap.add_argument('--skip-existing', action='store_true')
    args = ap.parse_args()
    outdir = pathlib.Path(args.outdir); outdir.mkdir(parents=True, exist_ok=True)
    pages = []
    if args.pages: pages = args.pages
    if args.rng:
        a, b = args.rng.split('-'); pages += list(range(int(a), int(b) + 1))
    if not pages:
        sys.exit('no pages specified')
    for p in pages:
        ok = render_and_ocr(args.pdf, p, outdir, args.dpi, args.skip_existing)
        if ok: print(f'page {p}: rendered + tesseract + IA text layer')

if __name__ == '__main__':
    main()
