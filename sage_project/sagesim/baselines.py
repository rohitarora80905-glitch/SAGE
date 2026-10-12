"""Further baselines from the classic deadlock-handling strategies (Silberschatz et al.).

  BankersNoDeclaration - avoidance without declared demand: every process is assumed to
                         need every resource (the only safe claim when nothing is declared).
  WaitDiePolicy        - prevention, non-preemptive timestamps: an older requester waits for
                         a younger holder; a younger requester dies (is rolled back).
  WoundWaitPolicy      - prevention, preemptive timestamps: an older requester wounds (rolls
                         back) a younger holder and takes the resource; a younger one waits.
  TimeoutPolicy        - detection by timeout: deadlocks are not detected; a process blocked
                         for `timeout` events is rolled back.

A process's timestamp is the tick at which its current life started (state.born); it is kept
through rollbacks, as the schemes require, so an old process cannot starve.
"""
import numpy as np

from .bankers import BankersPolicy
from .reactive import GRANT


class BankersNoDeclaration(BankersPolicy):
    name = 'bankers_nodecl'

    def __init__(self, n, m):
        super().__init__(np.ones((n, m), dtype=np.int64))

    def set_program_max(self, i, maximum):
        pass                                       # nothing is declared: the claim stays "everything"


class _GrantAll:
    name = 'grant_all'

    def decide(self, state, i, r):
        return GRANT, None, self.name

    def pick_forced(self, state, queued):
        return queued[0]

    def set_program_max(self, i, maximum):
        pass


def _older(state, a, b):
    return (state.born[a], a) < (state.born[b], b)


class WaitDiePolicy(_GrantAll):
    name = 'wait_die'

    def on_block(self, state, i, r, holder):
        return 'wait' if _older(state, i, holder) else 'die'


class WoundWaitPolicy(_GrantAll):
    name = 'wound_wait'

    def on_block(self, state, i, r, holder):
        return 'wound' if _older(state, i, holder) else 'wait'


class TimeoutPolicy(_GrantAll):
    name = 'timeout'
    recovery = 'timeout'

    def __init__(self, timeout=50):
        self.timeout = timeout
