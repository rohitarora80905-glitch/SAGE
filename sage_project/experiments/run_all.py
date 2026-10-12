"""Run every experiment of the evaluation and write CSV results and plots.

usage: python3 -m experiments.run_all [--quick]
"""
import csv
import json
import os
import sys
import time
from collections import defaultdict
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sagesim.harness import run, CONFIG
from sagesim.metrics import summarise, lead_times
from sagesim.behaviour_model import MarkovModel
from sagesim.workload import family_types, program_events
from sagesim.rag import start_state
from sagesim import dashboard as dash

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'results')
PLOTS = os.path.join(ROOT, 'plots')
os.makedirs(RES, exist_ok=True)
os.makedirs(PLOTS, exist_ok=True)

FAMILIES = ['fixed', 'bursty', 'escalating', 'mixed']
POLICIES = ['bankers', 'reactive', 'sage']
QUICK = '--quick' in sys.argv
SEEDS = [0, 1, 2] if QUICK else list(range(20))
SWEEP_SEEDS = [0, 1] if QUICK else [0, 1, 2, 3, 4]
TAUS = [0.02, 0.05, 0.10, 0.20, 0.30, 0.50, 1.01]


def write_csv(path, rows):
    if not rows:
        return
    keys = sorted({k for r in rows for k in r}, key=lambda k: (k not in ('policy', 'family', 'seed', 'tau', 'K', 'H'), k))
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def headline():
    rows = []
    for fam in FAMILIES:
        for pol in POLICIES:
            for seed in SEEDS:
                t0 = time.time()
                R = run(pol, fam, seed)
                s = summarise(R)
                s['wall_s'] = time.time() - t0
                rows.append(s)
                log('headline %-10s %-8s seed %d  DL %.1f  queue %.1f%%  thr %.1f  lat %.3f ms  (%.1fs)'
                    % (fam, pol, seed, s['deadlock_rate'], s['queue_rate'], s['throughput'], s['latency_ms'], s['wall_s']))
    write_csv(os.path.join(RES, 'headline.csv'), rows)
    # summary: mean +- sd per family/policy
    summ = []
    for fam in FAMILIES:
        for pol in POLICIES:
            sub = [r for r in rows if r['family'] == fam and r['policy'] == pol]
            d = dict(family=fam, policy=pol, runs=len(sub))
            for k in ('deadlock_rate', 'queue_rate', 'throughput', 'latency_ms', 'fallback_rate', 'completed', 'deadlocks', 'blocked', 'forced',
                      'starved', 'min_slot_completed'):
                v = np.array([r[k] for r in sub], dtype=float)
                d[k + '_mean'] = v.mean()
                d[k + '_sd'] = v.std(ddof=1) if len(v) > 1 else 0.0
            summ.append(d)
    write_csv(os.path.join(RES, 'headline_summary.csv'), summ)
    return rows


def heldout_accuracy(pers, seeds, train_lives=3, test_lives=5):
    """Next-event accuracy of the behaviour model on lives it has not seen. For each seed and
    process slot the model learns `train_lives` lives of the process type and then predicts
    `test_lives` fresh lives without learning from them. Unlike the in-run figures this does not
    depend on the policy: a policy that causes many deadlocks makes aborted programs restart and
    replay, and replays are easy to predict."""
    n, m = CONFIG['n'], CONFIG['m']
    correct = total = 0
    ll = 0.0
    for seed in seeds:
        rng = np.random.default_rng([seed, 7])
        for t in family_types(pers, n, m, rng):
            mdl = MarkovModel(m, window=CONFIG['w'], floor=CONFIG['floor'])
            for life in range(train_lives + test_lives):
                prev, held, peak, epis = start_state(m), np.zeros(m, dtype=bool), 0, 0
                for e in program_events(t.program(rng), m):
                    if life < train_lives:
                        n_after = int(held.sum()) + (1 if e < m else (-1 if e < 2 * m else -int(held.sum())))
                        mdl.update(prev, e, n_after, peak, epis)
                    else:
                        correct += int(mdl.predict(prev, held, peak, epis) == e)
                        ll += mdl.loglik(prev, e, held, peak, epis)
                        total += 1
                    if e < m:
                        if not held.any():
                            peak = 0                             # a new episode starts
                        held[e] = True
                    elif e < 2 * m:
                        held[e - m] = False
                        if not held.any():
                            epis += 1                            # an episode is complete
                    else:
                        held[:] = False
                        peak, epis = 0, 0
                    peak = max(peak, int(held.sum()))
                    prev = e
    return 100.0 * correct / total, ll / total, total


def accuracy(headline_rows):
    """Next-event accuracy of the Markov model: on unseen lives (held-out, comparable across policies
    and versions) and prequentially inside the SAGE runs; plus timing micro-benchmarks."""
    out = []
    m = CONFIG['m']
    rng = np.random.default_rng(0)
    for pers in ('fixed', 'bursty', 'escalating'):
        h_acc, h_ll, h_n = heldout_accuracy(pers, SEEDS)
        sub = [r for r in headline_rows if r['policy'] == 'sage' and r['family'] == pers]
        acc = np.array([r['acc_' + pers] for r in sub])
        ll = np.array([r['ll_' + pers] for r in sub])
        upd = np.array([r['update_us'] for r in sub])
        # sampling time per event: batch of K=100 samples from a trained model
        R = run('sage', pers, 0, ticks=300)
        mdl = R['models'][0]
        states = np.array([s for s in range(mdl.S) if mdl.counts[s].sum() > 0] * 20)[:100]
        t0 = time.perf_counter()
        for _ in range(200):
            mdl.sample_next_batch(states, rng)
        samp_us = (time.perf_counter() - t0) / (200 * len(states)) * 1e6
        out.append(dict(personality=pers, heldout_top1=h_acc, heldout_loglik=h_ll, heldout_events=h_n,
                        top1_mean=acc.mean(), top1_sd=acc.std(ddof=1) if len(acc) > 1 else 0.0,
                        loglik_mean=ll.mean(), loglik_sd=ll.std(ddof=1) if len(ll) > 1 else 0.0,
                        update_us=upd.mean(), sample_us=samp_us, events=sum(r['n_' + pers] for r in sub)))
        log('accuracy %-10s held-out top-1 %.1f%%  ll %.2f | in-run top-1 %.1f%%  ll %.2f  update %.1f us  sample %.2f us'
            % (pers, h_acc, h_ll, acc.mean(), ll.mean(), upd.mean(), samp_us))
    write_csv(os.path.join(RES, 'accuracy.csv'), out)


def leadtime():
    out = []
    for fam in FAMILIES:
        leads_all, n_dl, n_flag = [], 0, 0
        for seed in SEEDS[:5]:
            R = run('reactive', fam, seed, shadow=True)
            leads = lead_times(R)
            n_dl += len(leads)
            got = [l for l in leads if l is not None]
            n_flag += len(got)
            leads_all += got
            log('leadtime %-10s seed %d  deadlocks %d  flagged %d' % (fam, seed, len(leads), len(got)))
        out.append(dict(family=fam, deadlocks=n_dl, flagged=n_flag, flagged_pct=100.0 * n_flag / max(n_dl, 1),
                        lead_mean=float(np.mean(leads_all)) if leads_all else float('nan'),
                        lead_median=float(np.median(leads_all)) if leads_all else float('nan'),
                        lead_min=float(np.min(leads_all)) if leads_all else float('nan'),
                        lead_max=float(np.max(leads_all)) if leads_all else float('nan')))
    write_csv(os.path.join(RES, 'leadtime.csv'), out)


def sweep():
    rows = []
    for tau in TAUS:
        for seed in SWEEP_SEEDS:
            R = run('sage', 'mixed', seed, tau=tau)
            s = summarise(R)
            s['tau'] = tau
            rows.append(s)
            log('sweep tau %.2f seed %d  DL %.1f  queue %.1f%%  thr %.1f' % (tau, seed, s['deadlock_rate'], s['queue_rate'], s['throughput']))
    write_csv(os.path.join(RES, 'sweep.csv'), rows)
    dash.threshold_sweep(os.path.join(RES, 'sweep.csv'), os.path.join(RES, 'headline.csv'), os.path.join(PLOTS, 'threshold_sweep.png'))


def shift():
    rows, series = [], []
    T = CONFIG['shift_tick']
    W = 300
    for pol in POLICIES:
        for seed in SEEDS:
            R = run(pol, 'shift', seed)
            s = summarise(R)
            # transition window [T, T + W)
            dl_w = sum(1 for t, c, v in R['deadlock_log'] if T <= t < T + W)
            dec_w = [d for d in R['decisions'] if T <= d[0] < T + W and not d[7]]
            s['window_deadlocks'] = dl_w
            s['window_deadlock_rate'] = 1000.0 * dl_w / W
            s['window_queue_rate'] = 100.0 * sum(1 for d in dec_w if d[3] == 'wait') / max(len(dec_w), 1)
            s['window_fallback_rate'] = 100.0 * sum(1 for d in dec_w if d[3] == 'fallback') / max(len(dec_w), 1)
            delays = [R['drift_flag'][i] - R['shift_first'][i] for i in R['drift_flag'] if i in R['shift_first']]
            # the same delay counted in the process's own events (a queued process emits none)
            own = [sum(1 for t, j, _, _ in R['event_log'] if j == i and R['shift_first'][i] <= t <= R['drift_flag'][i])
                   for i in R['drift_flag'] if i in R['shift_first']]
            recov = [R['drift_recover'][i] - R['drift_flag'][i] for i in R['drift_recover']]
            s['shifted_processes'] = len(R['shift_first'])
            s['flagged_processes'] = len(delays)
            s['detection_delay_mean'] = float(np.mean(delays)) if delays else float('nan')
            s['detection_delay_events'] = float(np.mean(own)) if own else float('nan')
            s['recovery_mean'] = float(np.mean(recov)) if recov else float('nan')
            s['shift_first_mean'] = float(np.mean(list(R['shift_first'].values()))) if R['shift_first'] else float('nan')
            rows.append(s)
            log('shift %-8s seed %d  DL total %d  window DL %d  q %.0f%%  fb %.0f%%  delay %s  recov %s'
                % (pol, seed, R['deadlocks'], dl_w, s['window_queue_rate'], s['window_fallback_rate'], delays, recov))
            if pol == 'sage':
                shifted = set(R['shift_first']) | {i for i in range(CONFIG['n']) if R['pers'][i] == 'fixed' and i < CONFIG['n'] // 2}
                ev = defaultdict(list)
                for t, i, correct, post in R['event_log']:
                    if i in shifted:
                        ev[(t // 100) * 100].append(correct)
                fb = defaultdict(list)
                for d in R['decisions']:
                    if d[1] in shifted and not d[7]:
                        fb[(d[0] // 100) * 100].append(1 if d[3] == 'fallback' else 0)
                for b in sorted(ev):
                    series.append(dict(seed=seed, bin=b, accuracy=100.0 * np.mean(ev[b]),
                                       fallback=100.0 * np.mean(fb[b]) if fb[b] else 0.0))
    write_csv(os.path.join(RES, 'shift.csv'), rows)
    write_csv(os.path.join(RES, 'shift_series.csv'), series)
    dash.shift_timeseries(os.path.join(RES, 'shift_series.csv'), os.path.join(PLOTS, 'shift_timeseries.png'), T)


def latency():
    rows = []
    Ks = [20, 50, 100, 200]
    Hs = [10, 20, 50, 100]
    for K in Ks:
        for H in Hs:
            R = run('sage', 'mixed', 0, ticks=400, K=K, H=H)
            s = summarise(R)
            rows.append(dict(K=K, H=H, latency_ms=s['latency_ms'], latency_ms_max=s['latency_ms_max'],
                             deadlock_rate=s['deadlock_rate'], queue_rate=s['queue_rate'], decisions=len(R['decisions'])))
            log('latency K %3d H %3d  %.2f ms' % (K, H, s['latency_ms']))
    base = {}
    for pol in ('bankers', 'reactive'):
        R = run(pol, 'mixed', 0, ticks=400)
        base[pol] = summarise(R)['latency_ms']
        rows.append(dict(K=0, H=0, policy=pol, latency_ms=base[pol]))
    write_csv(os.path.join(RES, 'latency.csv'), rows)
    dash.latency_plot(os.path.join(RES, 'latency.csv'), os.path.join(PLOTS, 'latency.png'), base)


if __name__ == '__main__':
    t0 = time.time()
    log('config: %s' % json.dumps(CONFIG))
    rows = headline()
    dash.dashboard(os.path.join(RES, 'headline.csv'), os.path.join(PLOTS, 'dashboard.png'))
    accuracy(rows)
    leadtime()
    sweep()
    shift()
    latency()
    with open(os.path.join(RES, 'config.json'), 'w') as f:
        json.dump(dict(CONFIG, seeds=SEEDS, sweep_seeds=SWEEP_SEEDS, taus=TAUS), f, indent=2)
    log('all experiments finished in %.1f min' % ((time.time() - t0) / 60))
