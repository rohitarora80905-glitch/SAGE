"""Background jobs for the web console: simulations run in worker threads, report progress
and can be cancelled. Results are kept in memory (the most recent MAX_KEEP jobs)."""
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor


class JobCancelled(Exception):
    pass


class Job:
    def __init__(self, kind, params):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.params = params
        self.status = 'queued'            # queued, running, done, error, cancelled
        self.progress = 0.0
        self.message = ''
        self.result = None
        self.error = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self.cancel_requested = False
        self.version = 0                  # bumped on every change (for the event stream)
        self.lock = threading.Lock()

    def touch(self, **kw):
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)
            self.version += 1

    def report(self, done, total, message=None):
        """Progress callback handed to the simulation; raises to cancel."""
        if self.cancel_requested:
            raise JobCancelled()
        self.touch(progress=min(1.0, done / max(total, 1)), message=message or self.message)

    def public(self, with_result=False):
        d = dict(id=self.id, kind=self.kind, status=self.status, progress=self.progress, message=self.message,
                 created=self.created, started=self.started, finished=self.finished, error=self.error,
                 params=self.params, version=self.version,
                 elapsed=(self.finished or time.time()) - (self.started or self.created))
        if with_result:
            d['result'] = self.result
        return d


class JobManager:
    MAX_KEEP = 40

    def __init__(self, workers=2):
        self.jobs = OrderedDict()
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.lock = threading.Lock()

    def submit(self, kind, params, fn):
        """fn(job) -> result (JSON-serialisable). Returns the job."""
        job = Job(kind, params)
        with self.lock:
            self.jobs[job.id] = job
            while len(self.jobs) > self.MAX_KEEP:
                old_id, old = next(iter(self.jobs.items()))
                if old.status in ('queued', 'running'):
                    break
                self.jobs.popitem(last=False)

        def work():
            if job.cancel_requested:
                job.touch(status='cancelled', finished=time.time())
                return
            job.touch(status='running', started=time.time())
            try:
                result = fn(job)
                job.touch(status='done', result=result, progress=1.0, finished=time.time())
            except JobCancelled:
                job.touch(status='cancelled', finished=time.time())
            except Exception as e:                       # noqa: BLE001 - report any failure to the UI
                job.touch(status='error', error='%s: %s' % (type(e).__name__, e),
                          message=traceback.format_exc()[-2000:], finished=time.time())

        self.pool.submit(work)
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            return False
        job.cancel_requested = True
        if job.status == 'queued':
            job.touch(status='cancelled', finished=time.time())
        return True

    def list(self):
        return [j.public() for j in reversed(self.jobs.values())]
