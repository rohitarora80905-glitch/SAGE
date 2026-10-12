"""Planned LSTM behaviour model (not part of the core implementation).

It would expose the same interface as MarkovModel (update, sample_next_batch, support,
window_loglik) so that the rollout engine and the SAGE policy need no change.
"""


class LSTMModel:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError('The LSTM behaviour model is a planned variant; see the report, Section 8.5.')
