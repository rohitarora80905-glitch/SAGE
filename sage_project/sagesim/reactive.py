"""Reactive DFS baseline: grant whenever the resource is free; blocking and the cycle
check are handled by the harness, which runs the exact DFS detection on every block."""

GRANT, WAIT, FALLBACK = 'grant', 'wait', 'fallback'


class ReactivePolicy:
    name = 'reactive'

    def decide(self, state, i, r):
        return GRANT, None, 'reactive'

    def pick_forced(self, state, queued):
        return queued[0]

    def set_program_max(self, i, maximum):
        pass
