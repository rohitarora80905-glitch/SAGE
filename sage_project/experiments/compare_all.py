"""Compare SAGE with every baseline on the same workloads and seeds.

usage: python -m experiments.compare_all [--quick]

Writes results/compare_all.csv (default system size, five workloads, 100 seeds) and
results/compare_sizes.csv (four system sizes, four workloads, 20 seeds), one row per run.
"""
import csv
import os
import sys
import time
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'results')
QUICK = '--quick' in sys.argv

POLICIES = ['bankers', 'bankers_nodecl', 'reactive', 'timeout', 'wait_die', 'wound_wait', 'sage']
FAMILIES = ['fixed', 'bursty', 'escalating', 'mixed', 'shift']
SEEDS = list(range(3)) if QUICK else list(range(20)) + list(range(100, 120)) + list(range(200, 260))
SIZES = {'small (4 x 6)': (4, 6), 'default (6 x 8)': (6, 8), 'large (10 x 12)': (10, 12),
         'high contention (8 x 6)': (8, 6)}
SIZE_SEEDS = list(range(3)) if QUICK else list(range(20))
KEEP = ('deadlock_rate', 'rollback_rate', 'wasted_rate', 'queue_rate', 'throughput', 'starved', 'latency_ms',
        'deadlocks', 'restarts', 'completed', 'events')


def job(args):
    from sagesim.harness import run
    from sagesim.metrics import summarise
    policy, family, seed, size, n, m = args
    s = summarise(run(policy, family, seed, n=n, m=m))
    row = dict(policy=policy, family=family, seed=seed, size=size)
    row.update({k: s[k] for k in KEEP})
    return row


def write(path, rows):
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


if __name__ == '__main__':
    t0 = time.time()
    jobs = [(p, f, s, 'default (6 x 8)', 6, 8) for f in FAMILIES for p in POLICIES for s in SEEDS]
    with Pool(max(1, (os.cpu_count() or 2) // 2)) as pool:
        rows = pool.map(job, jobs, chunksize=4)
    write(os.path.join(RES, 'compare_all.csv'), rows)
    print('compare_all: %d runs (%.0f s)' % (len(rows), time.time() - t0), flush=True)
    jobs = [(p, f, s, size, n, m) for size, (n, m) in SIZES.items() for f in FAMILIES[:4] for p in POLICIES
            for s in SIZE_SEEDS]
    with Pool(max(1, (os.cpu_count() or 2) // 2)) as pool:
        rows = pool.map(job, jobs, chunksize=2)
    write(os.path.join(RES, 'compare_sizes.csv'), rows)
    print('compare_sizes: %d runs (%.0f s)' % (len(rows), time.time() - t0), flush=True)
