"""Per-process behaviour models.

MarkovModel is the baseline: a first-order chain over the process's own events.
Every model exposes the same four operations (update, sample_next_batch, support,
window_loglik) so that the rollout engine and the SAGE policy do not depend on the
model type.

Predictions are conditioned on the resources the process currently holds (known to the
OS from the allocation matrix): a process cannot request a resource it already holds or
release one it does not hold, so those events are masked out and the transition row is
renormalised over the feasible events.

The model also keeps two context-aware tables, indexed by the last event and either
  - the *episode peak*: the most resources held since the process last held nothing, or
  - the *episode count*: how many holding episodes it has completed in its current life.
They tell apart situations a first-order chain confuses: whether an escalating process
that has just released everything starts another level or exits, or whether a process
that repeats a cycle has reached its last one. A count row is used only once it is
unanimous over at least two observations, and every context row is blended with a
little of the plain row so that it is never overconfident. Each model keeps a prequential score of the
three tables and predicts with the plain table unless a context table has predicted this
process better by more than MARGIN nats, so near-random processes, for which extra
context only thins out the data, stay on the plain table.
"""
from collections import deque
import numpy as np

from .rag import n_events, start_state


def feasible_mask(held):
    """Feasible next events given the held vector(s) (..., m) -> (..., 2m + 1):
    request r iff r is not held, release r iff r is held, exit always."""
    held = np.asarray(held, dtype=bool)
    tail = np.ones(held.shape[:-1] + (1,), dtype=bool)
    return np.concatenate([~held, held, tail], axis=-1)


class MarkovModel:
    MARGIN = 0.0                      # nats a context table must gain before it is used
    MAX_COUNT = 16                    # episode counts at or above this share one context
    MIN_UNANIMOUS = 2                 # observations needed before a count row is trusted
    PRIOR = 2.0                       # weight of the plain row as a prior on every context row (observations)
    HIT_MARGIN = 2                    # extra next-event hits a context table needs before it is used
    DRIFT_K = 1.0                     # CUSUM allowance: surprise (nats) per event regarded as normal
    DRIFT_START = 20                  # transitions seen before the CUSUM starts (cold start is all surprise)

    def __init__(self, m, window=10, floor=1e-3):
        self.m = m
        self.E = n_events(m)          # possible next events
        self.S = start_state(m) + 1   # states = events + START
        self.counts = np.zeros((self.S, self.E), dtype=np.float64)
        self.recent = deque(maxlen=window)
        self.floor = floor
        self.max_held = 0             # most resources the process was seen holding at once
        self.cusum = 0.0              # CUSUM of surprise above DRIFT_K: grows when the behaviour changes
        self.ctx = np.zeros((self.S, m + 1, self.E), dtype=np.float64)   # (last event, episode peak) -> next
        self.ctxn = np.zeros((self.S, self.MAX_COUNT, self.E), dtype=np.float64)   # (last event, episode count)
        self.score = np.zeros(3)      # prequential log-likelihood: plain, peak and count table
        self.hits = np.zeros(3)       # prequential next-event hits (most likely event was right), same order
        self._probs = None
        self._probs_ctx = None
        self._probs_ctxn = None
        self._fit = None

    # -- learning ---------------------------------------------------------
    def update(self, prev_event, next_event, n_held=None, peak=None, count=None):
        # the surprise of the event under the model *before* it is learned (prequential
        # log-likelihood). It is scored without the held-set mask: an event that was the only
        # feasible one carries no evidence about the behaviour and would dilute the drift window.
        self.recent.append(self.loglik(prev_event, next_event))
        if self.counts.sum() >= self.DRIFT_START:    # surprise under the table in use, before learning; an
            ll = self.loglik(prev_event, next_event, None, peak, count)   # unseen state scores the floor
            self.cusum = max(0.0, self.cusum - ll - self.DRIFT_K)
        if n_held is not None:          # resources held after the event, as the request log shows
            self.max_held = max(self.max_held, n_held)
        if peak is not None and count is not None:
            count = min(count, self.MAX_COUNT - 1)
            plain = self._p(self.counts[prev_event], next_event)
            self.score[0] += np.log(plain)
            prow = self.counts[prev_event]
            rows = [prow, self._smooth(self.ctx[prev_event, peak], prow) if self.ctx[prev_event, peak].sum() > 0 else prow,
                    self._smooth(self.ctxn[prev_event, count], prow) if self.ctxn[prev_event, count].sum() > 0 else prow]
            for k, row in enumerate(rows):
                if k:
                    self.score[k] += np.log(self._p(row, next_event))
                self.hits[k] += row.sum() > 0 and int(row.argmax()) == next_event
            self.ctx[prev_event, peak, next_event] += 1.0
            self.ctxn[prev_event, count, next_event] += 1.0
            self._probs_ctx = self._probs_ctxn = None
        self.counts[prev_event, next_event] += 1.0
        self._probs = self._fit = None

    def _p(self, row, e):
        tot = row.sum()
        return max(row[e] / tot if tot > 0 else 0.0, self.floor)

    def _smooth(self, ctx_row, plain_row):
        """Context row with the normalised plain row as a Dirichlet prior worth PRIOR observations."""
        p = plain_row / max(plain_row.sum(), 1e-12)
        return (ctx_row + self.PRIOR * p) / (ctx_row.sum() + self.PRIOR)

    def _unanimous(self, row):
        tot = row.sum()
        return tot >= self.MIN_UNANIMOUS and row.max() == tot

    @property
    def variant(self):
        """Table in use: 0 plain, 1 episode peak, 2 episode count. A context table is used only if it
        has so far beaten the plain table on both prequential log-likelihood and next-event hits;
        of two such tables the one with the higher log-likelihood is used."""
        ok = (self.score > self.score[0] + self.MARGIN) & (self.hits >= self.hits[0] + self.HIT_MARGIN)
        ok[0] = True
        return int(np.argmax(np.where(ok, self.score, -np.inf)))

    @property
    def use_context(self):
        return self.variant != 0

    # -- prediction -------------------------------------------------------
    def probs(self):
        """Row-normalised transition matrix; rows never seen stay all-zero."""
        if self._probs is None:
            tot = self.counts.sum(axis=1, keepdims=True)
            with np.errstate(invalid='ignore', divide='ignore'):
                self._probs = np.where(tot > 0, self.counts / np.maximum(tot, 1e-12), 0.0)
        return self._probs

    def probs_ctx(self):
        """Normalised context table (S, m + 1, E); rows never seen stay all-zero."""
        if self._probs_ctx is None:
            tot = self.ctx.sum(axis=2, keepdims=True)
            self._probs_ctx = np.where(tot > 0, (self.ctx + self.PRIOR * self.probs()[:, None, :]) / (tot + self.PRIOR), 0.0)
        return self._probs_ctx

    def probs_ctxn(self):
        """Normalised (smoothed) count table (S, MAX_COUNT, E); rows never seen stay all-zero."""
        if self._probs_ctxn is None:
            tot = self.ctxn.sum(axis=2, keepdims=True)
            self._probs_ctxn = np.where(tot > 0, (self.ctxn + self.PRIOR * self.probs()[:, None, :]) / (tot + self.PRIOR), 0.0)
        return self._probs_ctxn

    def _row(self, state, held, peak=None, count=None):
        row = self.counts[state]
        v = self.variant if peak is not None and count is not None else 0
        if v == 1 and self.ctx[state, peak].sum() > 0:
            row = self._smooth(self.ctx[state, peak], row)
        elif v == 2 and self.ctxn[state, min(count, self.MAX_COUNT - 1)].sum() > 0:
            row = self._smooth(self.ctxn[state, min(count, self.MAX_COUNT - 1)], row)
        if held is not None:
            row = row * feasible_mask(held)
        return row

    def prob(self, prev_event, next_event, held=None, peak=None, count=None):
        row = self._row(prev_event, held, peak, count)
        tot = row.sum()
        return row[next_event] / tot if tot > 0 else 0.0

    def predict(self, state, held=None, peak=None, count=None):
        """Most likely feasible next event, or -1 if the state has never been seen."""
        row = self._row(state, held, peak, count)
        return int(row.argmax()) if row.sum() > 0 else -1

    def sample_next_batch(self, states, rng, held=None):
        """Sample one next event for each entry of `states` (vector). `held` (k, m), if
        given, restricts each sample to the feasible events. -1 where no event is known."""
        rows = self.probs()[states]                   # (k, E)
        if held is not None:
            rows = rows * feasible_mask(held)
        tot = rows.sum(axis=1)
        out = np.full(len(states), -1, dtype=np.int64)
        has = tot > 0
        if has.any():
            cum = np.cumsum(rows[has], axis=1)
            u = rng.random(has.sum()) * cum[:, -1]
            e = (cum < u[:, None]).sum(axis=1)
            out[has] = np.minimum(e, self.E - 1)
        return out

    def sample_next(self, state, rng, held=None):
        return int(self.sample_next_batch(np.array([state]), rng,
                                          None if held is None else np.asarray(held)[None])[0])

    # -- confidence -------------------------------------------------------
    def support(self):
        """Total observed transitions; used by the cold-start check."""
        return float(self.counts.sum())

    def loglik(self, prev_event, next_event, held=None, peak=None, count=None):
        return float(np.log(max(self.prob(prev_event, next_event, held, peak, count), self.floor)))

    def window_loglik(self):
        """Average prequential log P(next | prev) over the recent window; used by the drift check."""
        if not self.recent:
            return 0.0
        return float(np.mean(self.recent))

    def fit_loglik(self):
        """Average log-likelihood of the observed transitions under the fitted chain, i.e. minus
        its conditional entropy: about 0 for a process that always does the same thing, and
        strongly negative for one whose next event is close to random."""
        if self._fit is None:
            tot = self.counts.sum()
            if tot == 0:
                return 0.0
            with np.errstate(divide='ignore', invalid='ignore'):
                lp = np.where(self.counts > 0, np.log(np.maximum(self.probs(), 1e-300)), 0.0)
            self._fit = float((self.counts * lp).sum() / tot)
        return self._fit
