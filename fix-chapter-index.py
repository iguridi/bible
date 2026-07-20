#!/usr/bin/env python3
"""
Make chapter index pages consistent with chapter pages:
1. Add home-mark (☰)
2. Remove site-title paragraph
3. Simplify h1 (remove the link wrapper)
4. Add class="main" to main element
"""
import os
import re

src_dir = '/Users/iguridi/bible/src'
changed = 0

# Find all book TOC files (no chapter number in filename)
for fname in sorted(os.listdir(src_dir)):
    if not fname.endswith('.htm'):
        continue
    # Skip chapter files (have 2-3 digits before .htm)
    if re.search(r'\d{2,3}\.htm$', fname):
        continue
    # Skip index.html
    if fname == 'index.html':
        continue
    
    fpath = os.path.join(src_dir, fname)
    with open(fpath, 'rb') as f:
        html = f.read()
    
    original = html
    
    # 1. Add home-mark after <body> tag (keep the body tag)
    html = re.sub(
        b'<body[^>]*>\\s*(?=<main)',
        b'<body>\n<a class="home-mark" href="../index.html" aria-label="All books">\xe2\x98\xb0</a>\n',
        html,
        count=1
    )
    
    # 2. Remove site-title paragraph
    html = re.sub(
        b"<p class=\"site-title\"><a href=['\"]\\.\\./['\"]>Catholic English Bible</a></p>",
        b'',
        html
    )
    
    # 3. Simplify h1 - remove the link wrapper
    html = re.sub(
        b"<h1><a href=['\"]\\.\\./index\\.html['\"]>([^<]+)</a></h1>",
        b'<h1>\\1</h1>',
        html
    )
    
    # 4. Add class="main" to main element
    html = re.sub(
        rb'<main id="main">',
        rb'<main class="main" id="main">',
        html
    )
    
    if html != original:
        with open(fpath, 'wb') as f:
            f.write(html)
        changed += 1
        if changed <= 3:
            print(f"Updated {fname}")

print(f"\nTotal changed: {changed}")
