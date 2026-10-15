"""SAGE decision rule: confidence check, sandboxed rollout, threshold gate, fallback.

A request for a free resource takes one of two routes:

  learned   - the requester's behaviour model is trusted: K futures are simulated and the
              request is queued when the share of futures in which the requester ends up on a
              wait-for cycle is at least tau.
  fallback  - the model is not trusted (cold, uncertain or drift): the request is granted
              only if the state stays safe with respect to *learned claims*, Banker's style.
              A process's claim is the set of resources it has ever been seen to request (read
              from its request log, nothing is declared); a process already holding as many
              resources as it was ever seen to hold at once is taken to release before it
              asks for more. With fallback='reactive' the request is simply granted.

A starvation guard and a stall handler keep every process making progress.
"""
import numpy as np

from .rag import WAITING
from .reactive import GRANT, WAIT, FALLBACK
from .rollout import rollout_risk
from .bankers import is_safe


class SagePolicy:
    name = 'sage'

    def __init__(self, models, K=100, H=20, tau=0.10, h_min=20, drift_h=8.0, min_ll=-1.0, aging=400,
                 life_aging=900, fallback='claims', rng=None, shadow=False):
        self.models = models
        self.K, self.H, self.tau = K, H, tau
        self.h_min, self.drift_h, self.min_ll = h_min, drift_h, min_ll
        self.aging = aging                         # ticks a request may wait before others are held back
        self.life_aging = life_aging               # ticks a waiting process may go without completing a life
        self.fallback = fallback                   # 'claims' (learned-claims safety check) or 'reactive'
        self.rng = rng if rng is not None else np.random.default_rng(0)
        self.shadow = shadow                       # score only, never intervene (lead-time replay)
        self.flagged_at = {}                       # process -> support when drift was flagged
        self.last_risk = {}
        self.detail = False                        # keep the per-future outcome of each rollout (tracing)
        self.last_detail = {}

    def confidence(self, i):
        """Returns 'learned', 'cold', 'uncertain' or 'drift'.

        cold      - fewer than h_min observed transitions.
        uncertain - the fitted model's average log-likelihood is below min_ll: the process is
                    close to random, so a rollout driven by its model is noise and the
                    decision is left to the fallback. Checked before drift, because the
                    prequential log-likelihood of such a process is always low and would
                    otherwise be mistaken for a change of behaviour.
        drift     - the model's CUSUM of surprise (see behaviour_model) exceeds drift_h: the
                    behaviour of a predictable process has changed. The flag clears after h_min
                    fresh transitions once the CUSUM has fallen back below 1."""
        mdl = self.models[i]
        if mdl.support() < self.h_min:
            return 'cold'
        if self.min_ll is not None and mdl.fit_loglik() < self.min_ll:
            return 'uncertain'
        if i in self.flagged_at:
            fresh = mdl.support() - self.flagged_at[i]
            if fresh >= self.h_min and mdl.cusum < 1.0:
                del self.flagged_at[i]              # resume the learned path
            else:
                return 'drift'
        if mdl.cusum > self.drift_h:
            self.flagged_at[i] = mdl.support()
            return 'drift'
        return 'learned'

    def observe(self, i):
        """Called after every event of process i: keeps the drift monitor current between decisions."""
        return self.confidence(i)

    def decide(self, state, i, r):
        """In shadow mode the decision is only reported (the harness never applies it)."""
        if not self.shadow and not state.alloc[i].any() and self.starving(state, i):
            return WAIT, None, 'drain'
        path = self.confidence(i)
        if path != 'learned':
            if self.fallback == 'claims':
                return (GRANT if self.safe_with_claims(state, i, r) else WAIT), None, path
            return FALLBACK, None, path            # the harness applies the reactive rule
        if self.detail:
            risk, dead, first = rollout_risk(state, i, r, self.models, self.K, self.H, self.rng,
                                             return_detail=True, stop_at=self.tau)
            steps = np.bincount(first[first >= 0], minlength=self.H).tolist() if dead.any() else [0] * self.H
            self.last_detail[i] = dict(K=self.K, H=self.H, dead=int(dead.sum()), steps=steps)
        else:
            risk = rollout_risk(state, i, r, self.models, self.K, self.H, self.rng, stop_at=self.tau)
        self.last_risk[i] = risk
        return (GRANT if risk < self.tau else WAIT), risk, path

    def claims(self, state):
        """Learned claims: every resource a process has been seen to request, plus what it holds."""
        seen = np.array([mdl.counts[:, :state.m].sum(axis=0) > 0 for mdl in self.models])
        return seen | state.alloc

    def safe_with_claims(self, state, i, r):
        """Banker's safety check of the state after granting r to i, with learned claims in place
        of declared maxima. A process holding as many resources as it was ever seen to hold at
        once (its learned limit) releases before it asks for more, so it needs nothing further."""
        claims = self.claims(state)
        claims[i, r] = True
        alloc = state.alloc.astype(np.int64)
        alloc[i, r] += 1
        avail = state.avail.astype(np.int64)
        avail[r] -= 1
        held = alloc.sum(axis=1)
        full = (held > 0) & (held >= np.array([mdl.max_held for mdl in self.models]))
        claims[full] = alloc[full] > 0
        return is_safe(avail, alloc, claims.astype(np.int64))[0]

    def starving(self, state, i):
        """Starvation guard (drain). True when another process is overdue (see `overdue`). Its
        request stays risky as long as the others keep starting new work, so while it waits, a
        process that holds nothing is not allowed to start: queuing such a process creates no
        hold-and-wait, and the processes that do hold resources run on and release them until
        the overdue request becomes safe to grant."""
        if not self.aging:
            return False
        old = self.overdue(state)
        old[i] = False
        return bool(old.any())

    def overdue(self, state):
        """Waiting processes that have waited `aging` ticks in one go, or have gone `life_aging`
        ticks without completing a life (a process that keeps being aborted and re-queued never
        waits long in one go, but it does not finish either)."""
        waiting = state.status == WAITING
        late = waiting & (state.since >= 0) & (state.now - state.since >= self.aging)
        if self.life_aging:
            late |= waiting & (state.now - state.done_at >= self.life_aging)
        return late

    def pick_forced(self, state, queued):
        """Stall handler: when every process is waiting, release the queued request with the
        lowest risk, re-scored on the current state (stored scores are stale by now). If some
        queued request is overdue, only the overdue ones are considered, so the stall handler
        cannot keep favouring the same process."""
        if self.aging:
            old = self.overdue(state)
            late = [j for j in queued if old[j]]
            if late:
                queued = late
        risks = {j: rollout_risk(state, j, int(state.pending[j]), self.models, self.K, self.H, self.rng)
                 for j in queued}
        self.last_risk.update(risks)
        return min(queued, key=lambda j: risks[j])

    def set_program_max(self, i, maximum):
        pass
