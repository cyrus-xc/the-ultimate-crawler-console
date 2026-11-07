"""Standalone anonymous XHS share-page reader.
Parser/field semantics migrated from core/collect/mobile_note.py (xhs-analysis).
No account cookie or browser is used; queue owns admission, errors and evidence.
Legacy local cache reads remain in the pipeline compatibility boundary.
"""
from __future__ import annotations

import calendar
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

PHONE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
            '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
XHS_HOSTS = {'www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'}
NOTE_ID = re.compile(r'[a-f0-9]{24}')
MAX_HOPS = 6
MIN_INTERVAL = 1.5
UNTAGGED_MAX_AGE = 86400  # seconds; a read without a 📍 is read again after a day
VERSION = 'xhs_mobile_note_v1'

_LOCK = threading.Lock()
_LAST = [0.0]


def initial_state(html: str):
    """``window.__INITIAL_STATE__`` as data, or None. Bare ``undefined`` outside
    strings becomes null; braces inside strings do not count."""
    marker = re.search(r'(?:window\.)?__INITIAL_STATE__\s*=\s*\{', html or '')
    if not marker:
        return None
    out, depth, in_string, escaped = [], 0, False, False
    i = marker.end() - 1
    while i < len(html):
        c = html[i]
        if in_string:
            out.append(c)
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            out.append(c)
        elif html.startswith('undefined', i) and not re.match(r'[\w$]', html[i - 1]) \
                and not re.match(r'[\w$]', html[i + 9:i + 10] or ' '):
            out.append('null')
            i += 9
            continue
        else:
            out.append(c)
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(''.join(out))
                    except ValueError:
                        return None
        i += 1
    return None


def note_from_page(html: str, note_id: str) -> dict | None:
    """The note's author and location when the page is that note; None otherwise."""
    note = ((((initial_state(html) or {}).get('noteData') or {}).get('data') or {}).get('noteData')) or {}
    if str(note.get('noteId') or '').lower() != note_id:
        return None
    user = note.get('user') or {}
    poi = note.get('poi') if isinstance(note.get('poi'), dict) else {}
    uid = str(user.get('userId') or '').lower()
    return {'note_id': note_id, 'user_id': uid if NOTE_ID.fullmatch(uid) else '',
            'nickname': str(user.get('nickName') or user.get('nickname') or ''),
            'poi_id': str(poi.get('poiId') or poi.get('id') or ''), 'poi_name': str(poi.get('name') or '')}


class BlockedPage(RuntimeError):
    """XHS answered with a captcha or login page: stop and retry later."""


def _count(value):
    text = str(value if value is not None else '').strip()
    if not text:
        return None
    try:
        if text.endswith('万'):
            return int(round(float(text[:-1]) * 10000))
        return int(float(text))
    except ValueError:
        return None


def note_detail_from_page(html: str, note_id: str) -> dict | None:
    """The note as a raw-detail row (counters, type, time, author, 📍) when the
    page is that note; None otherwise. Missing counters stay None, never 0."""
    note = ((((initial_state(html) or {}).get('noteData') or {}).get('data') or {}).get('noteData')) or {}
    if str(note.get('noteId') or '').lower() != note_id:
        return None
    base = note_from_page(html, note_id)
    info = note.get('interactInfo') or {}
    published = note.get('time')
    try:
        published = int(published) // 1000 if published and int(published) > 10 ** 11 else int(published) if published else None
    except (TypeError, ValueError):
        published = None
    kind = str(note.get('type') or '').lower()
    return {'note_id': note_id, 'user_id': base['user_id'], 'author_user_id': base['user_id'],
            'author_nickname': base['nickname'], 'title': str(note.get('title') or ''),
            'desc': str(note.get('desc') or ''),
            'liked_count': _count(info.get('likedCount')), 'collected_count': _count(info.get('collectedCount')),
            'comment_count': _count(info.get('commentCount')), 'shared_count': _count(info.get('shareCount')),
            'create_time': published, 'note_type': 'video' if kind == 'video' else 'normal' if kind else None,
            'ip_location': str(note.get('ipLocation') or ''),
            'tags': [str(t.get('name') or '') for t in note.get('tagList') or [] if isinstance(t, dict)],
            'poi_id': base['poi_id'], 'poi_name': base['poi_name'],
            'source_quality': 'mobile_share_page', 'version': VERSION}


def fetch_page(url,timeout=10):
    current=url
    for _ in range(MAX_HOPS):
        parsed=urlsplit(current)
        if parsed.scheme not in ('http','https') or parsed.hostname not in XHS_HOSTS or parsed.username or parsed.password or parsed.port not in (None,80,443):raise ValueError('INVALID_OBSERVED_URL')
        import requests
        _pace()
        with requests.get(current,allow_redirects=False,timeout=timeout,headers={'User-Agent':PHONE_UA,'Accept':'text/html'},stream=True) as response:
            target=response.headers.get('Location')
            if 300<=response.status_code<400 and target:
                current=urljoin(current,target);continue
            if not response.ok:return None
            chunks=[];size=0
            for chunk in response.iter_content(65536):
                size+=len(chunk)
                if size>2000000:raise ValueError('SHARE_PAGE_TOO_LARGE')
                chunks.append(chunk)
            return current,b''.join(chunks).decode(response.encoding or 'utf-8',errors='replace')
    raise ValueError('REDIRECT_LIMIT')
def _pace():
    with _LOCK:
        wait=_LAST[0]+MIN_INTERVAL-time.monotonic()
        if wait>0:time.sleep(wait)
        _LAST[0]=time.monotonic()
def resolve(url,timeout=10):
    page=fetch_page(url,timeout)
    if not page:raise ValueError('LINK_UNRESOLVED')
    resolved=page[0];parsed=urlsplit(resolved)
    if parsed.hostname not in {'www.xiaohongshu.com','xiaohongshu.com'}:raise ValueError('LINK_UNRESOLVED')
    result={'resolved_url':resolved}
    note=re.search(r'/(?:explore|discovery/item)/([a-fA-F0-9]{24})',parsed.path)
    user=re.search(r'/user/profile/([a-fA-F0-9]{24})',parsed.path)
    if note:result['post_id']=note.group(1)
    if user:result['user_id']=user.group(1)
    return result

def run(request):
    target=request['target'];native=request.get('params',{}).get('native_request',{})
    if request['operation']=='link.resolve':return {'body':resolve(target['url'])}
    note_id=target['post_id'].lower()
    if not NOTE_ID.fullmatch(note_id):raise ValueError('INVALID_NOTE_ID')
    token=native.get('xsec_token','');url=target.get('observed_url','')
    if not url and not token:return None
    # Access token is observed evidence, never manufactured from a bare note id.
    url=url or f'https://www.xiaohongshu.com/explore/{note_id}?xsec_token={quote(token,safe="")}&xsec_source=pc_user'
    result=fetch_page(url)
    if not result:return None
    if any(mark in result[0] for mark in ('captcha','website-login')):raise ValueError('VERIFICATION_REQUIRED')
    detail=native.get('representation')!='mobile_metadata'
    found=(note_detail_from_page if detail else note_from_page)(result[1],note_id)
    if found:
        observed=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        if detail:found['metrics_observed_at']=observed
        else:found.update(version=VERSION,observed_at=observed)
    return found
if __name__=='__main__':
    import sys
    try:print(json.dumps({'success':True,'data':run(json.loads(sys.stdin.readline()))},ensure_ascii=False),flush=True)
    except Exception as exc:
        code=str(exc) if re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}',str(exc)) else 'SHARE_PAGE_UNAVAILABLE'
        print(json.dumps({'success':False,'error':code}),flush=True)
