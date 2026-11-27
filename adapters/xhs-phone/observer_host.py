"""Long-lived passive observer: one attachment and one hook load per App process.

Installing and removing the Java hooks for every action crashed XHS natively
(SIGBUS inside the Frida agent, about one in 10-25 cycles), while one loaded
observer survived 60 actions. This host attaches once per App pid, loads the
observer once, and serves sequential captures over the same stdio protocol as
capture_cli.py. A reset RPC restores the observer's per-action bounds.

Protocol: emits {"event":"host_ready"} after attachment; then, per request line
{"operation","values","timeout","private_media"}, the capture_cli events
(perform_action, response_ready, result | error). It exits when stdin closes
or the App session detaches.
"""
import argparse
import json
import os
import sys
import threading
from pathlib import Path
from capture_cli import emit, error_event, load_contract, attach, run_capture

SCRIPT_PATH = Path(__file__).with_name('observe-note-http.js')

class PersistentScript:
    """Script facade for UiResponseCapture: load() resets, unload() releases."""
    def __init__(self, script, source):
        self.script = script
        self.source = source
        self.handler = None
        self.lock = threading.Lock()

    def dispatch(self, message, data):
        with self.lock:
            handler = self.handler
        if handler is not None:
            handler(message, data)

    def on(self, signal, handler):
        if signal != 'message':
            raise ValueError('UNSUPPORTED_SCRIPT_SIGNAL')
        with self.lock:
            self.handler = handler

    def load(self):
        state = self.script.exports_sync.reset()
        self.dispatch({'type':'send','payload':{'event':'observer_ready','at':state.get('at'),'paths':state.get('paths'),'reused':True}}, None)
        if state.get('cronet'):
            self.dispatch({'type':'send','payload':{'event':'cronet_observer_ready','at':state.get('at'),'reused':True}}, None)

    def unload(self):
        with self.lock:
            self.handler = None

    @property
    def exports_sync(self):
        return self.script.exports_sync

class PersistentSession:
    def __init__(self, script):
        self.script = script

    def create_script(self, source):
        if source != self.script.source:
            raise RuntimeError('OBSERVER_SOURCE_CHANGED')
        return self.script

def start(frida, contract, endpoint, pid, *, ready_timeout=15):
    session = attach(frida, endpoint, pid)
    source = SCRIPT_PATH.read_text('utf-8')
    script = session.create_script(source)
    persistent = PersistentScript(script, source)
    ready = threading.Event(); first = {}
    def initial(message, data):
        payload = message.get('payload') or {}
        if message.get('type') == 'error':
            first.setdefault('error', 'CAPTURE_OBSERVER_FAILED'); ready.set()
        elif payload.get('event') == 'observer_ready':
            first.setdefault('package', payload.get('package')); ready.set()
    persistent.handler = initial
    script.on('message', persistent.dispatch)
    script.load()
    if not ready.wait(ready_timeout):
        raise RuntimeError('CAPTURE_OBSERVER_TIMEOUT')
    if first.get('error'):
        raise RuntimeError(first['error'])
    # Frida process names need not be Android package identifiers; the loaded
    # observer read the attached App's package from ActivityThread.
    if first.get('package') != contract['package']:
        raise RuntimeError('APP_MAIN_PROCESS_MISMATCH')
    persistent.unload()
    return session, PersistentSession(persistent)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--contract', required=True)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--pid', type=int, required=True)
    args = parser.parse_args()
    stage = 'configuration'
    try:
        import frida
        contract = load_contract(args.contract, frida.__version__)
        stage = 'attachment'
        session, persistent = start(frida, contract, args.endpoint, args.pid)
    except Exception as error:
        emit(error_event(error, stage))
        return 1
    def detached(reason, crash=None):
        # The App process exited or the transport closed. Nothing to clean up
        # on the device; report once and leave so the caller re-attaches.
        emit({'event':'error','code':'OBSERVER_DETACHED','diagnostics':{'exception_type':'SessionDetached','stage':'host','reason':str(reason)}})
        os._exit(3)
    session.on('detached', detached)
    emit({'event':'host_ready','pid':args.pid})
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        stage = 'capture'
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise RuntimeError('INVALID_CAPTURE_INPUT')
            timeout = float(request.get('timeout', 45))
            if not 0 < timeout <= 300:
                raise RuntimeError('INVALID_CAPTURE_INPUT')
            result = run_capture(persistent, contract, request.get('operation'), request.get('values'),
                                 timeout=timeout, private_media=request.get('private_media') is True,
                                 read_line=sys.stdin.readline)
            emit({'event':'result','result':result})
        except Exception as error:
            emit(error_event(error, stage))
    # Ordinary shutdown: detaching removes the hooks once, at the end of the
    # App process's observed lifetime rather than after every action.
    try: session.detach()
    except Exception: pass
    return 0

if __name__ == '__main__':
    sys.exit(main())
