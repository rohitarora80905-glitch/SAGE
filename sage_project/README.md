# SAGE – Simulated Ahead-of-Time Grant Evaluator (v3)

Trace-driven simulator for deadlock-risk avoidance without declared maximum resource demand,
with the classical baselines (Banker's Algorithm with and without declarations, reactive DFS
detection, timeout, wait-die, wound-wait), a synthetic workload generator, a benchmark harness,
metrics, an LSTM behaviour-model engine, a web console served by uvicorn and a Groq-backed analyst.

Course: BCSE303P – Operating Systems Lab (Concurrency and Scheduling Track), Vellore
Institute of Technology. Team: Harvi Bhavin Patel (24BCE2557), Srishti Saluja (24BCE2587).

## Versions

| Version | What it is |
|---|---|
| v1 | First decision rule: Markov chain, rollouts, blind fallback for unpredictable processes. Passed its tests; on random workloads it caused more deadlocks than granting everything. |
| v2 | Context tables, CUSUM drift monitor, learned-claims safety check as the fallback, early-stopping rollouts, starvation guard, partial rollback. The archived benchmark in `results/` is v2. |
| **v3** (current) | v2's decision rule and defaults unchanged (archived cells re-run with v3 code reproduce exactly), plus the LSTM engine, the web console with replay, the Groq analyst, custom workloads, 33 verification checks and the animated project document. `sagesim.__version__ == '3.0'`. |

The full history, with every v1 against v2 comparison, is in `../SAGE_Interactive_Report.html` (also served by the console at `/report`).

## Quick start

```
pip install -r requirements.txt
python tests/verify.py          # 33 verification cases with known answers
python -m server                # the console at http://127.0.0.1:8000
```

The console needs no GPU. The Groq analyst needs an API key: put `GROQ_API_KEY=gsk_...` in
`sage_project/.env` (see `.env.example`), export it in the environment, or paste it in the
console's Analyst section. Without a key every other feature works; the AI panels report that the
analyst is offline.

## The project document

`docs/index.html` is a standalone, animated document that covers the whole project: the problem,
the decision workflow, a live replay of the same seeded workload under reactive detection and
SAGE, one decision's hundred futures, the two behaviour engines and the gate, drift and the
fallback, the six rivals, the workloads, the full benchmark, the verification suite, the console
and the analyst's own report. It is served by the console at `/docs/` and can be published with
GitHub Pages from the `docs/` folder. Rebuild it after changing the code or the archive:

```
python docs/build_data.py      # runs the simulator, reads the archive, runs the tests (a few minutes)
python docs/refresh_ai.py      # optional: refresh the analyst section from the running console
python docs/build.py           # assembles docs/index.html from docs/parts and docs/data.json
```

## The console

| Section | What it does |
|---|---|
| Overview | Headline numbers and charts from the benchmark archive; every method ranked by completed work |
| Simulator | Run any policy on any workload with every parameter exposed; KPI tiles, time series, decision paths, risk histogram, process/model table, decision log, deadlock log and a **replay** that steps through the run (allocation matrix, wait-for graph, the decision and the outcome of its simulated futures) |
| Compare | Same workload and seeds for every selected policy, including SAGE with the Markov and the LSTM engine; mean ± s.d. charts and table; threshold sweep over τ |
| Workload studio | Describe a scenario in words and let the analyst design the processes (validated server-side, retried on rejection), or edit the JSON spec by hand; classic presets (printer–scanner, dining philosophers, …) |
| Benchmark archive | The CSVs written by `experiments/run_all.py` and `experiments/compare_all.py`, aggregated and charted, plus the matplotlib figures |
| Verification | Runs `tests/verify.py` and lists every case |
| Analyst | Chat with the selected runs in context; connection and model settings |
| Method | The decision rule, the models, the LSTM engine, baselines, metrics |

Every chart has a hover tooltip and a table view; the theme follows the system and can be toggled.

## Layout

```
sagesim/
  rag.py              live state (A, Q, V), event coding, wait-for graph, DFS cycle check
  behaviour_model.py  per-process Markov chain with two context tables, and a CUSUM drift monitor
  lstm_model.py       LSTM engine: a recurrent network over the whole history, gated by prequential score
  rollout.py          sandboxed K x H rollout, vectorised over the K futures, exact deadlock check
  sage.py             SAGE policy: confidence check, rollout, threshold gate, fallback, stall handler
  bankers.py          Banker's Algorithm baseline (safety check, request handling)
  reactive.py         reactive DFS baseline
  baselines.py        Banker's without declaration, wait-die, wound-wait, timeout
  workload.py         process types (fixed, bursty, escalating, custom), families, specs from JSON
  harness.py          event loop, scheduler, blocking/detection/recovery, respawn, trace, progress
  metrics.py          per-run metrics, lead-time analysis
  dashboard.py        dashboard and experiment plots
server/
  app.py              FastAPI application: jobs, archive, workloads, AI routes, static files
  jobs.py             background jobs with progress and cancellation
  payload.py          run record -> JSON (summary, series, logs, processes, replay trace)
  ai.py               Groq analyst: run analysis, decision explanation, workload design, chat
  static/             index.html, app.css, app.js, charts.js (no build step, no framework)
experiments/run_all.py     headline benchmark, accuracy, lead time, threshold sweep, shift, latency
experiments/compare_all.py every policy on every workload, 100 seeds; four system sizes
tests/verify.py            verification cases with known answers
results/                   CSV outputs of the experiments (+ run_log.txt, config.json)
plots/                     dashboard.png, threshold_sweep.png, shift_timeseries.png, latency.png
```

## Running the experiments

```
python -m experiments.run_all          # seeds 0-19, about 15-20 minutes on one CPU core
python -m experiments.run_all --quick
python -m experiments.compare_all      # 100 seeds x 5 workloads x 7 policies, plus system sizes
```

`results/headline.csv` has one row per (family, policy, seed); `headline_summary.csv` the
mean and standard deviation per family and policy. The remaining CSVs are `accuracy.csv`,
`leadtime.csv`, `sweep.csv`, `shift.csv`, `shift_series.csv`, `latency.csv`, `compare_all.csv`
and `compare_sizes.csv`.

## Configuration

Defaults live in `sagesim/harness.py` (`CONFIG`): n = 6 processes, m = 8 single-instance
resources, 1,500 events per run, K = 100 futures, H = 30 steps, tau = 0.10, h_min = 20,
drift_h = 8 (CUSUM drift threshold; probability floor 1e-3), min_ll = -1.0 (predictability floor),
fallback = 'claims', aging = 400 and life_aging = 900 (starvation guard), recovery = 'partial',
shift at event 600, model = 'markov' (or 'lstm'). Any value can be overridden per run:
`run('sage', 'mixed', seed=0, tau=0.2, K=50, model='lstm')`. `fallback='reactive'` restores the
plain reactive fallback, `aging=0` turns the starvation guard off and `recovery='restart'`
restarts deadlock victims from the beginning of their program. `trace=True` records a snapshot per
event for the replay; `progress=callback` reports every 25 events; `types=` runs a custom workload
(`workload.types_from_spec`).

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

### The LSTM engine

With `model='lstm'` every process also trains a small recurrent network on its own event
stream (input: last event, holdings, episode peak and count; output: the next event). Training
is online and prequential: each event is scored before it is learned, and an Adam step of
truncated back-propagation through time runs every 8 events (every 2 during the first 256),
on the most recent window and a replayed earlier one. The network is *gated*: it is used for
a process only while it beats the Markov tables on a decayed prequential log-likelihood and on
next-event hits, so the combined model is never worse than the chain for long. When the
network is in use the table the rollout samples from is conditioned on the whole history (the
row of the actual state is the network's forecast; every other row is the forecast after one
hypothetical step), so the rollout engine and the policy run unchanged. On this project's
workloads the network matches the chain on fixed and escalating patterns and predicts bursty
processes about six points better, which is where the gate hands over to it.

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

## The analyst (Groq)

`server/ai.py` sends the language model the evidence of a run as JSON (configuration, metrics,
decision paths, risk histogram, deadlocks, the highest-risk queued requests, per-process model
diagnostics) and asks for a sourced, quantitative report; for a single decision it adds the state
before and after that event from the replay trace. Workload design uses JSON mode and the server's
validator, with the rejection fed back for a corrected attempt. The model never takes part in a
decision; the simulator is deterministic and independent of it. The key is read from
`GROQ_API_KEY` (environment or `.env`), can be set from the console, and never reaches the browser.

## Custom workloads

```json
{"title": "Printer and scanner", "m": 2, "resources": ["printer", "scanner"],
 "processes": [{"name": "P1", "type": "custom", "ops": ["req 0", "req 1", "rel 1", "rel 0"], "cycles": [3, 6]},
               {"name": "P2", "type": "custom", "ops": ["req scanner", "req printer", "rel printer", "rel scanner"]},
               {"name": "P3", "type": "fixed", "seq": [1, 0]},
               {"name": "P4", "type": "escalating", "order": [0, 1], "levels": 2},
               {"name": "P5", "type": "bursty", "max_held": 2}]}
```

Ops accept indices, resource names or `R1`-style labels; a custom program must never request what
it holds or release what it does not hold, and missing releases are appended before the exit.
