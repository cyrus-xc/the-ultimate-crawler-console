"""Passive login transport diagnostics; no payload, query or credential storage."""
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

STATUSES = {'new', 'pending', 'waiting', 'scanned', 'confirmed', 'expired', 'success', 'failed', 'fail', 'cancelled'}

def endpoint(url):
    parsed = urlsplit(url)
    host = parsed.hostname or ''
    if not (host == 'douyin.com' or host.endswith('.douyin.com')):
        return None
    if not any(part in (host + parsed.path).lower() for part in ('passport', 'qrcode', 'qrconnect', 'sso', 'login')):
        return None
    # Paths containing IDs may themselves carry credentials: never persist them.
    safe_path = parsed.path if re.fullmatch(r'/[a-zA-Z_/-]{0,160}', parsed.path) else '[redacted_path]'
    return {'host': host, 'path': safe_path}

def codes(body):
    result = {}
    for scope, value in (('', body), ('data.', body.get('data') if isinstance(body, dict) else None)):
        if not isinstance(value, dict):
            continue
        for key in ('error_code', 'status_code', 'code', 'status'):
            code = value.get(key)
            if type(code) is int or (isinstance(code, str) and (re.fullmatch(r'-?\d{1,10}', code) or code.lower() in STATUSES)):
                result[scope + key] = code
    return result

class LoginDiagnostics:
    def __init__(self, root):
        self.file = Path(root) / 'douyin-login-transport.json'
        self.active = False
        self.events = []

    def start(self):
        self.active = True
        self.events = []
        self.save()

    def save(self):
        self.file.write_text(json.dumps({'events': self.events}), encoding='utf-8')
        self.file.chmod(0o600)

    def wall(self, kind):
        if kind not in {'identity_verification', 'captcha'}:
            return
        self.events.append({'at': time.time(), 'ui_status': kind,
                            'message': 'Complete the verification shown by Douyin.'})
        self.events = self.events[-100:]
        self.save()

    def response(self, response):
        if not self.active:
            return
        target = endpoint(response.url)
        if not target:
            return
        event = {**target, 'at': time.time(), 'http_status': response.status}
        try:
            event.update(codes(response.json()))
        except Exception:
            event['json_observed'] = False
        self.events.append(event)
        self.events = self.events[-100:]
        self.save()
