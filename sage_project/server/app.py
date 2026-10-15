"""SAGE console: a FastAPI application serving the simulator, the benchmark archive, the
verification suite and the Groq analyst behind a web front end.

    python -m server            # http://127.0.0.1:8000
"""
import asyncio
import csv
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # sage_project/
REPO = os.path.dirname(ROOT)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from sagesim.harness import run, CONFIG, POLICIES, MODELS                     # noqa: E402
from sagesim.metrics import summarise                                         # noqa: E402
from sagesim.workload import types_from_spec, PERSONALITIES                   # noqa: E402
from server.jobs import JobManager                                            # noqa: E402
from server.payload import run_payload, compare_payload, POLICY_LABEL, POLICY_BLURB, FAMILY_LABEL, PERSONALITY_LABEL, j  # noqa: E402
from server.ai import Analyst                                                 # noqa: E402

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
RESULTS = os.path.join(ROOT, 'results')
PLOTS = os.path.join(ROOT, 'plots')
REPORT = os.path.join(REPO, 'SAGE_Interactive_Report.html')
DOCS = os.path.join(REPO, 'docs')
FAMILIES = ['fixed', 'bursty', 'escalating', 'mixed', 'shift']
COMPARE_METRICS = ['deadlock_rate', 'queue_rate', 'throughput', 'latency_ms', 'fallback_rate', 'rollback_rate',
                   'wasted_rate', 'starved', 'min_slot_completed', 'completed', 'deadlocks', 'blocked', 'forced']
LIMITS = dict(n=(2, 16), m=(2, 16), ticks=(50, 6000), K=(5, 500), H=(3, 120), tau=(0.0, 1.01), h_min=(1, 500),
              drift_h=(0.5, 100.0), min_ll=(-10.0, 0.0), aging=(0, 10000), life_aging=(0, 20000), timeout=(5, 2000),
              warmup_lives=(0, 5), lstm_hidden=(8, 128), lstm_train_every=(1, 64), seeds=(1, 30))

app = FastAPI(title='SAGE console', version='2.0')
jobs = JobManager(workers=2)
analyst = Analyst()


# ------------------------------------------------------------------ request models
class RunRequest(BaseModel):
    policy: str = 'sage'
    family: str = 'mixed'
    seed: int = 0
    model: str = 'markov'
    n: Optional[int] = None
    m: Optional[int] = None
    ticks: int = 1500
    K: int = 100
    H: int = 30
    tau: float = 0.10
    h_min: int = 20
    drift_h: float = 8.0
    min_ll: float = -1.0
    aging: int = 400
    life_aging: int = 900
    fallback: str = 'claims'
    recovery: str = 'partial'
    timeout: int = 50
    warmup_lives: int = 1
    lstm_hidden: int = 48
    lstm_train_every: int = 8
    workload: Optional[Dict[str, Any]] = None
    keep_trace: bool = True


class CompareRequest(BaseModel):
    policies: List[str] = Field(default_factory=lambda: ['sage', 'bankers', 'reactive'])
    family: str = 'mixed'
    seeds: List[int] = Field(default_factory=lambda: [0, 1, 2])
    ticks: int = 1500
    overrides: Dict[str, Any] = Field(default_factory=dict)
    workload: Optional[Dict[str, Any]] = None


class SweepRequest(BaseModel):
    family: str = 'mixed'
    seeds: List[int] = Field(default_factory=lambda: [0, 1])
    taus: List[float] = Field(default_factory=lambda: [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.01])
    ticks: int = 1000
    model: str = 'markov'
    overrides: Dict[str, Any] = Field(default_factory=dict)


class KeyRequest(BaseModel):
    key: str
    persist: bool = False


class ModelRequest(BaseModel):
    model: str


class AIRunRequest(BaseModel):
    job_id: str
    focus: Optional[str] = None
    model: Optional[str] = None


class AIExplainRequest(BaseModel):
    job_id: str
    index: int
    model: Optional[str] = None


class AIChatRequest(BaseModel):
    messages: List[Dict[str, str]]
    job_ids: List[str] = Field(default_factory=list)
    model: Optional[str] = None


class AIWorkloadRequest(BaseModel):
    description: str
    n: Optional[int] = None
    m: Optional[int] = None
    model: Optional[str] = None


class SpecRequest(BaseModel):
    spec: Dict[str, Any]


# ------------------------------------------------------------------ helpers
def clamp(name, v):
    lo, hi = LIMITS[name]
    if v is None:
        return v
    if isinstance(lo, int) and not isinstance(lo, bool):
        v = int(v)
    else:
        v = float(v)
    return max(lo, min(hi, v))


def overrides_from(req: RunRequest):
    o = dict(ticks=clamp('ticks', req.ticks), K=clamp('K', req.K), H=clamp('H', req.H), tau=clamp('tau', req.tau),
             h_min=clamp('h_min', req.h_min), drift_h=clamp('drift_h', req.drift_h), min_ll=clamp('min_ll', req.min_ll),
             aging=clamp('aging', req.aging), life_aging=clamp('life_aging', req.life_aging),
             fallback='reactive' if req.fallback == 'reactive' else 'claims',
             recovery='restart' if req.recovery == 'restart' else 'partial', timeout=clamp('timeout', req.timeout),
             warmup_lives=clamp('warmup_lives', req.warmup_lives), model=req.model if req.model in MODELS else 'markov',
             lstm_hidden=clamp('lstm_hidden', req.lstm_hidden), lstm_train_every=clamp('lstm_train_every', req.lstm_train_every))
    if req.n is not None:
        o['n'] = clamp('n', req.n)
    if req.m is not None:
        o['m'] = clamp('m', req.m)
    return o


def validate_policy(p):
    if p not in POLICIES:
        raise HTTPException(400, 'unknown policy %r' % p)


def validate_family(f, workload):
    if workload is None and f not in FAMILIES:
        raise HTTPException(400, 'unknown family %r' % f)


def spec_types(spec, seed):
    rng = np.random.default_rng([int(seed), 11])
    try:
        return types_from_spec(spec, rng)
    except (ValueError, KeyError, TypeError, IndexError) as e:
        raise HTTPException(400, 'invalid workload: %s' % e)


def read_csv(name):
    path = os.path.join(RESULTS, name + '.csv')
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
            d[mtr + '_mean'] = float(v.mean()) if len(v) else None
            d[mtr + '_sd'] = float(v.std(ddof=1)) if len(v) > 1 else 0.0
        out.append(d)
    return out


# ------------------------------------------------------------------ pages
@app.get('/')
def index():
    return FileResponse(os.path.join(STATIC, 'index.html'))


@app.get('/report')
def report():
    if not os.path.exists(REPORT):
        raise HTTPException(404, 'report not found')
    return FileResponse(REPORT)


@app.get('/plots/{name}')
def plot(name: str):
    path = os.path.join(PLOTS, os.path.basename(name))
    if not os.path.exists(path):
        raise HTTPException(404)
    return FileResponse(path)


# ------------------------------------------------------------------ meta & archive
@app.get('/api/meta')
def meta():
    return dict(
        config=j(CONFIG), limits=LIMITS,
        policies=[dict(key=p, label=POLICY_LABEL[p], blurb=POLICY_BLURB[p]) for p in POLICIES],
        families=[dict(key=f, label=FAMILY_LABEL[f]) for f in FAMILIES],
        personalities=[dict(key=p, label=PERSONALITY_LABEL[p]) for p in list(PERSONALITIES) + ['custom']],
        models=[dict(key='markov', label='Markov chain + context tables'), dict(key='lstm', label='LSTM (gated over the Markov tables)')],
        ai=analyst.public(), report=os.path.exists(REPORT),
        results=[f[:-4] for f in sorted(os.listdir(RESULTS)) if f.endswith('.csv')] if os.path.isdir(RESULTS) else [],
        plots=[f for f in sorted(os.listdir(PLOTS)) if f.endswith('.png')] if os.path.isdir(PLOTS) else [],
        torch=_torch_info(), python=sys.version.split()[0],
    )


def _torch_info():
    try:
        import torch
        return dict(available=True, version=torch.__version__)
    except ImportError:
        return dict(available=False, version=None)


@app.get('/api/archive')
def archive():
    """The benchmark archive: every CSV in results/, aggregated where it is per-run."""
    out = {}
    cfg_path = os.path.join(RESULTS, 'config.json')
    if os.path.exists(cfg_path):
        with open(cfg_path) as f:
            out['config'] = json.load(f)
    hs = read_csv('headline_summary')
    if hs:
        out['headline_summary'] = hs
    for name in ('accuracy', 'leadtime', 'sweep', 'shift', 'shift_series', 'latency'):
        rows = read_csv(name)
        if rows:
            out[name] = rows
    ca = read_csv('compare_all')
    if ca:
        keep = ['deadlock_rate', 'rollback_rate', 'wasted_rate', 'queue_rate', 'throughput', 'starved', 'latency_ms']
        out['compare_all'] = group_stats(ca, ['family', 'policy'], keep)
        out['compare_all_runs'] = len(ca)
    cs = read_csv('compare_sizes')
    if cs:
        keep = ['deadlock_rate', 'queue_rate', 'throughput', 'rollback_rate', 'starved']
        out['compare_sizes'] = group_stats(cs, ['size', 'family', 'policy'], keep)
    run_log = os.path.join(RESULTS, 'run_log.txt')
    if os.path.exists(run_log):
        with open(run_log, errors='replace') as f:
            lines = f.read().splitlines()
        out['run_log_tail'] = lines[-12:]
    return j(out)


@app.get('/api/results/{name}')
def results(name: str):
    rows = read_csv(os.path.basename(name))
    if rows is None:
        raise HTTPException(404)
    return j(rows)


# ------------------------------------------------------------------ jobs
@app.post('/api/jobs/run')
def start_run(req: RunRequest):
    validate_policy(req.policy)
    validate_family(req.family, req.workload)
    o = overrides_from(req)
    spec = req.workload
    if spec is not None:
        spec_types(spec, req.seed)                      # validate now, build inside the job
    params = dict(kind='run', policy=req.policy, family='custom' if spec else req.family, seed=req.seed, model=o['model'],
                  overrides=o, workload=spec, title=(spec or {}).get('title'))

    def work(job):
        t0 = time.perf_counter()
        types = spec_types(spec, req.seed) if spec else None
        R = run(req.policy, 'custom' if spec else req.family, req.seed, types=types, progress=job.report, trace=True, **o)
        return run_payload(R, wall_s=time.perf_counter() - t0, resources=(spec or {}).get('resources'), keep_trace=req.keep_trace)

    job = jobs.submit('run', params, work)
    return job.public()


@app.post('/api/jobs/compare')
def start_compare(req: CompareRequest):
    keys = [k for k in req.policies if k in POLICIES or k == 'sage_lstm']
    if not keys:
        raise HTTPException(400, 'no valid policy')
    validate_family(req.family, req.workload)
    seeds = [int(s) for s in req.seeds][:LIMITS['seeds'][1]] or [0]
    base = RunRequest(**{k: v for k, v in req.overrides.items() if k in RunRequest.model_fields})
    o = overrides_from(base)
    o['ticks'] = clamp('ticks', req.ticks)
    spec = req.workload
    if spec is not None:
        spec_types(spec, seeds[0])
    params = dict(kind='compare', policies=keys, family='custom' if spec else req.family, seeds=seeds, overrides=o, workload=spec)

    def work(job):
        rows = []
        total = len(keys) * len(seeds)
        done = 0
        for key in keys:
            policy, model = ('sage', 'lstm') if key == 'sage_lstm' else (key, o['model'])
            label = POLICY_LABEL[policy] + (' (LSTM engine)' if key == 'sage_lstm' else (' (Markov engine)' if policy == 'sage' and model == 'markov' else ''))
            for seed in seeds:
                def prog(t, T, done=done):
                    job.report(done + t / max(T, 1), total, '%s seed %d' % (label, seed))
                types = spec_types(spec, seed) if spec else None
                t0 = time.perf_counter()
                R = run(policy, 'custom' if spec else req.family, seed, types=types, progress=prog, **dict(o, model=model))
                s = summarise(R)
                row = dict(key=key, policy=policy, model=model, label=label, seed=seed, wall_s=time.perf_counter() - t0)
                row.update({k: s[k] for k in COMPARE_METRICS})
                rows.append(row)
                done += 1
                job.report(done, total)
        out = compare_payload(rows, COMPARE_METRICS)
        out.update(family='custom' if spec else req.family, seeds=seeds, config=j(o), title=(spec or {}).get('title'))
        return out

    return jobs.submit('compare', params, work).public()


@app.post('/api/jobs/sweep')
def start_sweep(req: SweepRequest):
    validate_family(req.family, None)
    seeds = [int(s) for s in req.seeds][:10] or [0]
    taus = sorted({float(t) for t in req.taus})[:12] or [0.1]
    base = RunRequest(**{k: v for k, v in req.overrides.items() if k in RunRequest.model_fields})
    o = overrides_from(base)
    o['ticks'] = clamp('ticks', req.ticks)
    o['model'] = req.model if req.model in MODELS else 'markov'
    params = dict(kind='sweep', family=req.family, seeds=seeds, taus=taus, overrides=o)

    def work(job):
        rows = []
        total = len(taus) * len(seeds)
        done = 0
        for tau in taus:
            for seed in seeds:
                def prog(t, T, done=done):
                    job.report(done + t / max(T, 1), total, 'tau %.2f seed %d' % (tau, seed))
                R = run('sage', req.family, seed, progress=prog, **dict(o, tau=tau))
                s = summarise(R)
                row = dict(key='%.3f' % tau, policy='sage', model=o['model'], label='tau = %.2f' % tau, tau=tau, seed=seed)
                row.update({k: s[k] for k in COMPARE_METRICS})
                rows.append(row)
                done += 1
                job.report(done, total)
        out = compare_payload(rows, COMPARE_METRICS)
        out.update(family=req.family, seeds=seeds, taus=taus, config=j(o))
        return out

    return jobs.submit('sweep', params, work).public()


@app.post('/api/jobs/verify')
def start_verify():
    def work(job):
        job.report(0, 1, 'running tests/verify.py')
        proc = subprocess.run([sys.executable, os.path.join(ROOT, 'tests', 'verify.py')], cwd=ROOT,
                              capture_output=True, text=True, timeout=900)
        lines = (proc.stdout + proc.stderr).splitlines()
        cases = []
        for ln in lines:
            if ' PASS' in ln or ' FAIL' in ln:
                ok = ' PASS' in ln
                head, _, tail = ln.partition(' PASS' if ok else ' FAIL')
                cases.append(dict(name=head.strip(), ok=ok, detail=tail.strip()))
        summary = next((ln for ln in reversed(lines) if 'checks passed' in ln), '')
        return dict(ok=proc.returncode == 0, returncode=proc.returncode, cases=cases, summary=summary, output='\n'.join(lines[-200:]))

    return jobs.submit('verify', dict(kind='verify'), work).public()


@app.get('/api/jobs')
def list_jobs():
    return jobs.list()


@app.get('/api/jobs/{job_id}')
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404)
    return job.public()


@app.get('/api/jobs/{job_id}/result')
def get_result(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404)
    if job.status != 'done':
        raise HTTPException(409, 'job is %s' % job.status)
    return JSONResponse(job.result)


@app.delete('/api/jobs/{job_id}')
def cancel_job(job_id: str):
    if not jobs.cancel(job_id):
        raise HTTPException(404)
    return dict(ok=True)


@app.get('/api/jobs/{job_id}/events')
async def job_events(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404)

    async def gen():
        last = -1
        while True:
            if job.version != last:
                last = job.version
                yield 'data: %s\n\n' % json.dumps(job.public())
                if job.status in ('done', 'error', 'cancelled'):
                    break
            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


# ------------------------------------------------------------------ workloads
@app.post('/api/workload/validate')
def workload_validate(req: SpecRequest):
    spec = req.spec
    types = spec_types(spec, 0)
    m = int(spec['m'])
    names = spec.get('resources') or ['R%d' % (k + 1) for k in range(m)]
    view = []
    for t in types:
        prog = t.program(np.random.default_rng(0))
        sample = []
        for k, r in prog[:60]:
            sample.append('exit' if k == 2 else ('request ' if k == 0 else 'release ') + str(names[r]))
        view.append(dict(name=t.name, type=t.personality, label=PERSONALITY_LABEL.get(t.personality, t.personality),
                         sample=sample, length=len(prog)))
    return dict(ok=True, n=len(types), m=m, resources=[str(x) for x in names[:m]], processes=view)


# ------------------------------------------------------------------ AI
def _job_payload(job_id, kind=None):
    job = jobs.get(job_id)
    if job is None or job.status != 'done':
        raise HTTPException(404, 'no finished job %s' % job_id)
    if kind and job.kind != kind:
        raise HTTPException(400, 'job %s is a %s' % (job_id, job.kind))
    return job


def _stream(messages, model=None, **kw):
    def gen():
        for chunk in analyst.stream(messages, model=model, **kw):
            yield chunk
    return StreamingResponse(gen(), media_type='text/plain; charset=utf-8', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.get('/api/ai/status')
def ai_status(refresh: bool = False):
    return analyst.check(force=refresh)


@app.post('/api/ai/key')
def ai_key(req: KeyRequest):
    key = req.key.strip()
    out = analyst.configure(key or None, source='console' if key else None)
    env_path = os.path.join(ROOT, '.env')
    if not key and req.persist and os.path.exists(env_path):          # forget: drop the line from .env
        with open(env_path) as f:
            lines = [ln for ln in f.read().splitlines() if not ln.startswith('GROQ_API_KEY=')]
        with open(env_path, 'w') as f:
            f.write('\n'.join(lines) + ('\n' if lines else ''))
    if req.persist and key:
        env_path = os.path.join(ROOT, '.env')
        lines = []
        if os.path.exists(env_path):
            with open(env_path) as f:
                lines = [ln for ln in f.read().splitlines() if not ln.startswith('GROQ_API_KEY=')]
        lines.append('GROQ_API_KEY=%s' % req.key.strip())
        with open(env_path, 'w') as f:
            f.write('\n'.join(lines) + '\n')
        out['persisted'] = env_path
    return out


@app.post('/api/ai/model')
def ai_model(req: ModelRequest):
    return analyst.set_model(req.model)


@app.post('/api/ai/analyse')
def ai_analyse(req: AIRunRequest):
    job = _job_payload(req.job_id)
    if job.kind == 'run':
        return _stream(analyst.analyse_run(job.result, req.focus), model=req.model)
    if job.kind in ('compare', 'sweep'):
        return _stream(analyst.analyse_compare(job.result), model=req.model)
    raise HTTPException(400, 'nothing to analyse for a %s job' % job.kind)


@app.post('/api/ai/explain')
def ai_explain(req: AIExplainRequest):
    job = _job_payload(req.job_id, 'run')
    if not 0 <= req.index < len(job.result['decisions']):
        raise HTTPException(400, 'decision index out of range')
    return _stream(analyst.explain_decision(job.result, req.index), model=req.model, max_tokens=900)


@app.post('/api/ai/chat')
def ai_chat(req: AIChatRequest):
    contexts = []
    for jid in req.job_ids[:3]:
        job = jobs.get(jid)
        if job is not None and job.status == 'done' and job.kind in ('run', 'compare', 'sweep'):
            contexts.append(dict(kind='run' if job.kind == 'run' else 'compare', id=jid, payload=job.result))
    return _stream(analyst.chat_messages(req.messages, contexts), model=req.model, temperature=0.4)


@app.post('/api/ai/workload')
def ai_workload(req: AIWorkloadRequest):
    if not req.description.strip():
        raise HTTPException(400, 'describe the scenario first')
    error = previous = None
    spec = None
    for attempt in range(3):
        try:
            spec, previous = analyst.design_workload(req.description, req.n, req.m, error=error, previous=previous)
            spec['m'] = int(spec['m'])
            res = spec.get('resources') or []
            if len(res) != spec['m']:
                spec['resources'] = (list(res) + ['R%d' % (k + 1) for k in range(spec['m'])])[:spec['m']]
            spec_types(spec, 0)
            return dict(ok=True, spec=spec, attempts=attempt + 1, model=analyst.model)
        except HTTPException as e:
            error = e.detail
        except (RuntimeError,) as e:
            raise HTTPException(503, str(e))
        except Exception as e:                       # noqa: BLE001
            error = '%s: %s' % (type(e).__name__, e)
    raise HTTPException(422, 'the model could not produce a valid workload: %s' % error)


app.mount('/static', StaticFiles(directory=STATIC), name='static')
if os.path.isdir(DOCS):
    app.mount('/docs', StaticFiles(directory=DOCS, html=True), name='docs')   # the project document (docs/index.html)
