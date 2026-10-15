"""Build docs/index.html from docs/parts/* and docs/data.json.

    python docs/build_data.py        # collects the data (runs the simulator, reads the archive, ...)
    python docs/refresh_ai.py        # optional: refresh the analyst section from the running console
    python docs/build.py             # assembles the page

Parts are concatenated in name order: *.html parts form the page, *.js parts form one inline
script that runs after the embedded data (`const D = {...}`).
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PARTS = os.path.join(HERE, 'parts')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


html_parts = sorted(glob.glob(os.path.join(PARTS, '*.html')))
js_parts = sorted(glob.glob(os.path.join(PARTS, '*.js')))
assert html_parts and js_parts, 'docs/parts is incomplete'
with open(os.path.join(HERE, 'data.json'), encoding='utf-8') as f:
    data = json.load(f)
blob = json.dumps(data, separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/')
page = ''.join(read(p) for p in html_parts)
script = '\n'.join(read(p) for p in js_parts).replace('</script', '<\\/script')
assert '<!--SCRIPTS-->' in page, 'the last html part must contain <!--SCRIPTS-->'
page = page.replace('<!--SCRIPTS-->', '<script>const D = %s;</script>\n<script>\n%s\n</script>' % (blob, script), 1)
out = os.path.join(HERE, 'index.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(page)
print('wrote %s (%.0f KB) from %d html parts and %d js parts' % (out, os.path.getsize(out) / 1024, len(html_parts), len(js_parts)))
