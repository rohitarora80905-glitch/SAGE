"""Event loop that runs any policy on a seeded workload and records per-decision data.

Model: n process slots, m single-instance resources. Each slot runs a program of ops
(request, release, exit) generated from its process type. At every tick the scheduler
picks one runnable process uniformly at random (seeded) and executes its next op:

  request r  - if r is held by another process the requester blocks (all policies), a
               wait-for edge is added and the exact DFS cycle check runs; a cycle is a
               deadlock, counted once and resolved by aborting one process of the cycle.
               The victim releases everything and is rolled back only as far as needed
               (recovery='partial', the default): to the last point of its program at which
               it held nothing, so work it finished before that is kept; recovery='restart'
               restarts its program from the beginning. The victim is the member aborted
               least often so far, preferring the process whose request closed the cycle;
               counting past rollbacks keeps one process from being chosen as the victim
               over and over (Silberschatz et al., recovery from deadlock).
             - if r is free the policy decides GRANT / WAIT / FALLBACK. WAIT (Banker's
               unsafe state, SAGE risk >= tau or unsafe learned claims) queues the request;
               FALLBACK (SAGE with fallback='reactive') applies the reactive rule, i.e. grant.
  release r  - frees r and re-evaluates queued and blocked requests in arrival order.
  exit       - releases everything, counts a completion and respawns the slot with a
               fresh program of the same type (the behaviour model of the slot persists).

If no process is runnable and some requests are queued by policy, the policy's stall
handler force-grants one of them (counted). All randomness is seeded, so two runs with
the same seed and configuration produce identical logs.

Behaviour models: `model='markov'` (the first-order chain with context tables) or
`model='lstm'` (the chain plus a recurrent network gated by prequential score, see
lstm_model.py). Custom workloads: pass `types` (a list of ProcessType, e.g. from
workload.types_from_spec) in place of a family name. `progress(tick, ticks)` is called every
25 ticks (it may raise to cancel the run). With `trace=True` the run also records one
snapshot per tick (`R['trace']`) for replay: the actor and its event, the decision and its
risk, the allocation, every process's status and program position, deadlocks and the
per-future outcome of the rollout.
"""
from time import perf_counter
import numpy as np

from .rag import State, REQ, REL, EXIT, ACTIVE, WAITING, DONE, NONE, HELD, POLICY, has_cycle, find_cycle, start_state
from .behaviour_model import MarkovModel
from .workload import family_types, true_max, program_events
from .reactive import ReactivePolicy, GRANT, WAIT, FALLBACK
from .bankers import BankersPolicy
from .sage import SagePolicy
from .baselines import BankersNoDeclaration, WaitDiePolicy, WoundWaitPolicy, TimeoutPolicy

CONFIG = dict(n=6, m=8, ticks=1500, K=100, H=30, tau=0.10, h_min=20, w=10, drift_h=8.0, min_ll=-1.0,
              floor=1e-3, shift_tick=600, warmup_lives=1, aging=400, life_aging=900, fallback='claims',
              recovery='partial', timeout=50, model='markov', lstm_hidden=48, lstm_train_every=8, lstm_bptt=96)

POLICIES = ['sage', 'bankers', 'bankers_nodecl', 'reactive', 'timeout', 'wait_die', 'wound_wait']
MODELS = ['markov', 'lstm']


def checkpoint(program, upto, m):
    """Partial-rollback point of a program executed up to position `upto`: the last position at
    which the process held nothing, the event code it had emitted just before that point (START
    if the point is the beginning of the life), and its episode peak and episode count there."""
    held, peak, epis = set(), 0, 0
    best = (0, start_state(m), 0, 0)
    for k, code in enumerate(program_events(program[:upto], m)):
        if code < m:
            if not held:
                peak = 0
            held.add(code)
        elif code < 2 * m:
            held.discard(code - m)
            if not held:
                epis += 1
        peak = max(peak, len(held))
        if not held:
            best = (k + 1, code, peak, epis)
    return best


def make_model(cfg, m, seed=0, slot=0):
    """The behaviour model of one process slot."""
    if cfg.get('model', 'markov') == 'lstm':
        from .lstm_model import LSTMModel
        return LSTMModel(m, window=cfg['w'], floor=cfg['floor'], hidden=int(cfg.get('lstm_hidden', 48)),
                         train_every=int(cfg.get('lstm_train_every', 8)), bptt=int(cfg.get('lstm_bptt', 96)),
                         seed=int(seed) * 1009 + int(slot))
    return MarkovModel(m, window=cfg['w'], floor=cfg['floor'])


def make_policy(name, models, cfg, rng, maxima=None, shadow=False):
    if name == 'reactive':
        return ReactivePolicy()
    if name == 'bankers':
        return BankersPolicy(maxima)
    if name == 'bankers_nodecl':
        return BankersNoDeclaration(cfg['n'], cfg['m'])
    if name == 'wait_die':
        return WaitDiePolicy()
    if name == 'wound_wait':
        return WoundWaitPolicy()
    if name == 'timeout':
        return TimeoutPolicy(cfg['timeout'])
    if name == 'sage':
        return SagePolicy(models, K=cfg['K'], H=cfg['H'], tau=cfg['tau'], h_min=cfg['h_min'],
                          drift_h=cfg['drift_h'], min_ll=cfg['min_ll'], aging=cfg['aging'],
                          life_aging=cfg['life_aging'], fallback=cfg['fallback'], rng=rng, shadow=shadow)
    raise ValueError(name)


def run(policy_name, family, seed, cfg=None, shadow=False, types=None, progress=None, trace=False, **overrides):
    cfg = dict(CONFIG if cfg is None else cfg)
    cfg.update(overrides)
    if types is not None:
        cfg['n'] = len(types)
        cfg['m'] = types[0].m
    n, m = cfg['n'], cfg['m']
    rng_prog = np.random.default_rng([seed, 1])
    rng_sched = np.random.default_rng([seed, 2])
    rng_roll = np.random.default_rng([seed, 3])
    START = start_state(m)

    types = family_types(family, n, m, rng_prog) if types is None else list(types)
    models = [make_model(cfg, m, seed, i) for i in range(n)]
    # warm-up: each slot's model has seen one earlier life of its process (the historical request log)
    for i in range(n):
        for _ in range(cfg['warmup_lives']):
            prev, n_held, peak, epis = START, 0, 0, 0
            for e in program_events(types[i].program(rng_prog), m):
                models[i].update(prev, e, n_held + 1 if e < m else (n_held - 1 if e < 2 * m else 0), peak, epis)
                if e < m and n_held == 0:
                    peak = 0                                   # a new episode starts
                n_held = n_held + 1 if e < m else (n_held - 1 if e < 2 * m else 0)
                if m <= e < 2 * m and n_held == 0:
                    epis += 1                                  # an episode is complete
                if e == 2 * m:
                    peak, epis = 0, 0
                peak = max(peak, n_held)
                prev = e
    programs = [t.program(rng_prog) for t in types]
    pc = [0] * n
    maxima = np.array([true_max(p, m) for p in programs])

    state = State(n, m)
    policy = make_policy(policy_name, models, cfg, rng_roll, maxima)
    if trace and hasattr(policy, 'detail'):
        policy.detail = True
    shadow_sage = make_policy('sage', models, cfg, rng_roll, shadow=True) if shadow else None

    queue = []                                  # waiting processes in arrival order
    pending_shift = [False] * n
    pers = [t.personality for t in types]
    names = [getattr(t, 'name', None) or 'P%d' % (i + 1) for i, t in enumerate(types)]

    R = dict(policy=policy_name, family=family, seed=seed, cfg=cfg,
             events=0, requests=0, blocked=0, free_requests=0, granted=0, policy_waits=0,
             fallback=0, reevals=0, forced=0, deadlocks=0, completed=0, restarts=0,
             slot_completed=[0] * n,  # completions per process slot (fairness / starvation)
             slot_aborts=[0] * n,     # times each slot was chosen as the deadlock victim
             slot_pred=[[0, 0] for _ in range(n)],   # (correct, total) next-event predictions per slot
             wasted=0,                # program steps undone by rollbacks
             decisions=[],            # (tick, i, r, decision, risk, path, latency_s, is_reeval)
             deadlock_log=[],         # (tick, cycle members, victim)
             flags=[],                # shadow mode: (tick, i, risk)
             shift_first={}, drift_flag={}, drift_recover={},
             pred={p: dict(total=0, correct=0, ll=0.0) for p in set(pers)},
             update_time=0.0, updates=0, event_log=[], pers=pers, names=names,
             trace=[] if trace else None,
             programs_log=[(0, i, list(programs[i])) for i in range(n)] if trace else None)
    cur = None                                  # the trace entry of the current tick

    def emit(i, e, tick):
        prev = state.last[i]
        held = state.alloc[i]                          # what the process holds before the event
        peak = int(state.peak[i])                      # episode peak before the event
        epis = int(state.epis[i])                      # episodes completed in this life before the event
        st = R['pred'][pers[i]]
        correct = int(models[i].predict(prev, held, peak, epis) == e)
        st['total'] += 1
        st['correct'] += correct
        st['ll'] += models[i].loglik(prev, e, held, peak, epis)
        R['slot_pred'][i][0] += correct
        R['slot_pred'][i][1] += 1
        if cur is not None:
            cur['correct'] = correct
        if family == 'shift':
            R['event_log'].append((tick, i, correct, i in R['shift_first']))
        t0 = perf_counter()
        n_held = int(held.sum()) + (1 if e < m else (-1 if e < 2 * m else -int(held.sum())))
        models[i].update(prev, e, n_held, peak, epis, held=held)
        if (e < m and not held.any()) or e == 2 * m:
            state.peak[i] = 0                          # a new episode starts (or the life ends)
        if m <= e < 2 * m and n_held == 0:
            state.epis[i] += 1                         # an episode is complete
        elif e == 2 * m:
            state.epis[i] = 0
        if hasattr(policy, 'observe'):                 # the drift monitor sees every event
            note(i, policy.observe(i), tick)
        R['update_time'] += perf_counter() - t0
        R['updates'] += 1
        state.last[i] = e

    def note(i, path, tick):
        if path == 'drift' and i in R['shift_first'] and i not in R['drift_flag']:
            R['drift_flag'][i] = tick
        if path == 'learned' and i in R['drift_flag'] and i not in R['drift_recover']:
            R['drift_recover'][i] = tick

    def decide(i, r, tick, reeval):
        t0 = perf_counter()
        d, risk, path = policy.decide(state, i, r)
        dt = perf_counter() - t0
        if shadow_sage is not None:
            sd, srisk, spath = shadow_sage.decide(state, i, r)
            if sd == WAIT:                                # SAGE would have queued this request
                R['flags'].append((tick, i, srisk))
        R['decisions'].append((tick, i, r, d, risk, path, dt, reeval))
        note(i, path, tick)
        if cur is not None:
            rec = dict(i=i, r=r, d=d, risk=risk, path=path, ms=dt * 1000.0)
            if path == 'learned' and getattr(policy, 'last_detail', None):
                rec['fut'] = policy.last_detail.get(i)
            if reeval:
                cur.setdefault('reevals', []).append(rec)
            else:
                cur['decision'] = rec
        return d, risk, path

    def grant(i, r):
        state.apply_grant(i, r)
        if i in queue:
            queue.remove(i)
        for j in queue:                              # other waiters for r are now blocked on a held resource
            if state.pending[j] == r:
                state.reason[j] = HELD
        if hasattr(policy, 'on_block'):               # timestamp schemes re-apply their rule to the new holder
            for j in [j for j in queue if state.pending[j] == r and state.holder(r) == i]:
                if state.status[j] == WAITING and state.pending[j] == r:
                    act = policy.on_block(state, j, r, i)
                    if act == 'die':
                        abort(j, state.now)
                    elif act == 'wound':
                        abort(i, state.now)
                        break

    def wake(tick):
        for j in list(queue):
            r = state.pending[j]
            if not state.avail[r]:
                continue
            d, risk, path = decide(j, r, tick, True)
            R['reevals'] += 1
            if d in (GRANT, FALLBACK):
                grant(j, r)
                pc[j] += 1
            else:
                state.reason[j] = POLICY

    def respawn(i):
        programs[i] = types[i].program(rng_prog)
        if R['programs_log'] is not None:
            R['programs_log'].append((state.now, i, list(programs[i])))
        state.born[i] = state.now                      # a new life gets a new timestamp
        pc[i] = 0
        state.last[i] = START
        state.status[i] = ACTIVE
        state.pending[i] = -1
        state.reason[i] = NONE
        policy.set_program_max(i, true_max(programs[i], m))

    def abort(i, tick):
        """Recovery: the victim releases everything and is rolled back (see the module docstring)."""
        state.release_all(i)
        state.status[i] = ACTIVE
        state.pending[i] = -1
        state.reason[i] = NONE
        state.since[i] = -1
        if i in queue:
            queue.remove(i)
        before = pc[i]
        if cfg['recovery'] == 'partial':
            pc[i], state.last[i], state.peak[i], state.epis[i] = checkpoint(programs[i], pc[i], m)
        else:
            pc[i], state.last[i], state.peak[i], state.epis[i] = 0, START, 0, 0
        R['wasted'] += before - pc[i]                  # program steps that will have to be redone
        R['restarts'] += 1
        R['slot_aborts'][i] += 1
        if cur is not None:
            cur.setdefault('aborts', []).append(dict(i=i, undone=before - pc[i]))
        wake(tick)

    def victim(cyc, closer):
        return min(cyc, key=lambda j: (R['slot_aborts'][j], j != closer))

    def snap():
        """Close the trace entry of this tick with the state after it."""
        cur['alloc'] = [int(sum(1 << r for r in np.flatnonzero(state.alloc[i]))) for i in range(n)]
        cur['status'] = state.status.tolist()
        cur['pending'] = state.pending.tolist()
        cur['reason'] = state.reason.tolist()
        cur['pc'] = list(pc)
        cur['queue'] = list(queue)
        cur['done'] = list(R['slot_completed'])
        R['trace'].append(cur)

    tick = 0
    stall_guard = 0
    resolve = getattr(policy, 'recovery', 'detect')    # 'detect': abort a victim at once; 'timeout'
    while tick < cfg['ticks']:
        state.now = tick
        if progress is not None and tick % 25 == 0:
            progress(tick, cfg['ticks'])
        if trace:
            cur = dict(t=tick)
        try:
            if resolve == 'timeout':                           # roll back processes blocked for too long
                for j in range(n):
                    if state.status[j] == WAITING and state.reason[j] == HELD and \
                            state.now - state.since[j] >= policy.timeout:
                        abort(j, tick)
            if family == 'shift' and tick == cfg['shift_tick']:
                for i in range(n):
                    if types[i].post_seq:
                        types[i].shifted = True
                        pending_shift[i] = True
            runnable = [i for i in range(n) if state.status[i] == ACTIVE]
            if not runnable:
                queued = [j for j in queue if state.reason[j] == POLICY]
                if queued:
                    j = policy.pick_forced(state, queued)
                    grant(j, state.pending[j])
                    pc[j] += 1
                    R['forced'] += 1
                    stall_guard += 1
                    if cur is not None:
                        cur.update(i=int(j), op=REQ, r=int(state.pending[j]) if state.pending[j] >= 0 else -1,
                                   out='forced', risk=getattr(policy, 'last_risk', {}).get(j))
                        cur['r'] = int(np.flatnonzero(state.alloc[j])[-1]) if state.alloc[j].any() else -1
                    if stall_guard > 10 * n:
                        break
                    continue
                g = state.wait_for()
                if resolve == 'timeout' and g:                     # all blocked: the longest wait times out first
                    v = min(g, key=lambda j: state.since[j])
                    abort(v, tick)
                    if cur is not None:
                        cur.update(i=int(v), op=-1, r=-1, out='timeout')
                    continue
                if has_cycle(g):                                   # cannot normally happen: cycles are caught on blocking
                    for i in range(n):
                        cyc = find_cycle(g, i)
                        if cyc:
                            v = victim(cyc, cyc[-1])
                            R['deadlocks'] += 1
                            R['deadlock_log'].append((tick, cyc, v))
                            if cur is not None:
                                cur.update(i=int(v), op=-1, r=-1, out='deadlock', dl=dict(cycle=[int(c) for c in cyc], victim=int(v)))
                            abort(v, tick)
                            break
                    continue
                cur = None
                break                                              # everything finished
            stall_guard = 0
            i = int(rng_sched.choice(runnable))
            if pending_shift[i] and not state.alloc[i].any():
                programs[i] = types[i].program(rng_prog)
                if R['programs_log'] is not None:
                    R['programs_log'].append((tick, i, list(programs[i])))
                pc[i] = 0
                pending_shift[i] = False
                R['shift_first'][i] = tick
                policy.set_program_max(i, true_max(programs[i], m))
            kind, r = programs[i][pc[i]]
            tick += 1
            state.now = tick
            R['events'] += 1
            if cur is not None:
                cur.update(t=tick, i=i, op=int(kind), r=int(r))
            if kind == REQ:
                R['requests'] += 1
                if state.alloc[i, r]:
                    pc[i] += 1
                    if cur is not None:
                        cur['out'] = 'held'
                    continue
                emit(i, r, tick)
                if not state.avail[r]:
                    R['blocked'] += 1
                    died = False
                    while not state.avail[r] and hasattr(policy, 'on_block'):
                        act = policy.on_block(state, i, r, state.holder(r))
                        if act == 'die':                           # the requester rolls back instead of waiting
                            abort(i, tick)
                            died = True
                            break
                        if act != 'wound':
                            break
                        abort(state.holder(r), tick)               # the holder is rolled back; check again
                    if died:
                        if cur is not None:
                            cur['out'] = 'die'
                        continue
                if not state.avail[r]:
                    state.wait(i, r, HELD)
                    queue.append(i)
                    g = state.wait_for()
                    cyc = find_cycle(g, i)
                    if cyc and i in cyc:
                        R['deadlocks'] += 1
                        if resolve == 'timeout':                   # counted, left to the timeout
                            R['deadlock_log'].append((tick, cyc, -1))
                            if cur is not None:
                                cur.update(out='deadlock', dl=dict(cycle=[int(c) for c in cyc], victim=-1))
                        else:
                            v = victim(cyc, i)
                            R['deadlock_log'].append((tick, cyc, v))
                            if cur is not None:
                                cur.update(out='deadlock', dl=dict(cycle=[int(c) for c in cyc], victim=int(v)))
                            abort(v, tick)
                    elif cur is not None:
                        cur['out'] = 'blocked'
                    continue
                R['free_requests'] += 1
                d, risk, path = decide(i, r, tick, False)
                if d == GRANT:
                    R['granted'] += 1
                    grant(i, r)
                    pc[i] += 1
                elif d == FALLBACK:
                    R['fallback'] += 1
                    grant(i, r)                                    # reactive rule: the resource is free
                    pc[i] += 1
                else:
                    R['policy_waits'] += 1
                    state.wait(i, r, POLICY)
                    queue.append(i)
                if cur is not None:
                    cur['out'] = 'grant' if d in (GRANT, FALLBACK) else 'wait'
                    cur['risk'] = risk
                    cur['path'] = path
            elif kind == REL:
                emit(i, m + r, tick)
                state.release(i, r)
                pc[i] += 1
                if cur is not None:
                    cur['out'] = 'release'
                wake(tick)
            else:
                emit(i, 2 * m, tick)
                state.release_all(i)
                R['completed'] += 1
                R['slot_completed'][i] += 1
                state.done_at[i] = tick
                if cur is not None:
                    cur['out'] = 'exit'
                respawn(i)
                wake(tick)
        finally:
            if cur is not None and 'out' in cur:
                snap()
            cur = None
    if progress is not None:
        progress(cfg['ticks'], cfg['ticks'])
    R['final_state'] = state
    R['models'] = models
    R['types'] = types
    R['ticks_run'] = tick
    return R
