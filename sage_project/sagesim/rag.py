"""Live allocation state, event coding and deadlock detection.

Resources are single-instance. Events of a process are coded as integers:
    request r  -> r            (0 <= r < m)
    release r  -> m + r
    exit       -> 2m
The behaviour models additionally use a START state (code 2m + 1) for a process
that has not emitted any event in its current life.
"""
import numpy as np

REQ, REL, EXIT = 0, 1, 2          # op kinds used by the workload programs
ACTIVE, WAITING, DONE = 0, 1, 2   # process status
NONE, HELD, POLICY = 0, 1, 2      # why a process is waiting


def n_events(m):
    return 2 * m + 1


def start_state(m):
    return 2 * m + 1


class State:
    """Allocation matrix A, pending-request vector, available vector and per-process status,
    plus the current tick and the tick at which each waiting process started to wait."""

    def __init__(self, n, m):
        self.n, self.m = n, m
        self.alloc = np.zeros((n, m), dtype=bool)
        self.avail = np.ones(m, dtype=bool)
        self.status = np.zeros(n, dtype=np.int8)
        self.pending = np.full(n, -1, dtype=np.int64)
        self.reason = np.zeros(n, dtype=np.int8)
        self.last = np.full(n, start_state(m), dtype=np.int64)
        self.since = np.full(n, -1, dtype=np.int64)      # tick the current wait began, -1 if not waiting
        self.done_at = np.zeros(n, dtype=np.int64)       # tick of the slot's last completed life
        self.peak = np.zeros(n, dtype=np.int64)          # most resources held since the process last held nothing
        self.epis = np.zeros(n, dtype=np.int64)          # holding episodes completed in the current life
        self.born = np.zeros(n, dtype=np.int64)          # tick at which the current life started (timestamp)
        self.now = 0

    def copy(self):
        c = State.__new__(State)
        c.n, c.m, c.now = self.n, self.m, self.now
        for k in ('alloc', 'avail', 'status', 'pending', 'reason', 'last', 'since', 'done_at', 'peak', 'epis', 'born'):
            setattr(c, k, getattr(self, k).copy())
        return c

    def holder(self, r):
        idx = np.flatnonzero(self.alloc[:, r])
        return int(idx[0]) if len(idx) else -1

    def apply_grant(self, i, r):
        assert self.avail[r], 'grant of a held resource'
        self.alloc[i, r] = True
        self.avail[r] = False
        self.peak[i] = max(self.peak[i], int(self.alloc[i].sum()))
        self.status[i] = ACTIVE
        self.pending[i] = -1
        self.reason[i] = NONE
        self.since[i] = -1

    def release(self, i, r):
        if self.alloc[i, r]:
            self.alloc[i, r] = False
            self.avail[r] = True

    def release_all(self, i):
        self.avail |= self.alloc[i]
        self.alloc[i] = False

    def wait(self, i, r, reason):
        """Process i starts (or keeps) waiting for resource r."""
        if self.status[i] != WAITING:
            self.since[i] = self.now
        self.status[i] = WAITING
        self.pending[i] = r
        self.reason[i] = reason

    def wait_for(self):
        """Wait-for graph over processes blocked on a held resource: i -> {holder}."""
        g = {}
        for i in range(self.n):
            if self.status[i] == WAITING and self.reason[i] == HELD:
                h = self.holder(self.pending[i])
                g[i] = {h} if h >= 0 else set()
        return g


def has_cycle(wait_for):
    """Depth-first search for a back edge in the wait-for graph."""
    WHITE, GREY, BLACK = 0, 1, 2
    colour = {p: WHITE for p in wait_for}

    def visit(u):
        colour[u] = GREY
        for v in wait_for.get(u, ()):
            if v not in colour:
                continue
            if colour[v] == GREY:
                return True
            if colour[v] == WHITE and visit(v):
                return True
        colour[u] = BLACK
        return False

    return any(colour[p] == WHITE and visit(p) for p in wait_for)


def find_cycle(wait_for, start):
    """Return the processes on the cycle reachable from `start`, or [] if there is none."""
    path, seen = [], set()
    u = start
    while u in wait_for and u not in seen:
        seen.add(u)
        path.append(u)
        nxt = wait_for[u]
        if not nxt:
            return []
        u = next(iter(nxt))
    if u in seen:
        return path[path.index(u):]
    return []


def is_deadlocked(state):
    """Exact check on the live state: with single-instance resources, a cycle in the wait-for graph."""
    return has_cycle(state.wait_for())
