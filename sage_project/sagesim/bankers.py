"""Banker's Algorithm baseline. Declared maxima are the true per-life maxima supplied by
the workload generator (the most favourable setting for the algorithm)."""
import numpy as np

from .reactive import GRANT, WAIT


def is_safe(available, allocation, maximum):
    """Safety check as in Silberschatz et al. Works for multi-instance vectors too.
    Returns (safe, sequence)."""
    work = np.array(available, dtype=np.int64).copy()
    allocation = np.array(allocation, dtype=np.int64)
    need = np.array(maximum, dtype=np.int64) - allocation
    n = len(allocation)
    finish = [False] * n
    seq = []
    progress = True
    while progress:
        progress = False
        for i in range(n):
            if not finish[i] and np.all(need[i] <= work):
                work = work + allocation[i]
                finish[i] = True
                seq.append(i)
                progress = True
    return all(finish), seq


class BankersPolicy:
    name = 'bankers'

    def __init__(self, maxima):
        self.maximum = np.array(maxima, dtype=np.int64)   # (n, m)

    def set_program_max(self, i, maximum):
        self.maximum[i] = maximum

    def decide(self, state, i, r):
        if state.alloc[i, r] + 1 > self.maximum[i, r]:
            raise ValueError('request exceeds declared maximum')
        if not state.avail[r]:
            return WAIT, None, 'bankers'
        trial_alloc = state.alloc.astype(np.int64).copy()
        trial_avail = state.avail.astype(np.int64).copy()
        trial_alloc[i, r] += 1
        trial_avail[r] -= 1
        # processes that have finished hold nothing and need nothing
        maximum = self.maximum.copy()
        maximum[state.status == 2] = 0
        safe, _ = is_safe(trial_avail, trial_alloc, maximum)
        return (GRANT if safe else WAIT), None, 'bankers'

    def pick_forced(self, state, queued):
        return queued[0]
