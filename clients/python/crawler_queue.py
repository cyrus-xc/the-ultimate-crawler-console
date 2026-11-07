"""Standard-library client. No platform retries or browser/ADB process ownership."""
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

class QueueError(RuntimeError):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code, self.status = code, status

class CrawlerQueueClient:
    def __init__(self, endpoint, token, *, timeout=30, opener=urlopen):
        url = urlsplit(endpoint)
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path not in ('', '/') or url.username or url.query or url.fragment:
            raise ValueError('Queue endpoint must be an IPv4 loopback HTTP origin')
        self.endpoint, self.token, self.timeout, self.opener = endpoint.rstrip('/'), token, timeout, opener

    def _call(self, method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode('utf-8')
        req = Request(self.endpoint+path, data=data, method=method,
                      headers={'Authorization': 'Bearer '+self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener(req, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                code = json.load(exc).get('error', {}).get('code', 'SERVICE_ERROR')
            except (ValueError, TypeError):
                code = 'SERVICE_ERROR'
            raise QueueError(code, exc.code) from None
        except (URLError, TimeoutError, OSError):
            raise QueueError('SERVICE_UNAVAILABLE') from None
        except (ValueError, TypeError):
            raise QueueError('SERVICE_RESPONSE_INVALID') from None

    def submit(self, request):
        return self._call('POST', '/v1/requests', request)

    def get(self, request_id):
        return self._call('GET', '/v1/requests/'+self._id(request_id))

    @staticmethod
    def _id(value):
        from uuid import UUID
        return str(UUID(value))

    def action(self, request_id, action):
        if action not in {'pause', 'resume', 'cancel', 'retry'}:
            raise ValueError('Invalid queue action')
        return self._call('POST', '/v1/requests/'+self._id(request_id)+'/'+action)

    def results(self, request_id, cursor=0):
        if type(cursor) is not int or cursor < 0:
            raise ValueError('Invalid cursor')
        return self._call('GET', '/v1/requests/'+self._id(request_id)+'/results?cursor='+str(cursor))

    def wait(self, request_id, *, timeout=600, interval=1):
        deadline = time.monotonic()+timeout
        while True:
            result = self.get(request_id)
            if result['state'] in {'succeeded', 'partial', 'failed', 'cancelled', 'paused'}:
                return result
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                # A local waiting deadline does not cancel or duplicate remote work.
                raise QueueError('CLIENT_WAIT_TIMEOUT')
            time.sleep(min(interval, remaining))
