"""Observed XHS note links. Never manufacture a share URL from a note id.

Share URLs may retain their note access parameters (owner, 2026-10-09).
They are observed links, not a promise of permanent anonymous accessibility.
"""
import json
import re
from urllib.parse import parse_qs, urlparse, urlsplit

NOTE_PATH = re.compile(r'/(?:explore|discovery/item)/([a-fA-F0-9]{24})/?$')
HOSTS = {'www.xiaohongshu.com', 'xiaohongshu.com'}
SHORT_HOSTS = {'xhslink.com', 'xhslink.cn'}


def poi_id_from_url(url):
    if not url:return None
    p=urlparse(url)
    match=re.fullmatch(r'/apps/sns-poi/detail/([a-fA-F0-9]{8,64})/?',p.path)
    if p.scheme!='https' or p.netloc!='www.xiaohongshu.com' or not match:raise ValueError('Expected an XHS POI share URL')
    return match.group(1)


def valid_note_url(value, note_id=None):
    if not isinstance(value, str) or re.search(r'[\s<>"\x00-\x1f]', value):
        return False
    try:
        url = urlsplit(value)
        if url.scheme not in {'http', 'https'} or url.username or url.password or url.port not in (None, 80, 443):
            return False
        if url.hostname in SHORT_HOSTS:
            return bool(re.fullmatch(r'/[A-Za-z0-9/._-]+', url.path))
        match = NOTE_PATH.fullmatch(url.path)
        token = parse_qs(url.query).get('xsec_token', [''])[0]
        return bool(url.hostname in HOSTS and match and (not note_id or match[1] == str(note_id))
                    and token and token not in {'REDACTED', '<REDACTED>'})
    except (ValueError, TypeError):
        return False


def note_share_url(row):
    """Use an observed same-note URL, including legacy provider raw payloads.

    Only note containers are inspected: a user/profile share_link must never
    supply a token for a note. Short links in rows rely on the collector's
    identity check; no network resolution happens during report generation.
    """
    if not isinstance(row, dict):
        return None
    nid = row.get('note_id') or row.get('noteId') or row.get('id')
    for key in ('share_url', 'shareUrl', 'share_link', 'shareLink', 'link', 'url', 'share_text'):
        value = row.get(key)
        if isinstance(value, str):
            for found in re.findall(r'https?://[^\s<>"\']+', value):
                if valid_note_url(found, nid):
                    return found
    raw = row.get('raw_json')
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    if isinstance(raw, dict):
        return _raw_note_url(raw, nid)
    return None


def _raw_note_url(raw, nid):
    own_id = raw.get('note_id') or raw.get('noteId') or raw.get('id')
    if own_id and str(own_id) != str(nid):
        return None
    if own_id:
        found = note_share_url({**{k: v for k, v in raw.items() if k != 'raw_json'}, 'note_id': nid})
        if found:
            return found
    for key in ('data', 'note', 'notes', 'items'):
        child = raw.get(key)
        for item in child if isinstance(child, list) else [child]:
            if isinstance(item, dict):
                found = _raw_note_url(item, nid)
                if found:
                    return found
    return None
