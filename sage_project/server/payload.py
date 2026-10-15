"""Turn the record of a run into the JSON the console renders: summary metrics, binned
time series, decision and deadlock logs, per-process model status and the replay trace."""
import math
import numpy as np

from sagesim.metrics import summarise
from sagesim.rag import REQ, REL, EXIT

POLICY_LABEL = {
    'sage': 'SAGE', 'bankers': "Banker's algorithm", 'bankers_nodecl': "Banker's, no declaration",
    'reactive': 'Reactive detection', 'timeout': 'Timeout', 'wait_die': 'Wait-die', 'wound_wait': 'Wound-wait',
}
POLICY_BLURB = {
    'sage': 'Learned behaviour models, K simulated futures per request, risk threshold tau, learned-claims fallback.',
    'bankers': "Avoidance with every process's true per-life maximum declared in advance (its most favourable setting).",
    'bankers_nodecl': 'Avoidance when nothing is declared: every process is assumed to need every resource.',
    'reactive': 'Grant whenever free; detect cycles in the wait-for graph on every block and abort a victim.',
    'timeout': 'No detection: a process blocked for longer than the timeout is rolled back.',
    'wait_die': 'Prevention with timestamps: an older requester waits, a younger one dies (rolls back).',
    'wound_wait': 'Prevention with timestamps: an older requester wounds (rolls back) a younger holder.',
}
PERSONALITY_LABEL = {'fixed': 'Fixed pattern', 'bursty': 'Bursty / random', 'escalating': 'Gradually escalating',
                     'custom': 'Custom program'}
FAMILY_LABEL = {'fixed': 'Fixed-pattern', 'bursty': 'Bursty / random', 'escalating': 'Gradually escalating',
                'mixed': 'Mixed', 'shift': 'Behaviour shift', 'custom': 'Custom scenario'}
PATH_LABEL = {'learned': 'Learned (rollout)', 'cold': 'Cold start', 'uncertain': 'Uncertain (near random)',
              'drift': 'Drift detected', 'drain': 'Starvation guard', 'bankers': "Banker's check",
              'reactive': 'Reactive', 'grant_all': 'Grant', 'wait_die': 'Wait-die', 'wound_wait': 'Wound-wait',
              'timeout': 'Timeout'}


def j(x):
    """JSON-safe copy (numpy scalars and arrays, NaN)."""
    if isinstance(x, dict):
        return {str(k): j(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [j(v) for v in x]
    if isinstance(x, np.ndarray):
        return j(x.tolist())
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        v = float(x)
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(x, (np.bool_,)):
        return bool(x)
    return x


def op_text(kind, r, resources=None):
    name = (resources[r] if resources and 0 <= r < len(resources) else 'R%d' % (r + 1)) if r >= 0 else ''
    if kind == REQ:
        return 'request %s' % name
    if kind == REL:
        return 'release %s' % name
    if kind == EXIT:
        return 'exit'
    return '-'


def resource_names(m, resources=None):
    if resources and len(resources) >= m:
        return [str(x) for x in resources[:m]]
    return ['R%d' % (k + 1) for k in range(m)]


def run_payload(R, wall_s=None, resources=None, keep_trace=True):
    s = summarise(R)
    cfg = R['cfg']
    n, m = cfg['n'], cfg['m']
    ticks = int(R.get('ticks_run') or cfg['ticks'])
    names = resource_names(m, resources)
    first = [d for d in R['decisions'] if not d[7]]

    # ---- binned time series (<= 60 windows)
    nb = max(1, min(60, ticks))
    w = max(1, int(math.ceil(ticks / nb)))
    nb = int(math.ceil(ticks / w))
    bins = dict(width=w, start=[k * w for k in range(nb)],
                deadlocks=[0] * nb, completions=[0] * nb, queued=[0] * nb, granted=[0] * nb, blocked=[0] * nb,
                risk_sum=[0.0] * nb, risk_n=[0] * nb, fallback=[0] * nb, waiting=[0.0] * nb, waiting_n=[0] * nb)

    def b(t):
        return min(nb - 1, max(0, (int(t) - 1) // w))

    for t, cyc, v in R['deadlock_log']:
        bins['deadlocks'][b(t)] += 1
    for d in first:
        k = b(d[0])
        if d[3] == 'wait':
            bins['queued'][k] += 1
        else:
            bins['granted'][k] += 1
        if d[4] is not None:
            bins['risk_sum'][k] += float(d[4])
            bins['risk_n'][k] += 1
        if d[5] in ('cold', 'uncertain', 'drift', 'drain'):
            bins['fallback'][k] += 1
    trace = R.get('trace') or []
    for e in trace:
        k = b(e['t'])
        if e.get('out') == 'exit':
            bins['completions'][k] += 1
        if e.get('out') == 'blocked':
            bins['blocked'][k] += 1
        bins['waiting'][k] += sum(1 for st in e['status'] if st == 1)
        bins['waiting_n'][k] += 1
    if not trace:                                 # no trace: completions from the per-slot totals only
        pass
    bins['risk_mean'] = [(bins['risk_sum'][k] / bins['risk_n'][k]) if bins['risk_n'][k] else None for k in range(nb)]
    bins['waiting_mean'] = [(bins['waiting'][k] / bins['waiting_n'][k]) if bins['waiting_n'][k] else 0.0 for k in range(nb)]
    cum_dl, cum_cp, acc_d, acc_c = [], [], 0, 0
    for k in range(nb):
        acc_d += bins['deadlocks'][k]
        acc_c += bins['completions'][k]
        cum_dl.append(acc_d)
        cum_cp.append(acc_c)
    bins['cum_deadlocks'] = cum_dl
    bins['cum_completions'] = cum_cp
    for k in ('risk_sum', 'risk_n', 'waiting', 'waiting_n'):
        bins.pop(k)

    # ---- paths and risks
    paths = {}
    for d in first:
        key = d[5] or '-'
        p = paths.setdefault(key, dict(path=key, label=PATH_LABEL.get(key, key), grant=0, wait=0))
        p['grant' if d[3] != 'wait' else 'wait'] += 1
    risks = [float(d[4]) for d in first if d[4] is not None]
    edges = [k / 10 for k in range(11)]
    hist = [0] * 10
    for r in risks:
        hist[min(9, int(r * 10))] += 1

    # ---- processes
    procs = []
    models = R.get('models') or []
    types = R.get('types') or []
    for i in range(n):
        mdl = models[i] if i < len(models) else None
        t = types[i] if i < len(types) else None
        d = dict(i=i, name=R.get('names', ['P%d' % (k + 1) for k in range(n)])[i],
                 personality=R['pers'][i], personality_label=PERSONALITY_LABEL.get(R['pers'][i], R['pers'][i]),
                 completed=R['slot_completed'][i], aborts=R['slot_aborts'][i],
                 pred_correct=R['slot_pred'][i][0], pred_total=R['slot_pred'][i][1],
                 accuracy=(100.0 * R['slot_pred'][i][0] / R['slot_pred'][i][1]) if R['slot_pred'][i][1] else None)
        if t is not None:
            if t.personality == 'fixed':
                d['pattern'] = [names[r] for r in (t.post_seq if t.shifted and t.post_seq else t.seq)]
            elif t.personality == 'escalating':
                d['pattern'] = [names[r] for r in t.order[:t.levels]]
                d['levels'] = t.levels
            elif t.personality == 'custom':
                d['pattern'] = [op_text(k, r, names) for k, r in t.ops]
                d['cycles'] = list(t.cycles)
        if mdl is not None:
            d['model'] = dict(support=mdl.support(), fit_loglik=mdl.fit_loglik(), cusum=float(mdl.cusum),
                              max_held=int(mdl.max_held), variant=int(mdl.variant),
                              engine=getattr(mdl, 'engine', ('markov', 'markov+peak', 'markov+count')[mdl.variant]))
            if hasattr(mdl, 'status'):
                d['model']['lstm'] = mdl.status()
        procs.append(d)
    # confidence path at the end of the run, per process (SAGE only)
    pol = R['policy']
    if pol == 'sage' and models:
        from sagesim.sage import SagePolicy
        sp = SagePolicy(models, K=cfg['K'], H=cfg['H'], tau=cfg['tau'], h_min=cfg['h_min'], drift_h=cfg['drift_h'],
                        min_ll=cfg['min_ll'], aging=cfg['aging'], life_aging=cfg['life_aging'], fallback=cfg['fallback'])
        for i in range(n):
            try:
                procs[i]['path_now'] = sp.confidence(i)
            except Exception:           # noqa: BLE001
                procs[i]['path_now'] = None

    st = R['final_state']
    final = dict(alloc=[[bool(x) for x in row] for row in st.alloc], status=st.status.tolist(),
                 pending=st.pending.tolist(), reason=st.reason.tolist())

    out = dict(
        policy=pol, policy_label=POLICY_LABEL.get(pol, pol), family=R['family'],
        family_label=FAMILY_LABEL.get(R['family'], R['family']), seed=R['seed'], config=j(cfg),
        wall_s=wall_s, ticks=ticks, n=n, m=m, resources=names,
        summary=j(s),
        counts=dict(events=R['events'], requests=R['requests'], free_requests=R['free_requests'], granted=R['granted'],
                    policy_waits=R['policy_waits'], blocked=R['blocked'], fallback=R['fallback'], reevals=R['reevals'],
                    forced=R['forced'], deadlocks=R['deadlocks'], completed=R['completed'], restarts=R['restarts'],
                    wasted=R['wasted']),
        series=bins,
        paths=sorted(paths.values(), key=lambda p: -(p['grant'] + p['wait'])),
        risk_hist=dict(edges=edges, counts=hist, n=len(risks)),
        decisions=[dict(t=d[0], i=d[1], r=d[2], d=d[3], risk=d[4], path=d[5], ms=d[6] * 1000.0, reeval=bool(d[7]))
                   for d in R['decisions'][:6000]],
        deadlocks=[dict(t=t, cycle=[int(c) for c in cyc], victim=int(v)) for t, cyc, v in R['deadlock_log']],
        processes=procs, final=final,
        shift=dict(first=j(R['shift_first']), flagged=j(R['drift_flag']), recovered=j(R['drift_recover']))
        if R['family'] == 'shift' else None,
    )
    if keep_trace and trace:
        out['trace'] = j(trace)
        out['programs'] = [dict(t=t, i=i, ops=[[int(k), int(r)] for k, r in ops]) for t, i, ops in (R.get('programs_log') or [])]
    return j(out)


def compare_payload(rows, metrics):
    """rows: dicts with policy, model, seed and the metrics. Returns per-policy mean/sd and the rows."""
    groups = {}
    for r in rows:
        groups.setdefault(r['key'], []).append(r)
    summary = []
    for key, rs in groups.items():
        d = dict(key=key, policy=rs[0]['policy'], model=rs[0]['model'], label=rs[0]['label'], runs=len(rs))
        for mtr in metrics:
            v = np.array([r[mtr] for r in rs if r.get(mtr) is not None], dtype=float)
            d[mtr + '_mean'] = float(v.mean()) if len(v) else None
            d[mtr + '_sd'] = float(v.std(ddof=1)) if len(v) > 1 else 0.0
        summary.append(d)
    return j(dict(summary=summary, rows=rows, metrics=metrics))
