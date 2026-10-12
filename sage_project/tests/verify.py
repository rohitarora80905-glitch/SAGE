"""Verification cases with known answers. Run: python3 tests/verify.py"""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sagesim.rag import State, has_cycle, HELD, POLICY, WAITING, start_state
from sagesim.bankers import is_safe, BankersPolicy
from sagesim.behaviour_model import MarkovModel
from sagesim.rollout import rollout_risk
from sagesim.sage import SagePolicy
from sagesim.reactive import GRANT, WAIT
from sagesim.harness import run, CONFIG, checkpoint
from sagesim.rag import REQ, REL, EXIT

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print('%-58s %s %s' % (name, 'PASS' if ok else 'FAIL', detail))


# ---------------------------------------------------------------- 1. printer-scanner scenario (Figure 1)
m = 2
prog1 = [0, 1, m + 1, m + 0, 2 * m]        # P1: req R1, req R2, rel R2, rel R1, exit  (R1 = printer = 0)
prog2 = [1, 0, m + 0, m + 1, 2 * m]        # P2: req R2, req R1, rel R1, rel R2, exit

# reactive DFS: cycle appears on the second blocked request
st = State(2, m)
st.apply_grant(0, 0)                       # P1 holds R1
st.apply_grant(1, 1)                       # P2 holds R2
st.status[0], st.pending[0], st.reason[0] = WAITING, 1, HELD     # P1 requests R2 -> blocked
first = has_cycle(st.wait_for())
st.status[1], st.pending[1], st.reason[1] = WAITING, 0, HELD     # P2 requests R1 -> blocked
second = has_cycle(st.wait_for())
check('1a reactive DFS: no cycle after first block, cycle after second', (not first) and second)

# Banker's with truthful maxima refuses the request that would leave the state unsafe
st = State(2, m)
st.apply_grant(0, 0)
bank = BankersPolicy(np.array([[1, 1], [1, 1]]))
d, _, _ = bank.decide(st, 1, 1)
check("1b Banker's (truthful maxima) refuses P2's request for R2", d == WAIT)

# SAGE with enough history gives P2's request a high risk score
models = [MarkovModel(m), MarkovModel(m)]
for mdl, prog in ((models[0], prog1), (models[1], prog2)):
    for _ in range(6):                     # six earlier lives -> support >= h_min
        prev = start_state(m)
        for e in prog:
            mdl.update(prev, e)
            prev = e
st = State(2, m)
st.apply_grant(0, 0)
st.last[0] = 0                             # P1's last event: request R1
st.last[1] = start_state(m)
risk = rollout_risk(st, 1, 1, models, K=100, H=10, rng=np.random.default_rng(1))
sage = SagePolicy(models, K=100, H=10, tau=0.10, h_min=20, rng=np.random.default_rng(1))
d, r, path = sage.decide(st, 1, 1)
check("1c SAGE assigns P2's request for R2 a high risk (%.2f) and queues it" % risk, risk >= 0.5 and d == WAIT and path == 'learned')

# ---------------------------------------------------------------- 2. textbook safety-check example (Silberschatz et al., deadlock chapter)
alloc = np.array([[0, 1, 0], [2, 0, 0], [3, 0, 2], [2, 1, 1], [0, 0, 2]])
maxi = np.array([[7, 5, 3], [3, 2, 2], [9, 0, 2], [2, 2, 2], [4, 3, 3]])
avail = np.array([3, 3, 2])
safe, seq = is_safe(avail, alloc, maxi)
work, ok = avail.copy(), safe and sorted(seq) == list(range(len(alloc)))
for p in seq:                              # every process in turn must fit in what is free
    ok = ok and bool(np.all(maxi[p] - alloc[p] <= work))
    work = work + alloc[p]
check('2a textbook state is safe with valid sequence %s' % seq, ok)
# request by P1 for (1,0,2) can be granted
a2 = alloc.copy(); a2[1] += [1, 0, 2]
check("2b P1's request (1,0,2) leaves a safe state", is_safe(avail - [1, 0, 2], a2, maxi)[0])
# after that grant, a request by P0 for (0,2,0) cannot be granted: the resulting state is unsafe
a3 = a2.copy(); a3[0] += [0, 2, 0]
check("2c P0's request (0,2,0) would then leave an unsafe state", not is_safe(avail - [1, 0, 2] - [0, 2, 0], a3, maxi)[0])

# ---------------------------------------------------------------- 3. determinism
A = run('sage', 'mixed', 0, ticks=300)
B = run('sage', 'mixed', 0, ticks=300)
same = [d[:6] for d in A['decisions']] == [d[:6] for d in B['decisions']] and A['deadlock_log'] == B['deadlock_log']
check('3  two runs with the same seed and configuration are identical', same)

# ---------------------------------------------------------------- 4. degenerate thresholds (simulation gate alone:
#                                                                   reactive fallback, starvation guard off)
R = run('sage', 'mixed', 0, ticks=400, tau=1.01, aging=0, fallback='reactive')
check('4a tau above 100%%: SAGE never queues (waits = %d)' % R['policy_waits'], R['policy_waits'] == 0)
R = run('sage', 'mixed', 0, ticks=400, tau=0.0, aging=0, fallback='reactive')
learned = sum(1 for d in R['decisions'] if d[5] == 'learned')
waits = sum(1 for d in R['decisions'] if d[3] == 'wait')
check('4b tau = 0: every learned-path decision is a queue (%d of %d)' % (waits, learned), learned > 0 and waits == learned)


def trained(progs, m, lives=6):
    """Markov models that have seen `lives` earlier lives of each program."""
    out = []
    for prog in progs:
        mdl = MarkovModel(m)
        for _ in range(lives):
            prev, n_held = start_state(m), 0
            for e in prog:
                n_held = n_held + 1 if e < m else (n_held - 1 if e < 2 * m else 0)
                mdl.update(prev, e, n_held)
                prev = e
        out.append(mdl)
    return out


# ---------------------------------------------------------------- 5. behaviour model conditioned on what is held
m = 2
mdl = MarkovModel(m)
for _ in range(5):
    mdl.update(start_state(m), m + 0)      # from START the process usually releases R1 ...
mdl.update(start_state(m), 1)              # ... and sometimes requests R2
p_free = mdl.predict(start_state(m), held=np.array([False, False]))
p_held = mdl.predict(start_state(m), held=np.array([True, False]))
check('5  prediction never releases a resource that is not held (%d, %d)' % (p_free, p_held),
      p_free == 1 and p_held == m + 0)

# ---------------------------------------------------------------- 6. confidence check: random is not drift, a real shift is
R = run('sage', 'bursty', 0, ticks=600)
paths = [d[5] for d in R['decisions'] if not d[7]]
check('6a stationary bursty processes fall back as uncertain, not drift (%d drift of %d)'
      % (paths.count('drift'), len(paths)),
      paths.count('uncertain') > 0.8 * len(paths) and paths.count('drift') < 0.1 * len(paths))
R = run('sage', 'shift', 0)
check('6b every shifted process is flagged as drifted (%d of %d)' % (len(R['drift_flag']), len(R['shift_first'])),
      len(R['shift_first']) > 0 and set(R['drift_flag']) == set(R['shift_first']))

# ---------------------------------------------------------------- 7. rollout: what counts against a grant
m = 3                                      # R1 = 0, R2 = 1, R3 = 2
progs = [[2, 0, m + 0, m + 2, 2 * m],      # P0: req R3, req R1, rel R1, rel R3, exit
         [0, 1, m + 1, m + 0, 2 * m],      # P1: req R1, req R2, ...
         [1, 0, m + 0, m + 1, 2 * m]]      # P2: req R2, req R1, ...  (opposite order to P1)
models = trained(progs, m)
st = State(3, m)
st.apply_grant(1, 0); st.last[1] = 0       # P1 holds R1
st.apply_grant(2, 1); st.last[2] = 1       # P2 holds R2: P1 and P2 are about to deadlock
own = rollout_risk(st, 0, 2, models, K=100, H=15, rng=np.random.default_rng(2))
anyd = rollout_risk(st, 0, 2, models, K=100, H=15, rng=np.random.default_rng(2), involve_requester=False)
check('7a P0 blocked behind the P1-P2 deadlock is not charged with it (%.2f; any deadlock %.2f)' % (own, anyd),
      own == 0.0 and anyd >= 0.9)
# a conflicting request already queued by the policy stays queued in the sandbox
progs = [[0, 1, m + 1, m + 0, 2 * m], [1, 0, m + 0, m + 1, 2 * m], [2, m + 2, 2 * m]]
models = trained(progs, m)
st = State(3, m)
free_risk = rollout_risk(st, 0, 0, models, K=100, H=15, rng=np.random.default_rng(3))
st.status[1], st.pending[1], st.reason[1] = WAITING, 1, POLICY
queued_risk = rollout_risk(st, 0, 0, models, K=100, H=15, rng=np.random.default_rng(3))
check('7b a queued conflicting request does not count against the next one (%.2f -> %.2f)' % (free_risk, queued_risk),
      free_risk > 0.2 and queued_risk == 0.0)

# ---------------------------------------------------------------- 8. starvation guard
sage = SagePolicy(models, K=50, H=10, aging=200, rng=np.random.default_rng(4))
st = State(3, m)
st.apply_grant(2, 2)
st.status[1], st.pending[1], st.reason[1], st.since[1] = WAITING, 2, HELD, 0
st.now = 250                               # P1 has been waiting for 250 ticks
d0, _, p0 = sage.decide(st, 0, 0)          # P0 holds nothing: held back
st.apply_grant(0, 1)
d1, _, p1 = sage.decide(st, 0, 0)          # P0 holds R2: runs on
check('8  while a request is overdue, idle processes wait and holders run on (%s/%s, %s/%s)' % (d0, p0, d1, p1),
      d0 == WAIT and p0 == 'drain' and p1 != 'drain')

# ---------------------------------------------------------------- 9. fallback: safety check with learned claims
m = 2                                      # printer-scanner pair again, now on the fallback route
models = trained([[0, 1, m + 1, m + 0, 2 * m], [1, 0, m + 0, m + 1, 2 * m]], m)
sage = SagePolicy(models, rng=np.random.default_rng(5))
st = State(2, m)
check("9a learned claims: P2's request for R2 is safe while P1 holds nothing", sage.safe_with_claims(st, 1, 1))
st.apply_grant(0, 0)
check("9b learned claims: once P1 holds R1, P2's request for R2 is unsafe", not sage.safe_with_claims(st, 1, 1))
models = trained([[0, m + 0, 1, m + 1, 2 * m], [1, 0, m + 0, m + 1, 2 * m]], m)   # P1 never holds two at once
sage = SagePolicy(models, rng=np.random.default_rng(5))
st = State(2, m)
st.apply_grant(0, 0)
check('9c P1 was never seen holding two resources (limit %d), so it releases R1 before asking for R2: '
      "P2's request for R2 is safe" % models[0].max_held,
      models[0].max_held == 1 and sage.safe_with_claims(st, 1, 1))

# ---------------------------------------------------------------- 10a. context table (episode peak)
m = 2                                      # escalating process: level 1 = {R1}, level 2 = {R1, R2}, then exit
prog = [0, m + 0, 0, 1, m + 1, m + 0, 2 * m]
mdl = MarkovModel(m)
for _ in range(6):
    prev, n_held, peak, epis = start_state(m), 0, 0, 0
    for e in prog:
        mdl.update(prev, e, n_held + 1 if e < m else (n_held - 1 if e < 2 * m else 0), peak, epis)
        if e < m and n_held == 0:
            peak = 0
        n_held = n_held + 1 if e < m else (n_held - 1 if e < 2 * m else 0)
        if m <= e < 2 * m and n_held == 0:
            epis += 1
        if e == 2 * m:
            peak, epis = 0, 0
        peak = max(peak, n_held)
        prev = e
none = np.zeros(m, dtype=bool)
after1, after2 = mdl.predict(m + 0, none, 1, 1), mdl.predict(m + 0, none, 2, 2)
check('10a after releasing everything, the context tells another level (%d) from the exit (%d); '
      'table in use: %d' % (after1, after2, mdl.variant),
      after1 == 0 and after2 == 2 * m and mdl.variant != 0)

# ---------------------------------------------------------------- 10. partial rollback
prog = [(REQ, 0), (REQ, 1), (REL, 1), (REL, 0), (REQ, 0), (REQ, 1), (REL, 1), (REL, 0), (EXIT, -1)]
points = [checkpoint(prog, u, 2) for u in (3, 6)]
check('10 a victim is rolled back to the last point at which it held nothing %s' % [q[:2] for q in points],
      [q[:2] for q in points] == [(0, start_state(2)), (4, 2 + 0)] and points[1][3] == 1)

# ---------------------------------------------------------------- 11. shadow mode reports what SAGE would have queued
R = run('reactive', 'bursty', 0, ticks=600, shadow=True)
check('11 shadow mode warns about bursty processes through the fallback route (%d warnings, %d queued)'
      % (len(R['flags']), R['policy_waits']), len(R['flags']) > 0 and R['policy_waits'] == 0)

# ---------------------------------------------------------------- 12. classic baselines
from sagesim.baselines import WaitDiePolicy, WoundWaitPolicy
st = State(2, 2)
st.born[:] = [0, 10]                       # P1 is older than P2
check('12a wait-die: the older process waits, the younger one dies',
      WaitDiePolicy().on_block(st, 0, 0, 1) == 'wait' and WaitDiePolicy().on_block(st, 1, 0, 0) == 'die')
check('12b wound-wait: the older process wounds the holder, the younger one waits',
      WoundWaitPolicy().on_block(st, 0, 0, 1) == 'wound' and WoundWaitPolicy().on_block(st, 1, 0, 0) == 'wait')
dl = {p: sum(run(p, f, 0, ticks=600)['deadlocks'] for f in ('fixed', 'bursty', 'escalating', 'mixed'))
      for p in ('wait_die', 'wound_wait', 'bankers_nodecl')}
check('12c wait-die, wound-wait and Banker\'s without declared demand never deadlock %s' % dl,
      all(v == 0 for v in dl.values()))
R = run('timeout', 'fixed', 1, ticks=600)
check('12d timeout: deadlocks are counted but left to the timeout (%d deadlocks, %d rollbacks)'
      % (R['deadlocks'], R['restarts']),
      R['deadlocks'] > 0 and all(v == -1 for _, _, v in R['deadlock_log']) and R['restarts'] >= R['deadlocks'])

print('\n%d of %d checks passed' % (sum(ok for _, ok in results), len(results)))
sys.exit(0 if all(ok for _, ok in results) else 1)
