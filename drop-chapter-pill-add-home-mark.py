#!/usr/bin/env python3
"""
Two changes to every chapter-page tnav (1334 files):

1. DROP the current-chapter <li> (the 3rd of 4) from each tnav. The chapter
   number is redundant — it already shows as the .chapterlabel subtitle
   below the nav — and its destination (../index.html, after the prior
   destination swap) was unintuitive. Removing it leaves a 3-pill bar:
     [Book name → BOOK.htm]   [‹ Prev]   [Next ›]
   (the CSS reorders to [‹ Prev] [Book name] [Next ›]).

2. INJECT a subtle home-mark link to the all-books index in the top-left
   corner, immediately after the skip-link and before the FIRST tnav only
   (not the bottom tnav — one logo per page):
     <a class="home-mark" href="../index.html" aria-label="All books">✦</a>

Byte-level (bytes mode) to preserve mixed CRLF/LF line endings. Idempotent:
both the drop and the inject are guarded so a second run is a no-op.

Book-TOC pages (BOOK.htm) and copyright.htm are NOT chapter pages and are
left alone (they don't match the chapter tnav pattern).
"""
import re, sys, glob, os

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")

# A chapter-page tnav with exactly 4 <li>s: book-name, prev (aria-label),
# current (aria-current='page'), next (aria-label). CRLF or LF line breaks.
# After this edit the current-chapter <li> (group 3) is removed.
CHAPTER_TNAV_4 = re.compile(
    rb"<ul class='tnav'>(\r?\n)"
    rb"<li><a href='([^']+)'>([^<]*)</a></li>(\r?\n)"                        # 1st: book name → BOOK.htm
    rb"<li><a href='([^']+)' aria-label='Previous chapter'>&lt;</a></li>(\r?\n)"  # 2nd: prev
    rb"<li><a href='([^']+)' aria-current='page'>([^<]*)</a></li>(\r?\n)"         # 3rd: current (TO DROP)
    rb"<li><a href='([^']+)' aria-label='Next chapter'>&gt;</a></li>(\r?\n)"      # 4th: next
    rb"</ul>",
    re.DOTALL,
)

HOME_MARK = (b'<a class="home-mark" href="../index.html" aria-label="All books">'
             b"\xe2\x9c\xa6</a>\r\n")  # ✦ U+2726 BLACK FOUR POINTED STAR

def drop_current_li(m):
    # 11 groups: 1=nl1, 2=book_href, 3=book_text, 4=nl2, 5=prev_href,
    #           6=nl3, 7=cur_href, 8=cur_text, 9=nl4, 10=next_href, 11=nl5
    nl1, book_href, book_text, nl2, prev_href, nl3, cur_href, cur_text, nl4, next_href, nl5 = m.groups()
    # Reassemble WITHOUT the 3rd <li> (cur_href/cur_text dropped). Reuse the
    # captured line endings so we don't normalize CRLF/LF.
    return (
        b"<ul class='tnav'>" + nl1 +
        b"<li><a href='" + book_href + b"'>" + book_text + b"</a></li>" + nl2 +
        b"<li><a href='" + prev_href + b"' aria-label='Previous chapter'>&lt;</a></li>" + nl3 +
        b"<li><a href='" + next_href + b"' aria-label='Next chapter'>&gt;</a></li>" + nl5 +
        b"</ul>"
    )

changed = 0
skipped = 0
errors = 0
for path in sorted(glob.glob(os.path.join(SRC, "*.htm"))):
    with open(path, "rb") as f:
        d = f.read()
    # Chapter-page filter: has a tnav whose 3rd pill carries aria-current.
    # (Book-TOC tnavs and copyright.htm don't.)
    if b"aria-current='page'" not in d:
        skipped += 1   # book-TOC / copyright — not a chapter page
        continue
    # Idempotency guard for the home-mark inject: skip if already present.
    already_has_mark = b'class="home-mark"' in d
    # Drop the current-chapter <li> from every 4-li chapter tnav.
    new, n = CHAPTER_TNAV_4.subn(drop_current_li, d)
    if n == 0:
        # Has aria-current but no 4-li tnav matched. Could be an already-edited
        # file (3-li tnav now) — that's fine if the home-mark is already there
        # too. Otherwise investigate.
        if already_has_mark:
            # Already edited (3-li + has mark) — idempotent no-op.
            continue
        print(f"WARN no 4-li tnav match (but has aria-current): {os.path.basename(path)}", file=sys.stderr)
        errors += 1
        continue
    # Inject the home-mark once, right before the FIRST <ul class='tnav'>.
    if not already_has_mark:
        new = new.replace(b"<ul class='tnav'>", HOME_MARK + b"<ul class='tnav'>", 1)
    if new != d:
        with open(path, "wb") as f:
            f.write(new)
        changed += 1

print(f"changed={changed} skipped={skipped} errors={errors}")
