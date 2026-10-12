"""Aggregate per-run records into the metrics of the evaluation."""
import numpy as np


def summarise(R):
    ev = max(R['events'], 1)
    free = max(R['free_requests'], 1)
    dec = R['decisions']
    lat = np.array([d[6] for d in dec]) * 1000.0 if dec else np.array([0.0])
    first = [d for d in dec if not d[7]]
    out = dict(
        policy=R['policy'], family=R['family'], seed=R['seed'],
        events=R['events'], requests=R['requests'], free_requests=R['free_requests'],
        blocked=R['blocked'], deadlocks=R['deadlocks'], completed=R['completed'],
        deadlock_rate=1000.0 * R['deadlocks'] / ev,
        queue_rate=100.0 * R['policy_waits'] / free,
        throughput=1000.0 * R['completed'] / ev,
        latency_ms=float(lat.mean()), latency_ms_max=float(lat.max()),
        fallback_rate=100.0 * R['fallback'] / free,
        forced=R['forced'], restarts=R['restarts'], reevals=R['reevals'],
        risk_mean=float(np.mean([d[4] for d in first if d[4] is not None])) if any(d[4] is not None for d in first) else float('nan'),
        update_us=1e6 * R['update_time'] / max(R['updates'], 1),
        rollback_rate=1000.0 * R['restarts'] / ev,               # rollbacks (any cause) per 1,000 events
        wasted_rate=1000.0 * R['wasted'] / ev,                   # program steps undone per 1,000 events
        starved=sum(1 for c in R['slot_completed'] if c == 0),    # slots that never completed a life
        min_slot_completed=min(R['slot_completed']),
    )
    for p, st in R['pred'].items():
        out['acc_' + p] = 100.0 * st['correct'] / max(st['total'], 1)
        out['ll_' + p] = st['ll'] / max(st['total'], 1)
        out['n_' + p] = st['total']
    return out


def mean_std(rows, key):
    v = np.array([r[key] for r in rows], dtype=float)
    v = v[~np.isnan(v)]
    if len(v) == 0:
        return float('nan'), float('nan')
    return float(v.mean()), float(v.std(ddof=1)) if len(v) > 1 else 0.0


def lead_times(R, window=None):
    """Shadow-mode lead time: for each deadlock, the number of events between the first
    high-risk flag on a process of the cycle (after the previous deadlock) and the detection."""
    out = []
    prev_tick = 0
    for tick, cyc, victim in R['deadlock_log']:
        cyc = set(cyc)
        flags = [t for (t, i, risk) in R['flags'] if i in cyc and prev_tick < t < tick]
        out.append(tick - min(flags) if flags else None)
        prev_tick = tick
    return out
