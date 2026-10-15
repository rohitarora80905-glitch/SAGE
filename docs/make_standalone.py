"""Pack docs/index.html into one self-contained file: SAGE_Project_Document.html (repository root).

Fonts (latin subsets) and the console screenshots are embedded as data URIs; links to GitHub and
to other files are removed, so the page opens offline from anywhere with nothing to fetch.

    python docs/build.py && python docs/make_standalone.py
"""
import base64
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'SAGE_Project_Document.html')
FONTS = ('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500'
         '&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60) as r:
        return r.read()


def replace_once(s, old, new):
    assert old in s, 'missing: ' + old[:80]
    return s.replace(old, new, 1)


with open(os.path.join(HERE, 'index.html'), encoding='utf-8') as f:
    s = f.read()

# ---- fonts: keep the latin and latin-ext blocks, embed each woff2
css = fetch(FONTS).decode('utf-8')
blocks = re.findall(r'/\* ([a-z-]+) \*/\s*(@font-face\s*\{.*?\})', css, re.S)
kept = []
for subset, block in blocks:
    if subset not in ('latin', 'latin-ext'):
        continue
    url = re.search(r'url\((https://[^)]+)\)', block).group(1)
    data = base64.b64encode(fetch(url)).decode('ascii')
    kept.append(block.replace(url, 'data:font/woff2;base64,' + data))
assert kept, 'no font blocks downloaded'
font_css = '<style>\n/* embedded fonts: Cormorant Garamond, Inter, JetBrains Mono (latin subsets) */\n' + '\n'.join(kept) + '\n</style>'
s = re.sub(r'<link rel="preconnect"[^>]*>\n?', '', s)
s = replace_once(s, '<link rel="stylesheet" href="%s">' % FONTS, font_css)

# ---- screenshots
imgs = {}
for name in sorted(os.listdir(os.path.join(HERE, 'img'))):
    if name.endswith('.jpg'):
        with open(os.path.join(HERE, 'img', name), 'rb') as f:
            imgs[name[:-4]] = 'data:image/jpeg;base64,' + base64.b64encode(f.read()).decode('ascii')
s = replace_once(s, "img.src = 'img/' + shots[k][0] + '.jpg';", 'img.src = SAGE_IMG[shots[k][0]];')
img_js = 'const SAGE_IMG = {%s};' % ','.join('"%s":"%s"' % kv for kv in imgs.items())
s = replace_once(s, '<script>const D = ', '<script>%s</script>\n<script>const D = ' % img_js)

# ---- no GitHub, no links to other files
s = re.sub(r'\s*<a class="gh" href="https://github\.com[^"]*"[^>]*>GitHub</a>', '', s)
s = re.sub(r'\s*<a class="btn btn-ghost" href="\.\./SAGE_Interactive_Report\.html">[^<]*</a>', '', s)
s = re.sub(r' · <a href="\.\./SAGE_Interactive_Report\.html">[^<]*</a>', '', s)
s = re.sub(r' · <a href="https://github\.com[^"]*"[^>]*>[^<]*</a>', '', s)
for bad in ('github.com', 'SAGE_Interactive_Report.html', 'fonts.googleapis', 'fonts.gstatic', "'img/"):
    assert bad not in s, 'left over: ' + bad

with open(OUT, 'w', encoding='utf-8') as f:
    f.write(s)
print('wrote %s (%.0f KB): %d font faces, %d screenshots embedded' % (OUT, os.path.getsize(OUT) / 1024, len(kept), len(imgs)))
