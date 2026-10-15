# SAGE · Simulated Ahead-of-Time Grant Evaluator (v3)

Deadlock avoidance that learns what each process will do next. SAGE fits a behaviour model to every
process from its own request log, simulates K short futures of the system for each request of a
free resource, and queues the request when too many of those futures end in a deadlock. It needs no
declared maximum demand, which the Banker's algorithm requires and real programs rarely have.

BCSE303P Operating Systems Lab (Concurrency and Scheduling Track), Vellore Institute of Technology.
Harvi Bhavin Patel (24BCE2557) · Srishti Saluja (24BCE2587).

## What is here

| Path | Contents |
|---|---|
| [`docs/index.html`](docs/index.html) | Animated project document: the problem, the live decision workflow, a twin replay of a real run (reactive detection against SAGE), one decision's hundred futures, both behaviour engines, the full benchmark, the verification suite, the console and the analyst's report. |
| [`SAGE_Project_Document.html`](SAGE_Project_Document.html) | The same document as one self-contained file: fonts and screenshots embedded, no links out, opens offline by double-click. Rebuild with `python docs/make_standalone.py`. |
| [`SAGE_Interactive_Report.html`](SAGE_Interactive_Report.html) | The complete v1 → v2 → v3 report, with every comparison between versions and against six textbook methods. |
| [`sage_project/`](sage_project/) | The simulator, the baselines, the LSTM engine, the experiments, the verification suite and the web console. See its [README](sage_project/README.md). |

## Quick start

```
cd sage_project
pip install -r requirements.txt
python tests/verify.py      # 33 checks with known answers
python -m server            # console at http://127.0.0.1:8000 (project document at /docs/, report at /report)
```

The analyst needs a Groq API key: put `GROQ_API_KEY=...` in `sage_project/.env`, or paste it in the
console's Connect AI dialog, which also lists the models available to the key.

## Headline results (archive, 20 seeds per workload, 6 processes, 8 resources, 1,500 events)

| Mixed workload | Deadlocks per 1,000 events | Completed lives per 1,000 events | Requests queued |
|---|---|---|---|
| SAGE | 1.27 | 54.4 | 20.8% |
| Banker's algorithm (true maxima declared) | 0 | 55.2 | 14.2% |
| Reactive detection | 23.4 | 45.8 | 0% |

Over all seven methods and five workloads (3,500 runs), SAGE completes the most work of any method,
including Banker's algorithm with declared maxima, without being told anything in advance.
