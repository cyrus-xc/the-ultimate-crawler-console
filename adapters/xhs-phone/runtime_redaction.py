"""Defense in depth for nested URL parameters in captured runtime messages."""
import re
import json
from urllib.parse import unquote

SECRET = re.compile(r'token|cookie|authorization|session|shield|password|credential|secret|signature|^sign$|^sid$|^x-mini-', re.I)
PARAM = re.compile(r'([?&]|^)([a-z0-9_.-]*(?:token|cookie|authorization|session|shield|password|credential|secret|signature)[a-z0-9_.-]*|sign|sid)=([^&#\s]*)', re.I)


def clean(value, key=''):
    if SECRET.search(key):
        return '[REDACTED]'
    if isinstance(value, dict):
        return {k: clean(v, k) for k, v in value.items() if k.lower() not in {'xsec_token','xsectoken'}}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str):
        for _ in range(4):
            decoded = unquote(value)
            if decoded == value:
                break
            value = decoded
        if value.lstrip().startswith(('{','[')):
            try:
                return json.dumps(clean(json.loads(value)),ensure_ascii=False,separators=(',',':'))
            except ValueError:
                pass
        return PARAM.sub(lambda m: m[1] + m[2] + '=REDACTED', value)
    return value
