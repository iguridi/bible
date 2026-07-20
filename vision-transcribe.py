#!/usr/bin/env python3
# vision-transcribe.py — batch vision transcription via pi + Kimi, with
# automatic chapter tracking across pages.
#
# Drives `pi` (which already has the Fireworks/Kimi key in
# ~/.pi/agent/auth.json) on each page image. Parses each page's
# {{vers|chap|verse}} output to detect chapter resets (verse 1 after a
# non-1 verse, or a chapter number higher than the current one) and carries
# the running chapter forward as the hint for the next page.
#
# Usage:
#   python3 vision-transcribe.py --pages-dir es/_raw/ocr/pages \
#       --pdf es/_raw/ocr/lasagradabiblian1415torr.pdf \
#       --range 266-308 --start-chapter 1
#
# Reads  <pages-dir>/<NNNN>_image.png  (renders from PDF if missing)
# Writes <pages-dir>/<NNNN>_vision.txt (cached; --force to overwrite)

import argparse, base64, json, os, pathlib, re, subprocess, sys, time

PROMPT_TEMPLATE = '''Eres un transcriptor experto de textos españoles antiguos del siglo XIX. Transcribes páginas de La Sagrada Biblia, traducción de Félix Torres Amat (1825, edición de 1836), biblia católica española traducida de la Vulgata latina. Tu transcripción será publicada como texto de la biblia; la exactitud ortográfica y de numeración de versículos es crítica.

Instrucciones estrictas:
1. Transcribe EXACTAMENTE lo que ves. No modernices la ortografía. Conserva los acentos etimológicos de 1836: á, é, í, ó, ú; palabras como Christo, Jesus, José, María, vosotros, así, está, fué, dió, vió. Conserva la ñ. Si ves la s larga (ſ), transcríbela como s.
2. La página contiene un encabezado CAPÍTULO N. (o CAPITULO N.) y versículos numerados. El número de cada versículo aparece al inicio del mismo, a veces en el margen izquierdo (pequeño) y a veces inline. Léelo con cuidado — confundir un 7 por un 4, un 8 por una S, un 1 por un 7 es el error más común y el más grave. Ten especial cuidado con los números de versículo al FINAL de una página (justo antes de un encabezado CAPÍTULO del capítulo siguiente) y al INICIO de una página (continuación del versículo final de la página anterior): esos números a veces están al borde del margen y son fáciles de pasar por alto. Si después de un versículo N el texto continúa con lo que parece ser un nuevo versículo pero sin número visible, examina el margen izquierdo con cuidado: casi siempre hay un número pequeño ahí.
3. Ignora por completo: el número de página impreso, los encabezados de página corrientes (ej. "EPÍST. II. DE S. PABLO A LOS CORINTHIOS"), las notas al pie y las referencias marginales (ej. "Act. XIX. v. 24,"), y cualquier texto del margen que no sea el número de versículo. Las referencias bíblicas marginales y las notas NO son texto sagrado.
4. Si la página empieza con un encabezado CAPÍTULO N., ese es el capítulo activo para los versículos que vienen DESPUÉS del encabezado. PERO si hay versículos ANTES del primer encabezado CAPÍTULO de la página (continuación del capítulo anterior al inicio de la página), esos versículos pertenecen al capítulo activo dado como pista abajo (capítulo activo = __CHAPTER_HINT__), no al nuevo. Emitelos con el número de capítulo de la pista. Solo los versículos DESPUÉS de un encabezado CAPÍTULO usan el nuevo número de capítulo. Si NO hay encabezado de capítulo en la página, todos los versículos continúan el capítulo de la pista.
5. Une las palabras partidas por guión al final de línea: "consola-cion" → "consolacion". No insertes guiones donde no los haya.
6. Emite CADA versículo en una línea, en este formato exacto:
   {{vers|<capitulo>|<versiculo>}} <texto del versiculo>
   donde <capitulo> y <versiculo> son números arábigos sin ceros a la izquierda. El texto del versículo va en una sola línea (une los saltos de línea del original con espacios).
7. Si hay texto que pertenece al versículo anterior al inicio de la página (continuación de la página previa), emítelo como {{vers|<cap>|<vers>}} <texto> con el número de versículo correcto, aunque ese versículo ya se haya empezado en la página anterior — el proceso de construcción lo deduplicará.
8. No emitas NADA que no sea una línea {{vers|...}}. No expliques, no comentes, no pongas marcas de código. Solo las líneas de versículos.
9. Si una porción de texto no tiene número de versículo visible y no es continuación evidente de un versículo anterior, omítela (probablemente es una nota o encabezado).

Capítulo activo (pista): __CHAPTER_HINT__. Transcribe ahora la página de la imagen.'''

VERS_RE = re.compile(r'\{\{vers\|(\d+)\|(\d+)\}\}')

def render_page(pdf, page, outdir, dpi=300):
    import fitz
    doc = fitz.open(pdf)
    if page < 1 or page > doc.page_count:
        return None
    img = outdir / f'{page:04d}_image.png'
    if not img.exists():
        doc[page - 1].get_pixmap(dpi=dpi).save(str(img))
    return img

def call_pi(model, prompt, img_path):
    """Drive pi in JSON mode, return concatenated assistant text deltas."""
    cmd = ['pi', '--provider', 'fireworks', '--model', model,
           '--mode', 'json', '-p', '--no-context-files', '--no-approve',
           prompt, f'@{img_path}']
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    deltas = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line: continue
        try: e = json.loads(line)
        except: continue
        if (e.get('type') == 'message_update'
                and e.get('assistantMessageEvent', {}).get('type') == 'text_delta'):
            deltas.append(e['assistantMessageEvent']['delta'])
    return ''.join(deltas)

def detect_chapter(text, current_chapter):
    """From a page's {{vers|c|v}} output, infer the running chapter.
    Use the max chapter seen; if a verse-1 appears with a higher chapter
    number, that's the new chapter."""
    chapters = set()
    for m in VERS_RE.finditer(text):
        chapters.add(int(m.group(1)))
    if not chapters: return current_chapter
    # The chapter for the page is the one that appears most; bump to max
    # if a higher one shows up (chapter heading on this page).
    return max(chapters)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pages-dir', default='es/_raw/ocr/pages')
    ap.add_argument('--pdf', default='es/_raw/ocr/lasagradabiblian1415torr.pdf')
    ap.add_argument('--range', dest='rng', required=True, help='e.g. 266-308')
    ap.add_argument('--start-chapter', type=int, default=1)
    ap.add_argument('--model', default='accounts/fireworks/models/kimi-k2p7-code')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--sleep', type=float, default=1.0)
    args = ap.parse_args()
    outdir = pathlib.Path(args.pages_dir); outdir.mkdir(parents=True, exist_ok=True)
    a, b = args.rng.split('-'); pages = list(range(int(a), int(b) + 1))
    chapter = args.start_chapter
    for p in pages:
        stem = f'{p:04d}'
        img = render_page(args.pdf, p, outdir)
        if img is None:
            print(f'{stem}: page out of range'); continue
        out = outdir / f'{stem}_vision.txt'
        if out.exists() and not args.force:
            txt = out.read_text(encoding='utf-8')
            chapter = detect_chapter(txt, chapter)
            print(f'{stem}: cached (ch{chapter}, {len(txt.splitlines())} lines)')
            continue
        prompt = PROMPT_TEMPLATE.replace('__CHAPTER_HINT__', str(chapter))
        print(f'{stem}: pi + {args.model}, hint ch{chapter} ...', flush=True)
        t0 = time.time()
        try:
            raw = call_pi(args.model, prompt, str(img))
        except subprocess.TimeoutExpired:
            print(f'{stem}: TIMEOUT'); break
        # Keep only {{vers|...}} lines.
        lines = [l for l in raw.splitlines() if VERS_RE.match(l.strip())]
        txt = '\n'.join(lines) + '\n'
        out.write_text(txt, encoding='utf-8')
        new_ch = detect_chapter(txt, chapter)
        dt = time.time() - t0
        print(f'{stem}: OK ch{chapter}→ch{new_ch} ({len(lines)} verses, {dt:.0f}s)')
        chapter = new_ch
        if args.sleep: time.sleep(args.sleep)
    print(f'done. running chapter = {chapter}')

if __name__ == '__main__':
    main()
