#!/usr/bin/env bash
# vision-transcribe-pi.sh — transcribe Bible page images via pi + Kimi
# (fireworks/accounts/fireworks/models/kimi-k2p7-code), vision-capable.
#
# This is the vision path of the OCR pipeline. It reuses the prompt from
# vision-transcribe.py but drives pi's CLI (which already has the Fireworks
# key in ~/.pi/agent/auth.json) instead of requiring a separate Moonshot
# key. Output is the same {{vers|chapter|verse}} text format that
# acquire-es.js's parsePageVerses consumes.
#
# Usage:
#   ./vision-transcribe-pi.sh <pages-dir> <page1> [page2 ...]
#   ./vision-transcribe-pi.sh es/_raw/ocr/pages 266 267 268 269
#
# Reads  <pages-dir>/<NNNN>_image.png
# Writes <pages-dir>/<NNNN>_vision.txt   (cached; rm to re-run)
#
# Each page takes ~30-40s and ~1 vision call. Pages are processed
# sequentially (Fireworks rate-limits). Set PI_MODEL to override the model.

set -euo pipefail

PAGES_DIR="${1:?usage: $0 <pages-dir> <page1> [page2 ...]}"
shift
MODEL="${PI_MODEL:-accounts/fireworks/models/kimi-k2p7-code}"

PROMPT='Eres un transcriptor experto de textos españoles antiguos del siglo XIX. Transcribes páginas de La Sagrada Biblia, traducción de Félix Torres Amat (1825, edición de 1836), biblia católica española traducida de la Vulgata latina. Tu transcripción será publicada como texto de la biblia; la exactitud ortográfica y de numeración de versículos es crítica.

Instrucciones estrictas:
1. Transcribe EXACTAMENTE lo que ves. No modernices la ortografía. Conserva los acentos etimológicos de 1836: á, é, í, ó, ú; palabras como Christo, Jesus, José, María, vosotros, así, está, fué, dió, vió. Conserva la ñ. Si ves la s larga (ſ), transcríbela como s.
2. La página contiene un encabezado CAPÍTULO N. (o CAPITULO N.) y versículos numerados. El número de cada versículo aparece al inicio del mismo, a veces en el margen izquierdo (pequeño) y a veces inline. Léelo con cuidado — confundir un 7 por un 4, un 8 por una S, un 1 por un 7 es el error más común y el más grave.
3. Ignora por completo: el número de página impreso, los encabezados de página corrientes (ej. "EPÍST. II. DE S. PABLO A LOS CORINTHIOS"), las notas al pie y las referencias marginales (ej. "Act. XIX. v. 24,"), y cualquier texto del margen que no sea el número de versículo. Las referencias bíblicas marginales y las notas NO son texto sagrado.
4. Si la página empieza con un encabezado CAPÍTULO N., ese es el capítulo activo. Si NO hay encabezado de capítulo, el capítulo es el que se te indique abajo como pista (capítulo activo = __CHAPTER_HINT__); los versículos continúan ese capítulo.
5. Une las palabras partidas por guión al final de línea: "consola-cion" → "consolacion". No insertes guiones donde no los haya.
6. Emite CADA versículo en una línea, en este formato exacto:
   {{vers|<capitulo>|<versiculo>}} <texto del versiculo>
   donde <capitulo> y <versiculo> son números arábigos sin ceros a la izquierda. El texto del versículo va en una sola línea (une los saltos de línea del original con espacios).
7. Si hay texto que pertenece al versículo anterior al inicio de la página (continuación de la página previa), emítelo como {{vers|<cap>|<vers>}} <texto> con el número de versículo correcto, aunque ese versículo ya se haya empezado en la página anterior — el proceso de construcción lo deduplicará.
8. No emitas NADA que no sea una línea {{vers|...}}. No expliques, no comentes, no pongas marcas de código. Solo las líneas de versículos.
9. Si una porción de texto no tiene número de versículo visible y no es continuación evidente de un versículo anterior, omítela (probablemente es una nota o encabezado).

Capítulo activo (pista): __CHAPTER_HINT__. Transcribe ahora la página de la imagen.'

for page in "$@"; do
  stem=$(printf "%04d" "$page")
  img="$PAGES_DIR/${stem}_image.png"
  out="$PAGES_DIR/${stem}_vision.txt"
  if [ -s "$out" ]; then
    echo "$stem: vision cached"; continue
  fi
  if [ ! -f "$img" ]; then
    echo "$stem: no image (run ocr-page.py first)"; continue
  fi
  hint="${CHAPTER_HINT:-1}"
  prompt="${PROMPT//__CHAPTER_HINT__/$hint}"
  echo "$stem: calling pi + $MODEL ..."
  # Drive pi in JSON mode, extract only the assistant text deltas, strip the
  # tool-use scaffolding (pi may call read/bash reflexively; we want only
  # the final transcription text).
  pi --provider fireworks --model "$MODEL" --mode json -p \
     --no-context-files --no-approve \
     "$prompt" "@$img" 2>/dev/null \
    | python3 -c "
import json,sys
buf=[]
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except: continue
    t=e.get('type')
    if t=='message_update' and e.get('assistantMessageEvent',{}).get('type')=='text_delta':
        buf.append(e['assistantMessageEvent']['delta'])
    elif t=='tool_execution_start':
        # A tool call means the model went off-script (tried to read a file
        # etc.). Print to stderr so we see it but don't pollute the output.
        import os
        print(f'[tool] {e.get(\"toolName\")} {e.get(\"args\")}', file=sys.stderr)
text=''.join(buf)
# Keep only {{vers|...}} lines (strip any stray prose the model emitted).
import re
lines=[l for l in text.splitlines() if re.match(r'^\s*\{\{vers\|', l)]
sys.stdout.write('\n'.join(lines)+'\n')
" > "$out"
  if [ -s "$out" ]; then
    echo "$stem: OK ($(wc -l < "$out") verse lines)"
  else
    echo "$stem: EMPTY (check /tmp/pi-debug or re-run)"; rm -f "$out"
  fi
done
