# SAGE – Simulated Ahead-of-Time Grant Evaluator

Trace-driven simulator for deadlock-risk avoidance without declared maximum resource
demand, with the two classical baselines (Banker's Algorithm, reactive DFS detection),
a synthetic workload generator, a benchmark harness, metrics and a results dashboard.

Course: BCSE303P – Operating Systems Lab (Concurrency and Scheduling Track), Vellore
Institute of Technology. Team: Harvi Bhavin Patel (24BCE2557), Srishti Saluja (24BCE2587).

## Layout

```
sagesim/
  rag.py              live state (A, Q, V), event coding, wait-for graph, DFS cycle check
  behaviour_model.py  per-process Markov chain with two context tables, and a CUSUM drift monitor
  lstm_model.py       planned LSTM variant (interface stub only)
  rollout.py          sandboxed K x H rollout, vectorised over the K futures, exact deadlock check
  sage.py             SAGE policy: confidence check, rollout, threshold gate, fallback, stall handler
  bankers.py          Banker's Algorithm baseline (safety check, request handling)
  reactive.py         reactive DFS baseline
  workload.py         process types (fixed-pattern, bursty/random, gradually escalating), families
  harness.py          event loop, scheduler, blocking/detection/recovery, respawn, logging
  metrics.py          per-run metrics, lead-time analysis
  dashboard.py        dashboard and experiment plots
experiments/run_all.py  headline benchmark, accuracy, lead time, threshold sweep, shift, latency
tests/verify.py         verification cases with known answers
results/                CSV outputs of the experiments (+ run_log.txt, config.json)
plots/                  dashboard.png, threshold_sweep.png, shift_timeseries.png, latency.png
```

## Requirements

Python 3.10+ with NumPy and Matplotlib (`pip install -r requirements.txt`). No GPU.

## Running

```
python3 tests/verify.py              # the 21 verification cases (should all pass)
python3 -m experiments.run_all       # full benchmark, seeds 0-19 (about 15-20 minutes on one CPU core)
python3 -m experiments.run_all --quick
```

`results/headline.csv` has one row per (family, policy, seed); `headline_summary.csv` the
mean and standard deviation per family and policy. The remaining CSVs are `accuracy.csv`,
`leadtime.csv`, `sweep.csv`, `shift.csv`, `shift_series.csv` and `latency.csv`.

## Configuration

Defaults live in `sagesim/harness.py` (`CONFIG`): n = 6 processes, m = 8 single-instance
resources, 1,500 events per run, K = 100 futures, H = 30 steps, tau = 0.10, h_min = 20,
drift_h = 8 (CUSUM drift threshold; probability floor 1e-3), min_ll = -1.0 (predictability floor),
fallback = 'claims', aging = 400 and life_aging = 900 (starvation guard),
recovery = 'partial', shift at event 600. Any value can be overridden per run:
`run('sage', 'mixed', seed=0, tau=0.2, K=50)`. `fallback='reactive'` restores the plain
reactive fallback, `aging=0` turns the starvation guard off and `recovery='restart'`
restarts deadlock victims from the beginning of their program.

## Decision rule (summary)

For a request of a free resource, SAGE first checks its confidence in the requester's
behaviour model. With enough history and a predictable model it simulates K futures of
H steps from the live state with the request granted; the risk is the share of futures
in which the requester ends up on a wait-for cycle, and the request is queued when the
risk is at least tau. In the sandbox, events are restricted to what each process can do
with what it holds, only runnable processes are scheduled, and requests the policy has
already queued stay queued.

The behaviour model is a Markov chain over each process's own events, with predictions
restricted to what the process can do with what it holds. It also keeps two context tables,
indexed by the episode peak (the most resources held since the process last held nothing)
and by the number of holding episodes completed in the current life; they tell apart
situations a first-order chain confuses (another level or exit, another cycle or exit).
Context rows are smoothed towards the plain row, and a process switches to a context table
only once that table has beaten the plain one on both log-likelihood and correct
predictions. Drift is detected with a CUSUM of the surprise of every event under the table
in use, so a change of behaviour is caught within a few events of the process.

When the model is not trusted - fewer than h_min observed transitions (cold), a fitted
model whose average log-likelihood is below min_ll (uncertain: a near-random process),
or a CUSUM of surprise above drift_h (drift: the behaviour has changed) - the request goes to the
fallback: a Banker's-style safety check with *learned claims*. A process's claim is the
set of resources its request log shows it has ever asked for, and a process holding as
many resources as it was ever seen to hold at once is taken to release before asking
for more. Nothing has to be declared in advance.

Starvation guard: while a waiting process has waited `aging` ticks in one go, or has gone
`life_aging` ticks without completing a life, processes that hold nothing are held back
so that it can get through (no hold-and-wait is created), and the stall handler only
considers overdue requests. Deadlocks are resolved by aborting the cycle member aborted
least often so far and rolling it back to the last point at which it held nothing.

`metrics.summarise` also reports `starved` (process slots that never completed a life in
the run) and `min_slot_completed`, so that a policy cannot look good by starving some
processes. In shadow mode (lead-time experiment) a warning is raised whenever SAGE would
have queued the request.
