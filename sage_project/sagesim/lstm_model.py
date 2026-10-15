"""LSTM behaviour model: a small recurrent network over each process's own request log.

The model keeps every structure of the Markov model (counts, context tables, learned
limit, CUSUM drift monitor, prequential scores) and adds a recurrent network that reads
the whole history of the process - every event, what it held after each one, its episode
peak and its episode count - and predicts the next event from that history. Where the
Markov chain conditions on the last event (and at most one context index), the network
conditions on everything the process has done, so it can tell apart situations that a
chain confuses: which cycle of a repeated pattern a process is on, which level of an
escalation it has reached, what it asked for earlier in the episode.

The network is trained online, prequentially, from the stream of events it later has to
predict, exactly as the chain is counted: nothing is declared and nothing is trained off
line. Every event is first scored (so the score is an honest held-out score), then learned.
An Adam step of truncated back-propagation through time runs every `train_every` events on
the most recent window of the log, plus a replayed earlier window once the log is long.

Gate. The network is only *used* once it has predicted this process better than the
Markov tables, on a decayed prequential log-likelihood and on next-event hits, with at least
MIN_SUPPORT transitions seen. Until then every prediction comes from the Markov tables, so
the combined model is never worse than the chain for long. The gate is re-evaluated after
every event, so a network that falls behind (after a behaviour change, say) hands the
process back to the tables.

Interface. `update`, `predict`, `prob`, `loglik`, `sample_next_batch`, `support`,
`window_loglik`, `fit_loglik`, `probs`, `variant`, `ctx`, `ctxn`, `counts`, `max_held` and
`cusum` behave exactly as on MarkovModel, so the rollout engine and the SAGE policy run
unchanged. `probs()` is the table the rollout samples from: (S, E), one row per state
(last event). When the network is in use the table is *conditioned on the history*: the
row of the process's actual state is the network's prediction, and the row of every other
state s is the prediction after one hypothetical step s from the current hidden state, so
the first simulated event of every process in the sandbox is the network's own forecast.
"""
import numpy as np

from .behaviour_model import MarkovModel, feasible_mask
from .rag import start_state

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    HAVE_TORCH = True
except ImportError:                      # the Markov model keeps working without torch
    HAVE_TORCH = False

_THREADS_SET = False


def _single_thread():
    """Tiny networks run fastest, and deterministically, on one thread."""
    global _THREADS_SET
    if HAVE_TORCH and not _THREADS_SET:
        try:
            torch.set_num_threads(1)
        except RuntimeError:
            pass
        _THREADS_SET = True


if HAVE_TORCH:
    class _Net(nn.Module):
        def __init__(self, n_in, hidden, n_out):
            super().__init__()
            self.inp = nn.Linear(n_in, hidden)
            self.lstm = nn.LSTM(hidden, hidden, batch_first=True)
            self.out = nn.Linear(hidden, n_out)

        def forward(self, x, hc=None):
            h, hc = self.lstm(torch.tanh(self.inp(x)), hc)
            return self.out(h), hc


class LSTMModel(MarkovModel):
    MIN_SUPPORT = 40                 # transitions seen before the network may take over
    GATE_MARGIN = 0.5                # nats (decayed sum) the network must gain over the tables
    DECAY = 0.985                    # decay of the prequential gate scores (half-life ~ 46 events)
    MAX_HIST = 768                   # events of history kept for training
    WARM_EVENTS = 256                # events during which training runs four times as often

    def __init__(self, m, window=10, floor=1e-3, hidden=48, lr=1e-2, train_every=8, bptt=96,
                 steps=1, seed=0, enabled=True):
        super().__init__(m, window=window, floor=floor)
        self.enabled = bool(enabled and HAVE_TORCH)
        self.hidden, self.lr, self.train_every, self.bptt, self.steps = hidden, lr, train_every, bptt, steps
        self.n_in = self.S + m + (m + 1) + self.MAX_COUNT       # event, held, episode peak, episode count
        self.held = np.zeros(m, dtype=bool)                     # what the process holds, from its own log
        self.h_peak = 0
        self.h_epis = 0
        self.last_input = start_state(m)                        # the event the last input encoded
        self.xs, self.ys, self.ms = [], [], []                  # inputs, targets (-1: none), feasibility masks
        self.n_seen = 0
        self.gate_lstm = 0.0                                    # decayed prequential log-likelihood, network
        self.gate_ref = 0.0                                     # same for the Markov tables
        self.hits_lstm = 0.0
        self.hits_ref = 0.0
        self.lstm_ll_total = 0.0                                # undecayed totals, for reporting
        self.ref_ll_total = 0.0
        self.scored = 0
        self.train_loss = float('nan')
        self.train_steps = 0
        self.use_lstm = False
        self.switches = 0                                       # times the gate changed its mind
        self._table = None
        if self.enabled:
            _single_thread()
            self.gen = torch.Generator().manual_seed(int(seed))
            torch.manual_seed(int(seed))
            self.net = _Net(self.n_in, hidden, self.E)
            self.opt = torch.optim.Adam(self.net.parameters(), lr=lr)
            self._hc = None
            x0 = self._feat(self.last_input, self.held, 0, 0)
            self.xs.append(x0)
            with torch.no_grad():
                out, self._hc = self.net(torch.from_numpy(x0)[None, None], None)
                self._logits = out[0, 0]

    # -- features ------------------------------------------------------------
    def _feat(self, event, held, peak, epis):
        x = np.zeros(self.n_in, dtype=np.float32)
        x[event] = 1.0
        x[self.S:self.S + self.m] = held
        x[self.S + self.m + min(int(peak), self.m)] = 1.0
        x[self.S + 2 * self.m + 1 + min(int(epis), self.MAX_COUNT - 1)] = 1.0
        return x

    def _after(self, event, held, peak, epis):
        """Holdings, episode peak and episode count after `event` (same rules as the harness)."""
        held = held.copy()
        m = self.m
        if event < m:
            if not held.any():
                peak = 0
            held[event] = True
        elif event < 2 * m:
            held[event - m] = False
            if not held.any():
                epis += 1
        else:
            held[:] = False
            peak, epis = 0, 0
        peak = max(peak, int(held.sum()))
        return held, peak, epis

    # -- the network's distribution -----------------------------------------
    def _lstm_row(self, held=None):
        """Network prediction for the process's actual state, masked by what it holds."""
        mask = feasible_mask(self.held if held is None else held)
        logits = self._logits.numpy().astype(np.float64)
        logits = np.where(mask, logits, -1e9)
        logits = logits - logits.max()
        p = np.exp(logits) * mask
        return p / max(p.sum(), 1e-12)

    def _gate(self):
        if not self.enabled or self.support() < self.MIN_SUPPORT or self.scored < self.MIN_SUPPORT:
            return False
        return self.gate_lstm > self.gate_ref + self.GATE_MARGIN and self.hits_lstm >= self.hits_ref

    def _markov_row(self, state, held, peak=None, count=None):
        """The row the Markov tables would use (their own variant, whether or not the network is in use)."""
        row = self.counts[state]
        v = MarkovModel.variant.fget(self) if peak is not None and count is not None else 0
        if v == 1 and self.ctx[state, peak].sum() > 0:
            row = self._smooth(self.ctx[state, peak], row)
        elif v == 2 and self.ctxn[state, min(count, self.MAX_COUNT - 1)].sum() > 0:
            row = self._smooth(self.ctxn[state, min(count, self.MAX_COUNT - 1)], row)
        if held is not None:
            row = row * feasible_mask(held)
        return row

    @property
    def engine(self):
        """'lstm' when the network is in use, otherwise the Markov table in use."""
        if self.use_lstm:
            return 'lstm'
        return ('markov', 'markov+peak', 'markov+count')[MarkovModel.variant.fget(self)]

    @property
    def variant(self):
        return 0 if self.use_lstm else MarkovModel.variant.fget(self)

    # -- learning --------------------------------------------------------------
    def update(self, prev_event, next_event, n_held=None, peak=None, count=None, held=None):
        if not self.enabled:
            return super().update(prev_event, next_event, n_held, peak, count)
        m = self.m
        if held is not None:
            self.held = np.asarray(held, dtype=bool).copy()          # resync with the live state
        if prev_event != self.last_input:
            # the process is not where the log left it (a rollback replays part of the program):
            # start a fresh input at its actual state, with no target for the step before it
            if peak is not None:
                self.h_peak = int(peak)
            if count is not None:
                self.h_epis = int(count)
            self.xs.append(self._feat(prev_event, self.held, self.h_peak, self.h_epis))
            self.ys.append(-1)
            self.ms.append(np.ones(self.E, dtype=bool))
            self.last_input = prev_event
            self._step(self.xs[-1])
        # 1. score the event under both predictors before anything learns from it
        mask = feasible_mask(self.held)
        lrow = self._lstm_row()
        p_l = lrow[next_event]
        row = self._markov_row(prev_event, self.held, peak, count)
        tot = row.sum()
        p_r = row[next_event] / tot if tot > 0 else 0.0
        ll_l, ll_r = np.log(max(p_l, self.floor)), np.log(max(p_r, self.floor))
        self.gate_lstm = self.DECAY * self.gate_lstm + ll_l
        self.gate_ref = self.DECAY * self.gate_ref + ll_r
        self.hits_lstm = self.DECAY * self.hits_lstm + float(int(lrow.argmax()) == next_event)
        self.hits_ref = self.DECAY * self.hits_ref + float(tot > 0 and int(row.argmax()) == next_event)
        self.lstm_ll_total += ll_l
        self.ref_ll_total += ll_r
        self.scored += 1
        # 2. the Markov structures (counts, context tables, CUSUM under the table in use)
        super().update(prev_event, next_event, n_held, peak, count)
        # 3. extend the log: target for the current input, then the next input
        self.ys.append(int(next_event))
        self.ms.append(mask)
        self.held, self.h_peak, self.h_epis = self._after(next_event, self.held, self.h_peak, self.h_epis)
        nxt = start_state(m) if next_event == 2 * m else next_event    # a new life begins at START
        self.xs.append(self._feat(nxt, self.held, self.h_peak, self.h_epis))
        self.last_input = nxt
        if len(self.xs) > self.MAX_HIST:
            cut = len(self.xs) - self.MAX_HIST
            del self.xs[:cut]
            del self.ys[:cut]
            del self.ms[:cut]
        self.n_seen += 1
        # 4. learn, then refresh the hidden state under the new weights
        # early on the network trains more often and harder, so that it catches up with the counts
        every = self.train_every if self.n_seen >= self.WARM_EVENTS else max(1, self.train_every // 4)
        if self.n_seen % every == 0 and len(self.ys) >= 8:
            self._train()
            self._recompute()
        else:
            self._step(self.xs[-1])
        before = self.use_lstm
        self.use_lstm = self._gate()
        if before != self.use_lstm:
            self.switches += 1
        self._table = None

    def _step(self, x):
        with torch.no_grad():
            out, self._hc = self.net(torch.from_numpy(x)[None, None], self._hc)
            self._logits = out[0, 0]

    def _recompute(self):
        """Hidden state over the recent history under the current weights."""
        n = min(len(self.xs), self.bptt)
        with torch.no_grad():
            x = torch.from_numpy(np.stack(self.xs[-n:]))[None]
            out, self._hc = self.net(x, None)
            self._logits = out[0, -1]

    def _train(self):
        L = len(self.ys)
        n = min(L, self.bptt)
        windows = [(L - n, L)]
        if L > self.bptt + 16:                                      # replay an earlier stretch as well
            s = int(torch.randint(0, L - self.bptt, (1,), generator=self.gen))
            windows.append((s, s + self.bptt))
        loss_val = self.train_loss
        for a, b in windows:
            x = torch.from_numpy(np.stack(self.xs[a:b]))[None]        # inputs x_a .. x_{b-1}
            y = torch.tensor(self.ys[a:b], dtype=torch.long)           # target of each input
            mk = torch.from_numpy(np.stack(self.ms[a:b]))
            keep = y >= 0
            if not bool(keep.any()):
                continue
            for _ in range(self.steps + (1 if self.n_seen < self.WARM_EVENTS else 0)):
                logits, _ = self.net(x, None)
                logits = logits[0].masked_fill(~mk, -1e9)
                loss = F.cross_entropy(logits[keep], y[keep])
                self.opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
                self.opt.step()
                loss_val = float(loss.detach())
        self.train_loss = loss_val
        self.train_steps += 1

    # -- prediction --------------------------------------------------------------
    def _row(self, state, held, peak=None, count=None):
        if not self.use_lstm:
            return self._markov_row(state, held, peak, count)
        row = self.probs()[state]
        if held is not None:
            row = row * feasible_mask(held)
        return row

    def markov_probs(self):
        return MarkovModel.probs(self)

    def probs(self):
        """(S, E) table for the rollout: history-conditioned when the network is in use."""
        if not self.use_lstm:
            return MarkovModel.probs(self)
        if self._table is None:
            S, m = self.S, self.m
            xs, masks = [], []
            for s in range(S):
                if s == self.last_input:
                    xs.append(None)
                    masks.append(feasible_mask(self.held))
                    continue
                if s == start_state(m) or s == 2 * m:
                    h, pk, ep = np.zeros(m, dtype=bool), 0, 0
                else:
                    h, pk, ep = self._after(s, self.held, self.h_peak, self.h_epis)
                xs.append(self._feat(s, h, pk, ep))
                masks.append(feasible_mask(h))
            idx = [s for s in range(S) if xs[s] is not None]
            table = np.zeros((S, self.E), dtype=np.float64)
            with torch.no_grad():
                x = torch.from_numpy(np.stack([xs[s] for s in idx]))[:, None, :]
                h0 = self._hc[0].expand(1, len(idx), self.hidden).contiguous()
                c0 = self._hc[1].expand(1, len(idx), self.hidden).contiguous()
                out, _ = self.net(x, (h0, c0))
                logits = out[:, 0, :].numpy().astype(np.float64)
            for k, s in enumerate(idx):
                lg = np.where(masks[s], logits[k], -1e9)
                lg = lg - lg.max()
                p = np.exp(lg) * masks[s]
                table[s] = p / max(p.sum(), 1e-12)
            table[self.last_input] = self._lstm_row()
            self._table = table
        return self._table

    def probs_ctx(self):
        if self._probs_ctx is None:
            tot = self.ctx.sum(axis=2, keepdims=True)
            self._probs_ctx = np.where(tot > 0, (self.ctx + self.PRIOR * self.markov_probs()[:, None, :]) / (tot + self.PRIOR), 0.0)
        return self._probs_ctx

    def probs_ctxn(self):
        if self._probs_ctxn is None:
            tot = self.ctxn.sum(axis=2, keepdims=True)
            self._probs_ctxn = np.where(tot > 0, (self.ctxn + self.PRIOR * self.markov_probs()[:, None, :]) / (tot + self.PRIOR), 0.0)
        return self._probs_ctxn

    def lstm_predict(self, held=None):
        """The network's own most likely next event for the actual state (bypasses the gate)."""
        if not self.enabled:
            return -1
        return int(np.argmax(self._lstm_row(held)))

    def lstm_prob(self, event, held=None):
        return float(self._lstm_row(held)[event]) if self.enabled else 0.0

    def status(self):
        """Diagnostics for dashboards."""
        return dict(engine=self.engine, use_lstm=bool(self.use_lstm), support=self.support(),
                    scored=self.scored, gate_lstm=self.gate_lstm, gate_ref=self.gate_ref,
                    hits_lstm=self.hits_lstm, hits_ref=self.hits_ref,
                    lstm_ll=self.lstm_ll_total / max(self.scored, 1), ref_ll=self.ref_ll_total / max(self.scored, 1),
                    train_loss=self.train_loss, train_steps=self.train_steps, history=len(self.ys),
                    switches=self.switches)
