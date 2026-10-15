"""Groq-backed analyst for the console.

The language model never decides anything in the simulator: it reads the numbers a run
produced (metrics, decision paths, deadlocks, the state at a decision, model diagnostics) and
writes the analysis, explains a single decision, designs a workload from a description, and
answers questions about the method. Every prompt carries the evidence as structured JSON and
asks for a quantitative, sourced answer.

The API key is read from GROQ_API_KEY (environment or a .env file next to the project or in
the repository root) or set from the console at run time. Without a working key every AI
feature reports its status and the rest of the console works as usual.
"""
import json
import os
import re
import threading
import time

try:
    from dotenv import load_dotenv
    for _p in (os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'),
               os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), '.env')):
        if os.path.exists(_p):
            load_dotenv(_p, override=True)       # a key saved from the console wins over a stale environment variable
except ImportError:
    pass

try:
    import groq
    from groq import Groq
    HAVE_GROQ = True
except ImportError:                   # the console runs without the SDK; AI features report 'unavailable'
    HAVE_GROQ = False

PREFERRED = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'meta-llama/llama-4-maverick-17b-128e-instruct',
             'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']
SMALL = ('allam', 'guard', '1b', '2b', '3b', '7b', '8b', 'tiny', 'mini')      # last resort only


def rank_model(model_id):
    """Preferred models first, then anything large and general, then small or special-purpose ones."""
    mid = model_id.lower()
    if model_id in PREFERRED:
        return (0, PREFERRED.index(model_id))
    if any(t in mid for t in SMALL):
        return (2, mid)
    return (1, mid)

SYSTEM = """You are the resident analyst of the SAGE console. SAGE (Simulated Ahead-of-Time Grant Evaluator) is a
deadlock-avoidance policy for an operating-systems course (BCSE303P, VIT): instead of declared maximum demands
(Banker's algorithm) it learns a behaviour model per process from its own request log and, for every request of a
free resource, simulates K futures of H steps with the request granted; the risk is the share of futures in which
the requester ends up on a wait-for cycle, and the request is queued when risk >= tau.

Behaviour models: a first-order Markov chain over the process's events with two context tables (episode peak,
episode count), optionally combined with a small LSTM that reads the whole history and is used only once it beats
the tables on a decayed prequential log-likelihood (the 'engine' of a process: markov, markov+peak, markov+count or
lstm). Confidence paths: 'learned' (model trusted -> rollout), 'cold' (< h_min transitions), 'uncertain' (fitted
log-likelihood < min_ll, near-random process), 'drift' (CUSUM of surprise > drift_h, behaviour changed). The
non-learned paths go to the fallback: a Banker's-style safety check with learned claims (resources the process was
ever seen to request; a process at its learned holding limit is taken to release first). 'drain' is the starvation
guard: while another request is overdue (aging / life_aging ticks), processes holding nothing are held back.
Deadlocks that still occur (all policies) are detected exactly (cycle in the wait-for graph) and resolved by
aborting the cycle member aborted least often, rolled back to the last point where it held nothing.

Baselines: bankers (true maxima declared: the most favourable setting), bankers_nodecl (nothing declared: every
process may need everything), reactive (grant if free, detect, abort), timeout (no detection, blocked too long ->
rollback), wait_die and wound_wait (timestamp prevention).

Metrics: deadlock_rate = deadlocks per 1,000 events; queue_rate = % of free-resource requests the policy queued;
throughput = completed process lives per 1,000 events; latency_ms = mean decision latency; fallback_rate = % of
decisions through the fallback; rollback_rate / wasted_rate = rollbacks and undone program steps per 1,000 events;
starved = process slots that never completed a life; min_slot_completed = completions of the least served slot.

Rules: be precise and quantitative; quote only numbers present in the evidence (never invent any); say when the
evidence is thin; keep a professional, concise register; use Markdown with short headings and tight bullets; no
emojis. Address an operating-systems student or engineer."""


def _jdump(x, limit=None):
    s = json.dumps(x, separators=(',', ':'), default=str)
    if limit and len(s) > limit:
        s = s[:limit] + '...'
    return s


class Analyst:
    def __init__(self):
        self.lock = threading.Lock()
        self.key = None
        self.source = None
        self.client = None
        self.models = []
        self.model_info = {}
        self.model = None
        self.status = 'unavailable' if not HAVE_GROQ else 'missing'
        self.error = None
        self.checked_at = 0.0
        self.load_env()

    # -- configuration -------------------------------------------------------------
    def load_env(self):
        key = os.environ.get('GROQ_API_KEY', '').strip()
        if key:
            self.configure(key, source='environment')
        pref = os.environ.get('GROQ_MODEL', '').strip()
        if pref:
            self.model = pref

    def configure(self, key, source='console'):
        key = (key or '').strip().strip('"').strip("'")
        with self.lock:
            self.key = key or None
            self.source = source if key else None
            self.client = Groq(api_key=key) if (HAVE_GROQ and key) else None
            self.status = ('missing' if not key else 'unchecked') if HAVE_GROQ else 'unavailable'
            self.error = None
            self.checked_at = 0.0
            self.models = []
            self.model_info = {}
        return self.check(force=True)

    def check(self, force=False):
        """Verify the key by listing models (cached for ten minutes)."""
        if not HAVE_GROQ:
            self.status = 'unavailable'
            self.error = 'the groq package is not installed (pip install groq)'
            return self.public()
        if self.client is None:
            self.status = 'missing'
            return self.public()
        if not force and time.time() - self.checked_at < 600 and self.status == 'ok':
            return self.public()
        try:
            data = self.client.models.list().data
            ids = sorted(m.id for m in data if getattr(m, 'active', True))
            chat = [i for i in ids if not any(t in i for t in ('whisper', 'tts', 'guard', 'embed', 'orpheus', 'playai', 'compound'))]
            chat = sorted(chat, key=rank_model)
            self.models = chat
            self.model_info = {m.id: getattr(m, 'context_window', None) for m in data if m.id in chat}
            if self.model not in chat:
                self.model = chat[0] if chat else None
            self.status = 'ok' if self.model else 'error'
            self.error = None if self.model else 'no chat model available to this key'
        except groq.AuthenticationError as e:
            self.status, self.error = 'invalid', 'Groq rejected the key (401 invalid_api_key)'
        except groq.APIConnectionError as e:
            self.status, self.error = 'offline', 'cannot reach api.groq.com: %s' % e
        except Exception as e:                       # noqa: BLE001
            self.status, self.error = 'error', '%s: %s' % (type(e).__name__, e)
        self.checked_at = time.time()
        return self.public()

    def public(self):
        hint = None
        if self.key:
            hint = self.key[:4] + '...' + self.key[-3:]
        return dict(available=HAVE_GROQ, status=self.status, error=self.error, model=self.model, models=self.models,
                    model_info=self.model_info, source=self.source, key_hint=hint, checked_at=self.checked_at)

    def set_model(self, model):
        if model and (not self.models or model in self.models):
            self.model = model
        return self.public()

    # -- calls -----------------------------------------------------------------------
    def _ensure(self):
        if self.status != 'ok':
            self.check()
        if self.status != 'ok':
            raise RuntimeError(self.error or {'missing': 'no Groq API key configured', 'unavailable': 'groq package missing'}.get(self.status, 'AI unavailable'))

    def stream(self, messages, model=None, temperature=0.3, max_tokens=2500, json_mode=False):
        """Yield text chunks of a streamed completion. Errors are yielded as a final line prefixed with '\\n\\n**Error**'."""
        try:
            self._ensure()
            kw = dict(model=model or self.model, messages=[dict(role='system', content=SYSTEM)] + messages,
                      temperature=temperature, max_tokens=max_tokens, stream=True)
            if json_mode:
                kw['response_format'] = {'type': 'json_object'}
            for chunk in self.client.chat.completions.create(**kw):
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta and delta.content:
                    yield delta.content
        except Exception as e:                       # noqa: BLE001
            if HAVE_GROQ and isinstance(e, groq.AuthenticationError):
                self.status, self.error = 'invalid', 'Groq rejected the key (401 invalid_api_key)'
            yield '\n\n**Error:** %s' % (self.error if self.status != 'ok' else '%s: %s' % (type(e).__name__, e))

    def complete(self, messages, model=None, temperature=0.2, max_tokens=2500, json_mode=False):
        self._ensure()
        kw = dict(model=model or self.model, messages=[dict(role='system', content=SYSTEM)] + messages,
                  temperature=temperature, max_tokens=max_tokens)
        if json_mode:
            kw['response_format'] = {'type': 'json_object'}
        try:
            r = self.client.chat.completions.create(**kw)
        except groq.AuthenticationError:
            self.status, self.error = 'invalid', 'Groq rejected the key (401 invalid_api_key)'
            raise RuntimeError(self.error)
        return r.choices[0].message.content or ''

    # -- evidence builders ----------------------------------------------------------
    @staticmethod
    def run_evidence(p):
        """Compact, numbers-only view of a run payload."""
        s = p['summary']
        keep = ['deadlock_rate', 'queue_rate', 'throughput', 'latency_ms', 'latency_ms_max', 'fallback_rate',
                'rollback_rate', 'wasted_rate', 'starved', 'min_slot_completed', 'completed', 'deadlocks', 'blocked',
                'free_requests', 'forced', 'restarts', 'risk_mean', 'events']
        procs = []
        for q in p['processes']:
            d = dict(name=q['name'], type=q['personality'], completed=q['completed'], aborts=q['aborts'],
                     accuracy=None if q.get('accuracy') is None else round(q['accuracy'], 1), pattern=q.get('pattern'))
            if q.get('model'):
                mm = q['model']
                d.update(engine=mm.get('engine'), support=mm.get('support'), fit_loglik=round(mm.get('fit_loglik') or 0, 2),
                         cusum=round(mm.get('cusum') or 0, 2), path_now=q.get('path_now'))
                if mm.get('lstm'):
                    d['lstm'] = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in mm['lstm'].items()
                                 if k in ('use_lstm', 'lstm_ll', 'ref_ll', 'train_steps', 'switches')}
            procs.append(d)
        waits = sorted([d for d in p['decisions'] if d['d'] == 'wait' and not d['reeval']], key=lambda d: -(d['risk'] or 0))[:12]
        cfg = {k: p['config'][k] for k in ('n', 'm', 'ticks', 'K', 'H', 'tau', 'h_min', 'drift_h', 'min_ll', 'aging',
                                           'life_aging', 'fallback', 'recovery', 'model', 'timeout') if k in p['config']}
        return dict(policy=p['policy'], family=p['family'], seed=p['seed'], config=cfg,
                    metrics={k: (round(s[k], 3) if isinstance(s.get(k), float) else s.get(k)) for k in keep},
                    counts=p['counts'], decision_paths=p['paths'], risk_histogram=p['risk_hist'],
                    deadlocks=p['deadlocks'][:25], deadlocks_total=len(p['deadlocks']),
                    queued_requests_highest_risk=[dict(t=d['t'], process=p['processes'][d['i']]['name'], resource=p['resources'][d['r']],
                                                        risk=d['risk'], path=d['path']) for d in waits],
                    processes=procs, resources=p['resources'],
                    series=dict(bin_width=p['series']['width'], deadlocks=p['series']['deadlocks'],
                                completions=p['series']['completions'], queued=p['series']['queued']))

    def analyse_run(self, p, focus=None):
        ev = self.run_evidence(p)
        ask = ("Write the analyst's report for this run. Sections: **Verdict** (two sentences), **What happened** "
               "(the numbers that matter, with units), **How the policy decided** (paths, risks, queued requests, "
               "fallback use, deadlocks and their resolution), **Processes and models** (which models were trusted, "
               "engines in use, accuracy, anything anomalous), **Tuning** (concrete parameter values to try and the "
               "expected effect, referring to tau, K, H, h_min, drift_h, aging), **Against the textbook methods** "
               "(what Banker's or reactive detection would have done differently here). Under 450 words.")
        if focus:
            ask += ' The reader specifically asks: %s' % focus
        return [dict(role='user', content='EVIDENCE (JSON):\n%s\n\n%s' % (_jdump(ev, 14000), ask))]

    def explain_decision(self, p, k):
        d = p['decisions'][k]
        tr = p.get('trace') or []
        before = next((e for e in reversed(tr) if e['t'] < d['t']), None)
        at = next((e for e in tr if e['t'] == d['t']), None)
        names = [q['name'] for q in p['processes']]
        res = p['resources']

        def state_view(e):
            if not e:
                return None
            out = []
            for i in range(p['n']):
                held = [res[r] for r in range(p['m']) if e['alloc'][i] >> r & 1]
                st = {0: 'runnable', 1: 'waiting', 2: 'done'}[e['status'][i]]
                w = None
                if e['status'][i] == 1 and e['pending'][i] >= 0:
                    w = dict(for_=res[e['pending'][i]], because={1: 'held by another process', 2: 'queued by the policy'}.get(e['reason'][i], 'other'))
                out.append(dict(process=names[i], holds=held, state=st, waiting=w, completed=e['done'][i]))
            return out
        req = p['processes'][d['i']]
        ev = dict(decision=dict(tick=d['t'], process=req['name'], resource=res[d['r']], outcome=d['d'], risk=d['risk'],
                                path=d['path'], latency_ms=round(d['ms'], 3), re_evaluation=d['reeval'],
                                futures=(at or {}).get('decision', {}).get('fut') if at and (at.get('decision') or {}).get('i') == d['i'] else None),
                  requester=dict(type=req['personality'], pattern=req.get('pattern'), model=req.get('model')),
                  config={k: p['config'][k] for k in ('K', 'H', 'tau', 'h_min', 'drift_h', 'min_ll', 'aging', 'fallback', 'model')},
                  state_before=state_view(before), state_after=state_view(at),
                  deadlocks_within_50_ticks=[x for x in p['deadlocks'] if d['t'] <= x['t'] <= d['t'] + 50])
        ask = ("Explain this single decision to a student: what the requester holds and wants, which confidence path "
               "was taken and why, what the rollout (or the learned-claims safety check) found, why the outcome follows "
               "from tau, and whether hindsight (deadlocks shortly after, if any) agrees. Under 220 words, Markdown, "
               "no headings larger than ###.")
        return [dict(role='user', content='EVIDENCE (JSON):\n%s\n\n%s' % (_jdump(ev, 9000), ask))]

    def analyse_compare(self, c):
        rows = c['summary']
        ask = ("Compare these policies on the same workloads and seeds. Sections: **Ranking** (by completed work "
               "and by deadlocks, with the numbers), **Trade-offs** (queueing vs deadlocks vs rollbacks, latency), "
               "**SAGE specifically** (and, if present, the LSTM engine against the Markov engine), **Recommendation** "
               "for a system that cannot declare maximum demands. Under 350 words.")
        ev = dict(family=c.get('family'), seeds=c.get('seeds'), config=c.get('config'),
                  per_policy=[{k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()} for r in rows])
        return [dict(role='user', content='EVIDENCE (JSON):\n%s\n\n%s' % (_jdump(ev, 12000), ask))]

    def chat_messages(self, messages, contexts):
        ctx = ''
        for c in contexts[:3]:
            if c.get('kind') == 'run':
                ctx += '\nRUN %s (JSON): %s' % (c.get('id'), _jdump(self.run_evidence(c['payload']), 7000))
            elif c.get('kind') == 'compare':
                ctx += '\nCOMPARISON %s (JSON): %s' % (c.get('id'), _jdump(c['payload'].get('summary'), 7000))
        out = []
        if ctx:
            out.append(dict(role='user', content='Context for the conversation that follows.%s' % ctx))
            out.append(dict(role='assistant', content='Understood. I will refer to these results by their numbers.'))
        for mm in messages[-16:]:
            if mm.get('role') in ('user', 'assistant') and mm.get('content'):
                out.append(dict(role=mm['role'], content=str(mm['content'])[:6000]))
        return out

    WORKLOAD_SCHEMA = """{
  "title": "short name of the scenario",
  "m": <number of single-instance resources, 2..12>,
  "resources": ["name of resource 0", ...],           // exactly m names
  "processes": [                                       // 2..12 entries
    {"name": "P1", "type": "custom", "ops": ["req 0", "req 1", "rel 1", "rel 0"], "cycles": [3, 6]},
    {"name": "P2", "type": "fixed", "seq": [1, 0]},    // requests seq in order, releases in reverse, 4-8 cycles per life
    {"name": "P3", "type": "escalating", "order": [0, 1, 2, 3], "levels": 3},   // order: a permutation of ALL m resources
    {"name": "P4", "type": "bursty", "max_held": 2}    // random requests/releases
  ],
  "notes": "one sentence on what the scenario is meant to show"
}"""

    def design_workload(self, description, n_hint=None, m_hint=None, error=None, previous=None):
        ask = ("Design a workload for the SAGE simulator from this description:\n\"%s\"\n\n"
               "Return ONLY a JSON object with this shape (no prose):\n%s\n"
               "Rules: ops use 'req <index>' and 'rel <index>' with resource indices 0..m-1 (never names); a custom "
               "program must never request a resource it holds nor release one it does not hold, and must release "
               "everything by its end; every process must acquire at least one resource; keep programs short (4-16 ops); "
               "use at least two processes; if the description implies a deadlock-prone pattern (opposite lock orders, "
               "hold-and-wait), reproduce it faithfully." % (description, self.WORKLOAD_SCHEMA))
        if n_hint:
            ask += ' Use about %d processes.' % n_hint
        if m_hint:
            ask += ' Use %d resources.' % m_hint
        msgs = [dict(role='user', content=ask)]
        if error and previous:
            msgs.append(dict(role='assistant', content=previous))
            msgs.append(dict(role='user', content='That JSON was rejected: %s. Return a corrected JSON object only.' % error))
        text = self.complete(msgs, temperature=0.2, json_mode=True)
        m = re.search(r'\{.*\}', text, re.S)
        return json.loads(m.group(0) if m else text), text
