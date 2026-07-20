#!/usr/bin/env python3
"""
Swap the destinations of the book-name pill and the current-chapter pill in
every chapter-page tnav, so each pill's label matches where it goes:
  - book-name pill  ("Genesis"): ../index.html  ->  BOOK.htm  (this book's chapter list)
  - current chapter ("1"):       BOOK.htm       ->  ../index.html (all-books index)

Operates on the 1335 chapter .htm files (those whose first tnav pill links to
../index.html). Book-TOC pages (BOOK.htm) and copyright.htm are left alone.

Byte-level (bytes mode) to preserve mixed CRLF/LF line endings. Idempotent:
a second run is a no-op because the post-swap first pill links to BOOK.htm,
which the script's guard detects.

Pattern in every chapter file (top + bottom tnav, identical bytes):
  <ul class='tnav'>
  <li><a href='../index.html'>BookName</a></li>
  <li><a href='../index.html' aria-label='Previous chapter'>&lt;</a></li>
  <li><a href='BOOK.htm' aria-current='page'>N</a></li>
  <li><a href='BOOKXX.htm' aria-label='Next chapter'>&gt;</a></li>
  </ul>
"""
import re, sys, glob, os

SRC = os.path.join(os.path.dirname(__file__), "src")

# Matches a full <ul class='tnav'>...</ul> block on a chapter page:
# exactly 4 <li>s, 1st href=../index.html (no aria-label), 3rd has
# aria-current='page'. Captures the 1st href and the 3rd href so we can swap.
# The 2nd and 4th <li>s are matched but not captured (we don't touch them).
# Line endings are \r\n in the body region of these files (mixed CRLF/LF,
# see 2026-07-18 a11y memory), so use \r?\n for each line break.
CHAPTER_TNAV = re.compile(
    rb"<ul class='tnav'>\r?\n"
    rb"<li><a href='\.\./index\.html'>([^<]*)</a></li>\r?\n"          # group 1 = book name text
    rb"<li><a href='([^']+)' aria-label='Previous chapter'>&lt;</a></li>\r?\n"  # group 2 = prev href
    rb"<li><a href='([^']+)' aria-current='page'>([^<]*)</a></li>\r?\n"         # group 3 = cur href (BOOK.htm), group 4 = chapter num
    rb"<li><a href='([^']+)' aria-label='Next chapter'>&gt;</a></li>\r?\n"      # group 5 = next href
    rb"</ul>",
    re.DOTALL,
)

def swap_block(m):
    book_text, prev_href, cur_href, chap_num, next_href = m.groups()
    # Preserve the original line ending (\r\n or \n) — pull it from the
    # match rather than hardcoding, so we don't normalize endings.
    nl = b"\r\n" if b"\r\n" in m.group(0) else b"\n"
    # Swap: 1st pill now goes to the chapter list (cur_href), 3rd pill goes to the index.
    return (
        b"<ul class='tnav'>" + nl +
        b"<li><a href='" + cur_href + b"'>" + book_text + b"</a></li>" + nl +
        b"<li><a href='" + prev_href + b"' aria-label='Previous chapter'>&lt;</a></li>" + nl +
        b"<li><a href='../index.html' aria-current='page'>" + chap_num + b"</a></li>" + nl +
        b"<li><a href='" + next_href + b"' aria-label='Next chapter'>&gt;</a></li>" + nl +
        b"</ul>"
    )

changed = 0
skipped = 0
errors = 0
for path in sorted(glob.glob(os.path.join(SRC, "*.htm"))):
    with open(path, "rb") as f:
        d = f.read()
    if b"<li><a href='../index.html'>" not in d:
        skipped += 1   # book-TOC / copyright — not a chapter page
        continue
    new, n = CHAPTER_TNAV.subn(swap_block, d)
    if n == 0:
        # Has the index-link first pill but the tnav didn't match the strict
        # 4-li pattern. Investigate rather than silently skip.
        print(f"WARN no-match (but has index pill): {os.path.basename(path)}", file=sys.stderr)
        errors += 1
        continue
    # Idempotency guard: after the swap, the first pill links to BOOK.htm, not
    # ../index.html. So a second run finds n==0 swaps in already-swapped files
    # — but those files still contain "../index.html" in the 3rd pill, so the
    # `b"<li><a href='../index.html'>" not in d` filter above WON'T skip them.
    # Detect that case explicitly:
    if d == new:
        continue
    if new != d:
        with open(path, "wb") as f:
            f.write(new)
        changed += 1

print(f"changed={changed} skipped={skipped} errors={errors}")
