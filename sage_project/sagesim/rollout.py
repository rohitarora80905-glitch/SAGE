"""Sandboxed rollout: apply the hypothetical grant in K copies of the live state and roll
the processes forward for H steps by sampling their behaviour models.

A step mirrors one tick of the live system. First, every blocked process whose pending
resource is free acquires it (permissive sandbox rule: the live system wakes blocked
processes as soon as a release frees their resource). Requests that the policy has
already queued stay queued for the whole rollout: in the live system they are released
only through the same risk gate, so letting them through would score every queued
request as a threat to every other one and starve them all. Then, independently in each future,
one runnable process is drawn uniformly, as the live scheduler does, and it samples and
applies its next event. Sampling is restricted to the events the process can perform with
what it holds in that future (no request of a held resource, no release of one it does
not hold), and for a process whose model prefers a context table the row is taken from that
table at the process's current episode peak or episode count. A process that exits releases everything and is done for the rest of the
rollout: the horizon covers the current life of each process, and its next life starts
holding nothing, so it is not a consequence of the grant being scored.

All K futures are simulated in lock-step with NumPy arrays of shape (K, n, m), so a
decision costs roughly H small array operations rather than K * H Python-level steps.
A future whose outcome is settled (deadlocked, or the requester has finished its life)
is not simulated further, and the simulation stops when every future is settled. With
`stop_at` (the caller's threshold) it also stops as soon as the comparison of the risk with
that threshold can no longer change: enough futures have deadlocked to reach it, or even if
every unsettled future deadlocked the risk would stay below it. The decision is then the one
the full simulation would give; the returned risk is the share deadlocked so far.
After every step the futures with a waiting process are checked for deadlock, exactly as
the live system does with single-instance resources. A future counts as deadlocked when
the requesting process is on a cycle of the wait-for graph (`involve_requester=True`, the
default): being merely blocked behind a deadlock among other processes is not a
consequence of the grant. With `involve_requester=False` any deadlock counts, found with
the standard detection reduction (Silberschatz et al.).
"""
import numpy as np

from .rag import ACTIVE, WAITING, DONE, POLICY


def rollout_risk(state, i0, r0, models, K, H, rng, return_detail=False, involve_requester=True, stop_at=None):
    n, m = state.n, state.m
    E = 2 * m + 1
    ks = np.arange(K)

    alloc = np.broadcast_to(state.alloc, (K, n, m)).copy()
    avail = np.broadcast_to(state.avail, (K, m)).copy()
    status = np.broadcast_to(state.status, (K, n)).copy()
    pending = np.broadcast_to(state.pending, (K, n)).copy()
    last = np.broadcast_to(state.last, (K, n)).copy()
    peak = np.broadcast_to(state.peak, (K, n)).copy()               # episode peak of each process
    epis = np.broadcast_to(state.epis, (K, n)).copy()               # episodes completed in the current life

    # the hypothetical grant (the request itself is the requester's last event)
    if not state.alloc[i0].any():
        peak[:, i0] = 0                                              # the request starts a new episode
    alloc[:, i0, r0] = True
    avail[:, r0] = False
    status[:, i0] = ACTIVE
    pending[:, i0] = -1
    last[:, i0] = r0
    peak[:, i0] = np.maximum(peak[:, i0], int(state.alloc[i0].sum()) + 1)

    mover = ~((state.status == WAITING) & (state.reason == POLICY))   # queued requests stay queued
    mover[i0] = True

    P = np.stack([mdl.probs() for mdl in models])    # (n, S, E)
    variant = np.array([mdl.variant for mdl in models])            # 0 plain, 1 episode peak, 2 episode count
    PC = PN = None                                                   # context tables, built only where used
    if (variant == 1).any():
        PC = np.zeros((n,) + models[0].ctx.shape)                    # (n, S, m + 1, E)
        for j in np.flatnonzero(variant == 1):
            PC[j] = models[j].probs_ctx()
    if (variant == 2).any():
        PN = np.zeros((n,) + models[0].ctxn.shape)                   # (n, S, C, E)
        for j in np.flatnonzero(variant == 2):
            PN[j] = models[j].probs_ctxn()
    cmax = models[0].MAX_COUNT - 1
    track = PC is not None or PN is not None
    dead = np.zeros(K, dtype=bool)
    first_dead_step = np.full(K, -1, dtype=np.int64)
    # futures whose outcome is settled are not simulated further: a deadlock was found, or (when
    # only the requester's deadlocks count) the requester has finished its life
    live = np.ones(K, dtype=bool)
    waiting = status == WAITING
    feas = np.ones((K, E), dtype=bool)               # scratch buffer for the feasible-event mask

    for step in range(H):
        # blocked processes acquire their resource as soon as it is free (lowest index first)
        cand = waiting & mover
        if cand.any():
            kw, iw = np.nonzero(cand)                                    # row-major: lower index first
            rw = pending[kw, iw]
            ok = avail[kw, rw]
            if ok.any():
                kw, iw, rw = kw[ok], iw[ok], rw[ok]
                if len(kw) > 1 and (kw[1:] == kw[:-1]).any():            # one waiter per resource and future
                    _, first = np.unique(kw * m + rw, return_index=True)
                    kw, iw, rw = kw[first], iw[first], rw[first]
                alloc[kw, iw, rw] = True
                avail[kw, rw] = False
                status[kw, iw] = ACTIVE
                pending[kw, iw] = -1
                if track:
                    peak[kw, iw] = np.maximum(peak[kw, iw], alloc[kw, iw].sum(axis=1))
        # each live future runs one event of one of its runnable processes, drawn uniformly
        act = status == ACTIVE
        act &= live[:, None]
        cnt = act.sum(axis=1)
        ka = np.flatnonzero(cnt)
        if len(ka):
            target = (rng.random(len(ka)) * cnt[ka]).astype(np.int64)    # which runnable process
            ia = (np.cumsum(act[ka], axis=1) > target[:, None]).argmax(axis=1)
            la = last[ka, ia]
            rows = P[ia, la]                                             # (Ka, E)
            if PC is not None:                                           # context tables where preferred and known
                crow = PC[ia, la, peak[ka, ia]]
                pick = (variant[ia] == 1) & (crow.sum(axis=1) > 0)
                rows = np.where(pick[:, None], crow, rows)
            if PN is not None:
                nrow = PN[ia, la, np.minimum(epis[ka, ia], cmax)]
                pick = (variant[ia] == 2) & (nrow.sum(axis=1) > 0)
                rows = np.where(pick[:, None], nrow, rows)
            held = alloc[ka, ia]                                         # (Ka, m)
            f = feas[:len(ka)]
            np.logical_not(held, out=f[:, :m])
            f[:, m:2 * m] = held
            cum = np.cumsum(rows * f, axis=1)                            # feasible events only
            tot = cum[:, -1]
            if not (tot > 0).all():                                      # unknown state: the process idles
                has = tot > 0
                ka, ia, cum, tot, held = ka[has], ia[has], cum[has], tot[has], held[has]
            e = (cum < (rng.random(len(ka)) * tot)[:, None]).sum(axis=1)
            np.minimum(e, E - 1, out=e)
            # requests (never for a held resource: masked out above)
            isreq = e < m
            if isreq.any():
                kr, ir, rr = ka[isreq], ia[isreq], e[isreq]
                if track:
                    fresh = ~held[isreq].any(axis=1)                     # holding nothing: a new episode starts
                    peak[kr[fresh], ir[fresh]] = 0
                free = avail[kr, rr]
                kg, ig, rg = kr[free], ir[free], rr[free]
                alloc[kg, ig, rg] = True
                avail[kg, rg] = False
                blk = ~free
                status[kr[blk], ir[blk]] = WAITING
                pending[kr[blk], ir[blk]] = rr[blk]
                last[kr, ir] = rr
                if track:
                    peak[kg, ig] = np.maximum(peak[kg, ig], held[isreq][free].sum(axis=1) + 1)
            # releases (only of held resources)
            isrel = (e >= m) & (e < 2 * m)
            if isrel.any():
                kr, ir, rr = ka[isrel], ia[isrel], e[isrel] - m
                alloc[kr, ir, rr] = False
                avail[kr, rr] = True
                last[kr, ir] = rr + m
                if track:
                    done = held[isrel].sum(axis=1) == 1                  # the release empties the holdings
                    epis[kr[done], ir[done]] += 1
            # exits: release everything; the process is done for the rest of the rollout
            isexit = e == 2 * m
            if isexit.any():
                kx, ix = ka[isexit], ia[isexit]
                avail[kx] |= alloc[kx, ix, :]
                alloc[kx, ix, :] = False
                status[kx, ix] = DONE
                last[kx, ix] = 2 * m
                if track:
                    peak[kx, ix] = 0
                    epis[kx, ix] = 0
                if involve_requester:
                    live[kx[ix == i0]] = False                           # the requester finished: settled
        # deadlock check, only where it can change the outcome
        waiting = status == WAITING
        if involve_requester:
            check = live & waiting[:, i0]                                # the requester must be waiting
        else:
            check = live & waiting.any(axis=1)
        if check.any():
            kk = np.flatnonzero(check)
            if involve_requester:
                # follow the wait-for edges (waiter -> holder of its pending resource) from the requester;
                # a future is deadlocked when the walk comes back to the requester
                hit = []
                kc, cur = kk, np.full(len(kk), i0)
                for _ in range(n):
                    col = alloc[kc, :, pending[kc, cur]]                         # (L, n): who holds the awaited resource
                    nxt = col.argmax(axis=1)
                    held_by = col.any(axis=1)
                    back = held_by & (nxt == i0)
                    hit.append(kc[back])
                    go = held_by & ~back & waiting[kc, nxt]
                    if not go.any():
                        break
                    kc, cur = kc[go], nxt[go]
                dk = np.concatenate(hit)
                dead[dk] = True
                live[dk] = False
                first_dead_step[dk] = step
            else:
                wk = waiting[kk]                                                  # (Kw, n)
                al = alloc[kk]                                                    # (Kw, n, m)
                pend = np.maximum(pending[kk], 0)
                work = avail[kk] | (al & ~wk[:, :, None]).any(axis=1)         # non-waiting processes finish first
                finish = ~wk
                for _ in range(n):
                    can = np.take_along_axis(work, pend, axis=1) & ~finish & wk
                    if not can.any():
                        break
                    finish |= can
                    work |= (al & can[:, :, None]).any(axis=1)
                newly = (wk & ~finish).any(axis=1)
                dead[kk[newly]] = True
                live[kk[newly]] = False
                first_dead_step[kk[newly]] = step
        if not live.any():
            break
        if stop_at is not None:
            # the caller only compares the risk with stop_at: stop as soon as that comparison is decided
            d = dead.sum()
            if d / K >= stop_at or (d + live.sum()) / K < stop_at:
                break
    risk = float(dead.mean())
    if return_detail:
        return risk, dead, first_dead_step
    return risk
