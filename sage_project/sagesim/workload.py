"""Synthetic workloads. A process *type* fixes the personality and its pattern; each life
of the process is a program (list of ops) generated from the type with fresh randomness.
Families assign types to the n process slots."""
import numpy as np

from .rag import REQ, REL, EXIT

PERSONALITIES = ('fixed', 'bursty', 'escalating')


class ProcessType:
    def __init__(self, personality, m, rng, seq=None, order=None, levels=None, p_burst=0.35,
                 post_seq=None, max_held=2):
        self.personality = personality
        self.m = m
        self.p_burst = p_burst
        self.max_held = max_held
        self.shifted = False            # for the distribution-shift experiment
        self.post_seq = post_seq
        if personality == 'fixed':
            k = int(rng.integers(2, 4)) if seq is None else len(seq)
            self.seq = list(rng.choice(m, size=k, replace=False)) if seq is None else list(seq)
        elif personality == 'escalating':
            self.order = list(rng.permutation(m)) if order is None else list(order)
            self.levels = int(rng.integers(2, min(m, 4) + 1)) if levels is None else int(levels)
        elif personality != 'bursty':
            raise ValueError(personality)

    # -- a single life of the process --------------------------------------
    def program(self, rng):
        ops = []
        if self.personality == 'fixed':
            seq = self.post_seq if (self.shifted and self.post_seq) else self.seq
            cycles = int(rng.integers(4, 9))
            for _ in range(cycles):
                for r in seq:
                    ops.append((REQ, int(r)))
                for r in reversed(seq):
                    ops.append((REL, int(r)))
        elif self.personality == 'escalating':
            for lvl in range(1, self.levels + 1):
                held = self.order[:lvl]
                for r in held:
                    ops.append((REQ, int(r)))
                for r in reversed(held):
                    ops.append((REL, int(r)))
        else:  # bursty / random
            length = int(rng.integers(30, 61))
            held = []
            while len(ops) < length:
                if held and rng.random() < 0.5:
                    r = held.pop(int(rng.integers(len(held))))
                    ops.append((REL, r))
                else:
                    burst = int(rng.integers(2, 4)) if rng.random() < self.p_burst else 1
                    for _ in range(burst):
                        free = [r for r in range(self.m) if r not in held]
                        if not free or len(held) >= self.max_held:
                            break
                        r = int(rng.choice(free))
                        held.append(r)
                        ops.append((REQ, r))
            for r in reversed(held):
                ops.append((REL, r))
        ops.append((EXIT, -1))
        return ops


def true_max(program, m):
    """Declared maximum for the Banker's baseline: every resource the program will request."""
    mx = np.zeros(m, dtype=np.int64)
    for kind, r in program:
        if kind == REQ:
            mx[r] = 1
    return mx


def family_types(family, n, m, rng):
    """Process types for the n slots of a workload family."""
    if family in PERSONALITIES:
        return [ProcessType(family, m, rng) for _ in range(n)]
    if family == 'mixed':
        return [ProcessType(PERSONALITIES[i % 3], m, rng) for i in range(n)]
    if family == 'shift':
        # half the processes follow A->B->C and switch to A->D->E; the others acquire E then D,
        # which conflicts with the post-shift order (no conflict exists before the shift)
        types = []
        for i in range(n):
            if i < n // 2:
                types.append(ProcessType('fixed', m, rng, seq=[0, 1, 2], post_seq=[0, 3, 4]))
            else:
                types.append(ProcessType('fixed', m, rng, seq=[4, 3]))
        return types
    raise ValueError(family)


def program_events(program, m):
    """Event codes of a program as the request log would record them (used for warm-up)."""
    codes = []
    for kind, r in program:
        if kind == REQ:
            codes.append(r)
        elif kind == REL:
            codes.append(m + r)
        else:
            codes.append(2 * m)
    return codes
