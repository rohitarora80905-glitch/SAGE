"""Refresh only the analyst section of docs/data.json from the running console.

    python docs/refresh_ai.py [--console=http://127.0.0.1:8080] [--model=openai/gpt-oss-120b]
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--console=')), 'http://127.0.0.1:8080')
MODEL = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--model=')), 'openai/gpt-oss-120b')
PATH = os.path.join(HERE, 'data.json')


def api(method, path, body=None, stream=False, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CONSOLE + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    r = urllib.request.urlopen(req, timeout=timeout)
    return r.read().decode('utf-8', 'replace') if stream else json.load(r)


with open(PATH, encoding='utf-8') as f:
    data = json.load(f)
st = api('GET', '/api/ai/status')
if st.get('status') != 'ok':
    raise SystemExit('the console analyst is not connected (%s)' % st.get('status'))
if MODEL in st.get('models', []):
    st = api('POST', '/api/ai/model', dict(model=MODEL))
print('model:', st['model'])
tw = data['twin']['sage']
job = api('POST', '/api/jobs/run', dict(policy='sage', family='mixed', seed=tw['seed'], model=tw['config'].get('model', 'markov'), ticks=tw['ticks']))
for _ in range(300):
    jj = api('GET', '/api/jobs/%s' % job['id'])
    if jj['status'] in ('done', 'error', 'cancelled'):
        break
    time.sleep(1)
assert jj['status'] == 'done', jj
report = api('POST', '/api/ai/analyse', dict(job_id=job['id']), stream=True)
res = api('GET', '/api/jobs/%s/result' % job['id'])
idx = next((k for k, d in enumerate(res['decisions']) if d['d'] == 'wait' and d['path'] == 'learned'), None)
explain = api('POST', '/api/ai/explain', dict(job_id=job['id'], index=idx), stream=True) if idx is not None else ''
design = api('POST', '/api/ai/workload', dict(description='three writers each lock the printer then the scanner; two readers lock the scanner first and then the printer; one backup job takes the disk and the tape in random order'))
data['ai'] = dict(available=True, model=st['model'], report=report, explain=explain, explained=res['decisions'][idx] if idx is not None else None,
                  design=design.get('spec'), design_attempts=design.get('attempts'))
with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
print('report %d chars, explanation %d chars, design %s' % (len(report), len(explain), 'ok' if design.get('spec') else 'none'))
