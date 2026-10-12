"""Plots for the results dashboard and the experiment figures (all read the CSV outputs)."""
import csv
from collections import defaultdict
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['font.sans-serif'] = ['Liberation Sans', 'Arial', 'DejaVu Sans']   # first one installed
plt.rcParams['font.size'] = 8.5
POLICIES = ['bankers', 'reactive', 'sage']
LABEL = {'bankers': "Banker's Algorithm", 'reactive': 'Reactive DFS', 'sage': 'SAGE (Markov)'}
COLOUR = {'bankers': '#7f7f7f', 'reactive': '#c0504d', 'sage': '#1f4e79'}
FAMILIES = ['fixed', 'bursty', 'escalating', 'mixed']
FAM_LABEL = {'fixed': 'Fixed-pattern', 'bursty': 'Bursty / random', 'escalating': 'Gradually escalating', 'mixed': 'Mixed'}


def read_csv(path):
    with open(path) as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for k, v in r.items():
            try:
                r[k] = float(v)
            except (ValueError, TypeError):
                pass
    return rows


def group_mean_std(rows, keys, metric):
    g = defaultdict(list)
    for r in rows:
        g[tuple(r[k] for k in keys)].append(float(r[metric]))
    return {k: (np.mean(v), np.std(v, ddof=1) if len(v) > 1 else 0.0) for k, v in g.items()}


def dashboard(headline_csv, out_png):
    rows = read_csv(headline_csv)
    metrics = [('deadlock_rate', 'Deadlock rate (per 1,000 events)'), ('queue_rate', 'Queue / denial rate (%)'),
               ('throughput', 'Throughput (completions per 1,000 events)'), ('latency_ms', 'Mean decision latency (ms)')]
    fig, axes = plt.subplots(2, 2, figsize=(9, 6.4), dpi=200)
    x = np.arange(len(FAMILIES))
    w = 0.26
    for ax, (metric, title) in zip(axes.ravel(), metrics):
        stats = group_mean_std(rows, ['family', 'policy'], metric)
        for j, pol in enumerate(POLICIES):
            means = [stats.get((f, pol), (0, 0))[0] for f in FAMILIES]
            sds = [stats.get((f, pol), (0, 0))[1] for f in FAMILIES]
            ax.bar(x + (j - 1) * w, means, w, yerr=sds, capsize=2, color=COLOUR[pol], label=LABEL[pol])
        ax.set_xticks(x)
        ax.set_xticklabels([FAM_LABEL[f] for f in FAMILIES], fontsize=7.5)
        ax.set_title(title, fontsize=9)
        if metric == 'latency_ms':
            ax.set_yscale('log')
        ax.grid(axis='y', alpha=0.3)
    axes[0, 0].legend(fontsize=7.5)
    fig.suptitle('SAGE benchmark dashboard: mean over seeds, error bars = standard deviation', fontsize=9.5)
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)


def threshold_sweep(sweep_csv, headline_csv, out_png):
    rows = read_csv(sweep_csv)
    base = read_csv(headline_csv)
    fam = rows[0]['family']
    stats_d = group_mean_std(rows, ['tau'], 'deadlock_rate')
    stats_q = group_mean_std(rows, ['tau'], 'queue_rate')
    taus = sorted(stats_d)
    bd = group_mean_std([r for r in base if r['family'] == fam], ['policy'], 'deadlock_rate')
    bq = group_mean_std([r for r in base if r['family'] == fam], ['policy'], 'queue_rate')
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.6), dpi=200)
    for ax, stats, bases, ylabel in ((axes[0], stats_d, bd, 'Deadlock rate (per 1,000 events)'),
                                     (axes[1], stats_q, bq, 'Queue / denial rate (%)')):
        m = [stats[t][0] for t in taus]
        s = [stats[t][1] for t in taus]
        ax.errorbar([t[0] for t in taus], m, yerr=s, marker='o', color=COLOUR['sage'], capsize=2, label='SAGE (Markov)')
        for pol in ('bankers', 'reactive'):
            if (pol,) in bases:
                ax.axhline(bases[(pol,)][0], color=COLOUR[pol], ls='--', label=LABEL[pol])
        ax.set_xscale('log')
        ax.set_xlabel('risk threshold \u03c4')
        ax.set_ylabel(ylabel)
        ax.grid(alpha=0.3)
    axes[0].legend(fontsize=7.5)
    fig.suptitle('Threshold sweep on the %s workload (mean \u00b1 s.d. over seeds)' % FAM_LABEL.get(fam, fam).lower(), fontsize=9.5)
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)


def shift_timeseries(series_csv, out_png, shift_tick):
    rows = read_csv(series_csv)
    bins = sorted(set(r['bin'] for r in rows))
    acc = [np.mean([r['accuracy'] for r in rows if r['bin'] == b]) for b in bins]
    fb = [np.mean([r['fallback'] for r in rows if r['bin'] == b]) for b in bins]
    fig, ax = plt.subplots(figsize=(8, 3.4), dpi=200)
    ax.plot(bins, acc, marker='o', ms=3, color=COLOUR['sage'], label='next-event accuracy of the shifted processes (%)')
    ax.plot(bins, fb, marker='s', ms=3, color=COLOUR['reactive'], label='share of their decisions sent to the fallback (%)')
    ax.axvline(shift_tick, color='k', ls=':', label='behaviour shift (A\u2192B\u2192C to A\u2192D\u2192E)')
    ax.set_xlabel('event index (bin start)')
    ax.set_ylabel('%')
    ax.set_ylim(-3, 103)
    ax.grid(alpha=0.3)
    ax.legend(fontsize=7.5, loc='lower right')
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)


def latency_plot(latency_csv, out_png, baselines):
    rows = [r for r in read_csv(latency_csv) if r['H'] and r['H'] > 0]
    Hs = sorted(set(r['H'] for r in rows))
    Ks = sorted(set(r['K'] for r in rows))
    fig, ax = plt.subplots(figsize=(6.5, 3.6), dpi=200)
    for H in Hs:
        pts = sorted((r['K'], r['latency_ms']) for r in rows if r['H'] == H)
        ax.plot([p[0] for p in pts], [p[1] for p in pts], marker='o', ms=3, label='H = %d' % H)
    for pol, v in baselines.items():
        ax.axhline(v, color=COLOUR[pol], ls='--', label='%s (%.4f ms)' % (LABEL[pol], v))
    ax.set_xscale('log')
    ax.set_yscale('log')
    ax.set_xticks(Ks)
    ax.set_xticklabels([str(int(k)) for k in Ks])
    ax.set_xlabel('K (simulated futures per decision)')
    ax.set_ylabel('mean decision latency (ms)')
    ax.grid(alpha=0.3, which='both')
    ax.legend(fontsize=7, ncol=2)
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)
