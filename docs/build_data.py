"""Collect everything the project document embeds: twin replays (reactive vs SAGE on the same
seeded workload), the LSTM gate history, a CUSUM drift trace, the benchmark archive, held-out
accuracy of the two engines, the verification results, and (if the console is running with a
Groq key) the analyst's real report. Writes docs/data.json.

    python docs/build_data.py [--console http://127.0.0.1:8080] [--quick]
"""
import csv
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROJ = os.path.join(ROOT, 'sage_project')
sys.path.insert(0, PROJ)

import numpy as np                                             # noqa: E402
from sagesim.harness import run, CONFIG                        # noqa: E402
from sagesim.behaviour_model import MarkovModel                # noqa: E402
from sagesim.lstm_model import LSTMModel, HAVE_TORCH           # noqa: E402
from sagesim.workload import family_types, program_events      # noqa: E402
from sagesim.rag import start_state                            # noqa: E402
from server.payload import run_payload                         # noqa: E402

CONSOLE = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--console=')), 'http://127.0.0.1:8080')
QUICK = '--quick' in sys.argv
TICKS = 300 if QUICK else 500
SEED = 0
RES = os.path.join(PROJ, 'results')


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def rnd(x, d=3):
    if isinstance(x, float):
        return None if (math.isnan(x) or math.isinf(x)) else round(x, d)
    return x


# ---------------------------------------------------------------- 1. twin replays with gate history
gate_hist = {}
if HAVE_TORCH:
    _orig = LSTMModel.update

    def _update(self, *a, **k):
        _orig(self, *a, **k)
        gate_hist.setdefault(id(self), []).append((round(self.gate_lstm, 2), round(self.gate_ref, 2), int(self.use_lstm)))
    LSTMModel.update = _update

log('running SAGE (LSTM engine) and reactive detection on the mixed workload, seed %d, %d events' % (SEED, TICKS))
Rs = run('sage', 'mixed', SEED, ticks=TICKS, model='lstm' if HAVE_TORCH else 'markov', trace=True)
Rr = run('reactive', 'mixed', SEED, ticks=TICKS, trace=True)
ps, pr = run_payload(Rs), run_payload(Rr)


def compact(p):
    tr = []
    for e in p['trace']:
        d = {k: e[k] for k in ('t', 'i', 'op', 'r', 'out', 'alloc', 'status', 'pending', 'reason', 'pc', 'queue', 'done') if k in e}
        for k in ('risk', 'path', 'correct', 'dl', 'aborts'):
            if e.get(k) is not None:
                d[k] = e[k]
        if e.get('decision'):
            dd = e['decision']
            d['dec'] = {k: dd[k] for k in ('d', 'risk', 'path', 'ms') if k in dd}
            if dd.get('fut'):
                d['dec']['fut'] = dd['fut']
        if e.get('reevals'):
            d['re'] = [[x['i'], x['r'], x['d']] for x in e['reevals']]
        tr.append(d)
    return dict(policy=p['policy'], policy_label=p['policy_label'], family=p['family'], seed=p['seed'], ticks=p['ticks'], n=p['n'], m=p['m'],
                resources=p['resources'], config={k: p['config'][k] for k in ('K', 'H', 'tau', 'h_min', 'drift_h', 'min_ll', 'aging', 'life_aging', 'fallback', 'recovery', 'model')},
                summary={k: rnd(v) for k, v in p['summary'].items() if k in ('deadlock_rate', 'queue_rate', 'throughput', 'latency_ms', 'fallback_rate', 'rollback_rate', 'wasted_rate', 'starved', 'min_slot_completed', 'completed', 'deadlocks', 'blocked', 'free_requests')},
                counts=p['counts'], paths=p['paths'], risk_hist=p['risk_hist'],
                processes=[{k: q.get(k) for k in ('i', 'name', 'personality', 'personality_label', 'completed', 'aborts', 'accuracy', 'pattern', 'path_now')} | {'engine': (q.get('model') or {}).get('engine'), 'support': (q.get('model') or {}).get('support')} for q in p['processes']],
                deadlocks=p['deadlocks'], decisions=[{k: d[k] for k in ('t', 'i', 'r', 'd', 'risk', 'path')} for d in p['decisions']],
                trace=tr, programs=p['programs'])


twin = dict(sage=compact(ps), reactive=compact(pr))
# gate history per process (warm-up events first, then the run)
gates = []
for i, mdl in enumerate(Rs['models']):
    h = gate_hist.get(id(mdl), [])
    warm = max(0, len(h) - Rs['slot_pred'][i][1])
    step = max(1, len(h) // 160)
    gates.append(dict(i=i, name=ps['processes'][i]['name'], type=ps['processes'][i]['personality'], warm=warm, step=step,
                      lstm=[x[0] for x in h[::step]], ref=[x[1] for x in h[::step]], on=[x[2] for x in h[::step]],
                      final=(mdl.status() if hasattr(mdl, 'status') else {})))
log('twin replays: SAGE %d deadlocks, reactive %d deadlocks' % (Rs['deadlocks'], Rr['deadlocks']))

# ---------------------------------------------------------------- 2. CUSUM drift trace on the shift workload
log('shift run for the CUSUM trace')
cus = {}
_orig_m = MarkovModel.update


def _mupdate(self, *a, **k):
    _orig_m(self, *a, **k)
    cus.setdefault(id(self), []).append(round(float(self.cusum), 2))
MarkovModel.update = _mupdate
Rsh = run('sage', 'shift', SEED)
MarkovModel.update = _orig_m
shifted = sorted(Rsh['shift_first'])
i_sh = shifted[0] if shifted else 0
series = cus.get(id(Rsh['models'][i_sh]), [])
warm_sh = max(0, len(series) - sum(1 for e in Rsh['event_log'] if e[1] == i_sh))
own_ticks = [t for t, j, _, _ in Rsh['event_log'] if j == i_sh]
cusum_trace = dict(process=i_sh, warm=warm_sh, values=series[warm_sh:], ticks=own_ticks, shift_tick=Rsh['cfg']['shift_tick'],
                   shift_first=Rsh['shift_first'].get(i_sh), flagged=Rsh['drift_flag'].get(i_sh), recovered=Rsh['drift_recover'].get(i_sh),
                   drift_h=Rsh['cfg']['drift_h'])
log('cusum trace: %d points, shift at %s, flagged at %s, recovered at %s' % (len(series), cusum_trace['shift_first'], cusum_trace['flagged'], cusum_trace['recovered']))

# ---------------------------------------------------------------- 3. held-out accuracy of both engines
log('held-out accuracy of the two engines')


def heldout(pers, seeds=(0, 1, 2), train_lives=3, test_lives=5):
    n, m = CONFIG['n'], CONFIG['m']
    raw = gated = markov = 0
    total = 0
    for seed in seeds:
        rng = np.random.default_rng([seed, 7])
        for k, t in enumerate(family_types(pers, n, m, rng)):
            mdl = LSTMModel(m, seed=seed * 100 + k) if HAVE_TORCH else MarkovModel(m)
            for life in range(train_lives + test_lives):
                prev, held, peak, epis = start_state(m), np.zeros(m, dtype=bool), 0, 0
                for e in program_events(t.program(rng), m):
                    if life >= train_lives:
                        total += 1
                        if HAVE_TORCH:
                            raw += int(mdl.lstm_predict(held) == e)
                            gated += int(mdl.predict(prev, held, peak, epis) == e)
                            row = mdl._markov_row(prev, held, peak, epis)
                            markov += int(row.sum() > 0 and int(row.argmax()) == e)
                        else:
                            markov += int(mdl.predict(prev, held, peak, epis) == e)
                    n_after = int(held.sum()) + (1 if e < m else (-1 if e < 2 * m else -int(held.sum())))
                    mdl.update(prev, e, n_after, peak, epis, held=held)
                    if e < m:
                        if not held.any():
                            peak = 0
                        held[e] = True
                    elif e < 2 * m:
                        held[e - m] = False
                        if not held.any():
                            epis += 1
                    else:
                        held[:] = False
                        peak, epis = 0, 0
                    peak = max(peak, int(held.sum()))
                    prev = e
    return dict(personality=pers, events=total, markov=round(100.0 * markov / total, 1), lstm=round(100.0 * raw / total, 1), gated=round(100.0 * gated / total, 1))


accuracy = [heldout(p, seeds=(0,) if QUICK else (0, 1, 2)) for p in ('fixed', 'escalating', 'bursty')]
for a in accuracy:
    log('  %-10s markov %.1f  lstm %.1f  gated %.1f' % (a['personality'], a['markov'], a['lstm'], a['gated']))

# ---------------------------------------------------------------- 4. the benchmark archive
log('reading the benchmark archive')


def read_csv(name):
    path = os.path.join(RES, name + '.csv')
    if not os.path.exists(path):
        return None
    with open(path, newline='') as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for k, v in r.items():
            try:
                r[k] = float(v) if v not in ('', None) else None
            except ValueError:
                pass
    return rows


def group_stats(rows, keys, metrics):
    g = defaultdict(list)
    for r in rows:
        g[tuple(str(r[k]) for k in keys)].append(r)
    out = []
    for key, rs in g.items():
        d = dict(zip(keys, key))
        d['runs'] = len(rs)
        for mtr in metrics:
            v = np.array([r[mtr] for r in rs if r.get(mtr) is not None], dtype=float)
            d[mtr + '_mean'] = rnd(float(v.mean())) if len(v) else None
            d[mtr + '_sd'] = rnd(float(v.std(ddof=1))) if len(v) > 1 else 0.0
        out.append(d)
    return out


archive = {}
cfg_path = os.path.join(RES, 'config.json')
if os.path.exists(cfg_path):
    with open(cfg_path) as f:
        archive['config'] = json.load(f)
hs = read_csv('headline_summary')
if hs:
    archive['headline'] = [{k: rnd(v) for k, v in r.items()} for r in hs]
ca = read_csv('compare_all')
if ca:
    archive['compare_all'] = group_stats(ca, ['family', 'policy'], ['deadlock_rate', 'rollback_rate', 'wasted_rate', 'queue_rate', 'throughput', 'starved', 'latency_ms'])
    archive['compare_all_runs'] = len(ca)
cs = read_csv('compare_sizes')
if cs:
    archive['compare_sizes'] = group_stats(cs, ['size', 'policy'], ['deadlock_rate', 'queue_rate', 'throughput', 'rollback_rate'])
sw = read_csv('sweep')
if sw:
    archive['sweep'] = group_stats(sw, ['tau'], ['deadlock_rate', 'queue_rate', 'throughput', 'latency_ms'])
ss = read_csv('shift_series')
if ss:
    archive['shift_series'] = group_stats(ss, ['bin'], ['accuracy', 'fallback'])
sh = read_csv('shift')
if sh:
    archive['shift'] = group_stats(sh, ['policy'], ['deadlocks', 'window_deadlocks', 'window_queue_rate', 'detection_delay_events', 'recovery_mean'])
for name in ('latency', 'accuracy', 'leadtime'):
    rows = read_csv(name)
    if rows:
        archive[name] = [{k: rnd(v) for k, v in r.items()} for r in rows]

# ---------------------------------------------------------------- 5. verification
log('running the verification suite')
proc = subprocess.run([sys.executable, os.path.join(PROJ, 'tests', 'verify.py')], cwd=PROJ, capture_output=True, text=True, timeout=1200)
cases = []
for ln in (proc.stdout + proc.stderr).splitlines():
    if ' PASS' in ln or ' FAIL' in ln:
        ok = ' PASS' in ln
        head, _, tail = ln.partition(' PASS' if ok else ' FAIL')
        cases.append(dict(name=head.strip(), ok=ok, detail=tail.strip()))
verify = dict(ok=proc.returncode == 0, cases=cases, summary=next((ln for ln in reversed(proc.stdout.splitlines()) if 'checks passed' in ln), ''))
log('verification: %s' % verify['summary'])

# ---------------------------------------------------------------- 6. the analyst (live console, if available)
ai = dict(available=False)


def api(method, path, body=None, stream=False, timeout=240):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CONSOLE + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    r = urllib.request.urlopen(req, timeout=timeout)
    if stream:
        return r.read().decode('utf-8', 'replace')
    return json.load(r)


try:
    st = api('GET', '/api/ai/status')
    if st.get('status') == 'ok':
        log('console analyst is live (%s): asking for the report of the embedded run' % st['model'])
        job = api('POST', '/api/jobs/run', dict(policy='sage', family='mixed', seed=SEED, model='lstm' if HAVE_TORCH else 'markov', ticks=TICKS))
        for _ in range(300):
            jj = api('GET', '/api/jobs/%s' % job['id'])
            if jj['status'] in ('done', 'error', 'cancelled'):
                break
            time.sleep(1)
        if jj['status'] == 'done':
            report = api('POST', '/api/ai/analyse', dict(job_id=job['id']), stream=True)
            res = api('GET', '/api/jobs/%s/result' % job['id'])
            idx = next((k for k, d in enumerate(res['decisions']) if d['d'] == 'wait' and d['path'] == 'learned'), None)
            explain = api('POST', '/api/ai/explain', dict(job_id=job['id'], index=idx), stream=True) if idx is not None else ''
            dec = res['decisions'][idx] if idx is not None else None
            design = api('POST', '/api/ai/workload', dict(description='three writers each lock the printer then the scanner; two readers lock the scanner first and then the printer; one backup job takes the disk and the tape in random order'))
            ai = dict(available=True, model=st['model'], report=report, explain=explain, explained=dec, design=design.get('spec'), design_attempts=design.get('attempts'))
            log('analyst: report %d chars, explanation %d chars, design %s' % (len(report), len(explain), 'ok' if design.get('spec') else 'none'))
    else:
        log('console analyst not live (%s); the document will say so' % st.get('status'))
except Exception as e:                                                   # noqa: BLE001
    log('console not reachable (%s); skipping the analyst' % e)

# ---------------------------------------------------------------- 7. write
data = dict(generated=time.strftime('%Y-%m-%d %H:%M'), config=dict(CONFIG), twin=twin, gates=gates, cusum=cusum_trace, accuracy=accuracy,
            archive=archive, verify=verify, ai=ai, torch=HAVE_TORCH)
out = os.path.join(HERE, 'data.json')
with open(out, 'w', encoding='utf-8') as f:
    json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
log('wrote %s (%.0f KB)' % (out, os.path.getsize(out) / 1024))
