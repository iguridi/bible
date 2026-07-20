#!/usr/bin/env python3
"""
Move the chapter number from the standalone chapterlabel heading into the
book-name pill in both top and bottom tnavs.

Before:
  <li><a href='GEN.htm'>Genesis</a></li>
  ...
  <div class='chapterlabel' id="V0"> 1</div>

After:
  <li><a href='GEN.htm'>Genesis 1</a></li>
  ...
  (chapterlabel div removed)

This is a bulk HTML edit across all 1334 chapter files. The script:
1. Extracts the chapter number from the chapterlabel div
2. Extracts the book name from the first tnav pill
3. Replaces both occurrences of >BookName</a> with >BookName N</a>
   (top and bottom tnavs)
4. Removes the chapterlabel div entirely

Works in bytes mode to preserve mixed CRLF/LF line endings.
"""
import glob
import re
import sys

CHLABEL = re.compile(rb'<div class=\'chapterlabel\' id="V0">\s*(\d+)</div>')
PILL = re.compile(rb"<li><a href='([A-Z0-9]+)\.htm'>([^<]+)</a></li>")

def process_file(path):
    with open(path, "rb") as f:
        d = f.read()
    
    # Skip non-chapter files (book TOCs, copyright, index)
    if b'class="home-mark"' not in d:
        return False, "skip (no home-mark)"
    
    # Extract chapter number
    m = CHLABEL.search(d)
    if not m:
        return False, "WARN no chapterlabel"
    chnum = m.group(1).decode()  # e.g. "1"
    
    # Extract book name from first pill
    pm = PILL.search(d)
    if not pm:
        return False, "WARN no pill"
    bookname = pm.group(2)  # bytes, e.g. b"Genesis"
    
    # Replace both occurrences of >BookName</a> with >BookName N</a>
    old = b">" + bookname + b"</a>"
    new = b">" + bookname + b" " + chnum.encode() + b"</a>"
    count = d.count(old)
    if count != 2:
        return False, f"WARN expected 2 occurrences of {old}, found {count}"
    d2 = d.replace(old, new)
    
    # Remove the chapterlabel div
    d2 = CHLABEL.sub(b"", d2)
    
    if d2 != d:
        with open(path, "wb") as f:
            f.write(d2)
        return True, f"OK (ch={chnum}, book={bookname.decode()})"
    return False, "no change"

def main():
    files = sorted(glob.glob("src/*.htm"))
    changed = 0
    warnings = []
    for p in files:
        ok, msg = process_file(p)
        if ok:
            changed += 1
        elif msg.startswith("WARN"):
            warnings.append(f"{p}: {msg}")
    
    print(f"changed={changed}")
    if warnings:
        print(f"\n{len(warnings)} warnings:")
        for w in warnings[:10]:  # show first 10
            print(f"  {w}")
        if len(warnings) > 10:
            print(f"  ... and {len(warnings) - 10} more")

if __name__ == "__main__":
    main()
