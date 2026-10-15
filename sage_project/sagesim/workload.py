"""Synthetic workloads. A process *type* fixes the personality and its pattern; each life
of the process is a program (list of ops) generated from the type with fresh randomness.
Families assign types to the n process slots."""
import numpy as np

from .rag import REQ, REL, EXIT

PERSONALITIES = ('fixed', 'bursty', 'escalating')


class ProcessType:
    def __init__(self, personality, m, rng, seq=None, order=None, levels=None, p_burst=0.35,
                 post_seq=None, max_held=2, ops=None, cycles=(1, 1), name=None):
        self.personality = personality
        self.m = m
        self.p_burst = p_burst
        self.max_held = max_held
        self.shifted = False            # for the distribution-shift experiment
        self.post_seq = post_seq
        self.name = name
        if personality == 'custom':
            # a hand-written (or AI-designed) block of ops, repeated `cycles` times per life
            self.ops = [(int(k), int(r)) for k, r in ops if int(k) != EXIT]
            self.cycles = (int(cycles[0]), int(cycles[1]))
        elif personality == 'fixed':
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
        if self.personality == 'custom':
            lo, hi = self.cycles
            reps = int(rng.integers(lo, hi + 1)) if hi > lo else lo
            for _ in range(max(reps, 1)):
                ops.extend(self.ops)
        elif self.personality == 'fixed':
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


OP_NAMES = {'req': REQ, 'request': REQ, 'acquire': REQ, 'lock': REQ, 'take': REQ, 'get': REQ,
            'rel': REL, 'release': REL, 'free': REL, 'unlock': REL, 'put': REL, 'drop': REL}
PERSONALITY_LABEL = {'fixed': 'Fixed pattern', 'bursty': 'Bursty / random', 'escalating': 'Gradually escalating',
                     'custom': 'Custom program'}


def parse_ops(items, m, resources=None):
    """Ops from a spec: ["req 0", ["rel", 1], {"op": "request", "r": 2}, "lock printer"] -> [(REQ, 0), ...].
    Resource names (from `resources`) are accepted in place of indices."""
    names = {str(x).strip().lower(): k for k, x in enumerate(resources or [])}
    out = []
    for it in items:
        if isinstance(it, dict):
            op, r = it.get('op', it.get('kind')), it.get('r', it.get('resource'))
        elif isinstance(it, (list, tuple)):
            op, r = it[0], it[1]
        else:
            parts = str(it).replace(',', ' ').replace('(', ' ').replace(')', ' ').split()
            op, r = parts[0], ' '.join(parts[1:]) if len(parts) > 1 else -1
        op = str(op).strip().lower()
        if op in ('exit', 'done', 'finish'):
            continue
        if op not in OP_NAMES:
            raise ValueError('unknown op %r' % op)
        if isinstance(r, str):
            key = r.strip().lower()
            if key.lstrip('-').isdigit():
                r = int(key)
            elif key in names:
                r = names[key]
            elif key.startswith('r') and key[1:].isdigit():
                r = int(key[1:]) - 1                       # "R1" is resource 0
            else:
                raise ValueError('unknown resource %r' % r)
        r = int(r)
        if not 0 <= r < m:
            raise ValueError('resource index %d out of range (m = %d)' % (r, m))
        out.append((OP_NAMES[op], r))
    return out


def check_ops(ops, m):
    """A custom program must never request what it holds or release what it does not hold,
    and it must release everything before it exits (what the harness would do anyway).
    Returns the ops with any missing releases appended."""
    held = []
    for kind, r in ops:
        if kind == REQ:
            if r in held:
                raise ValueError('requests resource %d while holding it' % r)
            held.append(r)
        else:
            if r not in held:
                raise ValueError('releases resource %d without holding it' % r)
            held.remove(r)
    return list(ops) + [(REL, r) for r in reversed(held)]


def types_from_spec(spec, rng):
    """Process types for a workload spec:
    {"m": 4, "resources": ["printer", ...],
     "processes": [{"name": "P1", "type": "custom", "ops": [...], "cycles": [2, 4]},
                   {"type": "fixed", "seq": [1, 0]}, {"type": "bursty"},
                   {"type": "escalating", "order": [0, 1, 2], "levels": 3}]}"""
    m = int(spec['m'])
    if not 1 <= m <= 32:
        raise ValueError('m must be between 1 and 32')
    resources = spec.get('resources')
    procs = spec.get('processes') or []
    if not 1 <= len(procs) <= 32:
        raise ValueError('between 1 and 32 processes are supported')
    types = []
    for k, p in enumerate(procs):
        kind = str(p.get('type', 'custom')).lower()
        name = str(p.get('name') or 'P%d' % (k + 1))[:24]
        if kind == 'custom':
            ops = check_ops(parse_ops(p.get('ops', []), m, resources), m)
            if not ops:
                raise ValueError('%s: a custom process needs at least one op' % name)
            cyc = p.get('cycles', [1, 1])
            if isinstance(cyc, (int, float)):
                cyc = [int(cyc), int(cyc)]
            lo, hi = max(1, int(cyc[0])), max(1, int(cyc[1]))
            types.append(ProcessType('custom', m, rng, ops=ops, cycles=(min(lo, hi), max(lo, hi)), name=name))
        elif kind == 'fixed':
            seq = p.get('seq')
            if seq is not None:
                seq = [r for _, r in parse_ops([('req', r) for r in seq], m, resources)]
                if len(set(seq)) != len(seq) or not seq:
                    raise ValueError('%s: seq must be distinct resources' % name)
            types.append(ProcessType('fixed', m, rng, seq=seq, name=name))
        elif kind == 'escalating':
            order = p.get('order')
            if order is not None:
                order = [r for _, r in parse_ops([('req', r) for r in order], m, resources)]
                if sorted(order) != list(range(m)):
                    raise ValueError('%s: order must be a permutation of all %d resources' % (name, m))
            levels = p.get('levels')
            if levels is not None and not 1 <= int(levels) <= m:
                raise ValueError('%s: levels must be between 1 and %d' % (name, m))
            types.append(ProcessType('escalating', m, rng, order=order, levels=levels, name=name))
        elif kind in ('bursty', 'random'):
            types.append(ProcessType('bursty', m, rng, p_burst=float(p.get('p_burst', 0.35)),
                                     max_held=max(1, int(p.get('max_held', 2))), name=name))
        else:
            raise ValueError('%s: unknown process type %r' % (name, kind))
    return types


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
