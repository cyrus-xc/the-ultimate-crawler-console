"""UI-triggered response capture; injection points make offline verification possible.

The caller owns the device lease, foreground/PID verification, app-version
contract, and UI actions. A fresh bounded observer is loaded for each action.
This module never loads an App service invocation agent or fabricates a request.
"""
import copy
import json
import threading
import time
from pathlib import Path
from response_evidence import request_matches, request_target_matches, classify_transport, bridge_result
from runtime_redaction import clean

class CaptureError(RuntimeError):
    pass

def semantic_request(request, operation):
    """Normalize observed App sort encoding only for semantic validation.

    Keep the original request in evidence. The latest shortcut (filter_hot)
    is not the chronological sort (sort_type=time_descending).
    """
    if operation != 'search':
        return request
    result = copy.deepcopy(request)
    query = {q['name']: q['value'] for q in request.get('query', [])}
    direct = query.get('sort') or 'general'
    try:
        filters = json.loads(query.get('filters') or '[]')
        if not isinstance(filters, list) or any(not isinstance(f,dict) for f in filters):
            raise ValueError('Invalid filter list')
        sorts = [f['tags'] for f in filters if isinstance(f, dict) and f.get('type') == 'sort_type']
        if len(sorts) > 1 or (sorts and (not isinstance(sorts[0], list) or len(sorts[0]) != 1)):
            raise ValueError('Ambiguous sort')
        effective = sorts[0][0] if sorts else direct
        remaining = [f for f in filters if f.get('type')!='sort_type' and f.get('tags') not in ([], ['不限']) and not (f.get('type')=='filter_hot' and f.get('tags')==['综合'])]
        remaining.sort(key=lambda f:f.get('type',''))
        if query.get('sort') and sorts and direct != effective:
            raise ValueError('Conflicting sort')
    except (ValueError, TypeError, KeyError):
        effective = '__invalid_sort__'
        remaining = [{'type':'__invalid_filters__'}]
    result['query'] = [q for q in result.get('query', []) if q['name'] not in {'sort','filters'}] + [{'name':'sort','value':effective}, {'name':'filters','value':json.dumps(remaining,ensure_ascii=False,separators=(',',':'))}]
    return result

def verify_payload(operation, values, wire, contract):
    """Retain native HTTP/business success and entity validation."""
    body = wire.get('body')
    if wire.get('status') in {401, 403, 461, 471} or (isinstance(body, dict) and body.get('code') == 300011):
        raise CaptureError('LOGIN_OR_VERIFICATION_REQUIRED')
    if not isinstance(body, dict) or wire.get('status') != 200 or body.get(contract.get('success_code_key','code')) != 0 or body.get('success') is not True:
        raise CaptureError('NATIVE_API_BUSINESS_FAILURE')
    if wire.get('at_peek_limit'):
        raise CaptureError('CAPTURE_BODY_LIMIT')
    payload = body.get('data')
    if operation in {'image_detail', 'video_detail'}:
        if not isinstance(payload, list):
            raise CaptureError('NATIVE_DETAIL_SHAPE_MISMATCH')
        notes = [n for g in payload if isinstance(g,dict) for n in g.get('note_list',[]) if isinstance(n,dict)]
        if not any(n.get('id') == values.get('note_id') for n in notes):
            raise CaptureError('NATIVE_DETAIL_IDENTITY_MISMATCH')
    elif operation == 'comments':
        if not isinstance(payload,dict) or not isinstance(payload.get('comments'),list):
            raise CaptureError('NATIVE_COMMENT_SHAPE_MISMATCH')
        comments = [n for parent in payload['comments'] for n in [parent]+parent.get('sub_comments',[])]
        if any(n.get('note_id') != values.get('note_id') for n in comments):
            raise CaptureError('NATIVE_COMMENT_IDENTITY_MISMATCH')
    elif operation == 'user_info':
        if not isinstance(payload,dict) or payload.get('userid') != values.get('query',{}).get('user_id'):
            raise CaptureError('NATIVE_USER_IDENTITY_MISMATCH')
    elif operation == 'user_posted':
        if not isinstance(payload,dict) or not isinstance(payload.get('notes'),list) or any(n.get('user',{}).get('userid') != values.get('user_id') for n in payload['notes']):
            raise CaptureError('NATIVE_POSTED_IDENTITY_MISMATCH')
    elif operation == 'topic_feed':
        if not isinstance(payload,dict) or not isinstance(payload.get('notes'),list):
            raise CaptureError('NATIVE_TOPIC_SHAPE_MISMATCH')
    return body

class UiResponseCapture:
    def __init__(self, session, *, script_path=None, clock_ms=None, monotonic=time.monotonic):
        self.session = session
        self.script_path = Path(script_path or Path(__file__).with_name('observe-note-http.js'))
        self.clock_ms = clock_ms or (lambda: time.time()*1000)
        self.monotonic = monotonic

    def read(self, operation, contract, values, trigger, *, timeout=30, guard=lambda: None, valid_note_url=lambda u,n: False):
        if not 0 < timeout <= 300:
            raise ValueError('Invalid capture timeout')
        ready, changed = threading.Event(), threading.Event()
        responses, cronet, errors = [], [], []
        script = self.session.create_script(self.script_path.read_text('utf-8'))
        def receive(message, unused):
            payload = clean(message).get('payload',{})
            if message.get('type') == 'error':
                errors.append('CAPTURE_OBSERVER_FAILED'); ready.set()
            if payload.get('event') == 'observer_ready':
                ready.set()
            if payload.get('event') == 'response_json':
                responses.append(payload)
            if payload.get('event') == 'cronet_response_started':
                cronet.append(payload)
            changed.set()
        script.on('message', receive)
        try:
            guard();script.load()
            deadline = self.monotonic()+timeout
            while not ready.is_set():
                guard()
                if self.monotonic() >= deadline:
                    raise CaptureError('CAPTURE_OBSERVER_TIMEOUT')
                ready.wait(min(0.1,max(0,deadline-self.monotonic())))
            if errors:
                raise CaptureError(errors[0])
            script.exports_sync.allowpath(contract['path'])
            if operation in {'image_detail','video_detail'}:
                script.exports_sync.allowshare(values['note_id'],contract['path'])
            # Defaults inferred for direct API invocations are not UI controls.
            # Match only explicitly requested/validated fields; caller must first
            # confirm supported parameter translations, never silently drop them.
            matching_contract = copy.deepcopy(contract)
            matching_contract['parameters'] = [p for p in contract['parameters'] if p['name'] in values]
            start = self.clock_ms()
            guard();trigger()
            while True:
                guard()
                if errors:
                    raise CaptureError(errors[0])
                now = self.clock_ms()
                matching = [r for r in responses if isinstance(r.get('at'),(int,float)) and start <= r['at'] <= now and request_matches({**r,'request':semantic_request(r.get('request',{}),operation)},matching_contract,values)]
                if matching:
                    wire = matching[0]
                    body = verify_payload(operation,values,wire,contract)
                    lower = [e for e in cronet if request_target_matches(semantic_request(e.get('request',{}),operation),matching_contract,values)]
                    evidence = classify_transport(wire,start,now,lower)
                    result = {'operation':operation,'note_id':values.get('note_id'),'input':clean(values),
                              'response':body,'request':wire['request'],'status':wire['status'],
                              'captured_at_ms':wire['at'],'at_peek_limit':wire.get('at_peek_limit',False),
                              'transport_evidence':evidence,'trigger':'ui',
                              'action_started_at_ms':start,'action_finished_at_ms':now}
                    if operation=='search':
                        result['effective_sort']=next(q['value'] for q in semantic_request(wire['request'],operation)['query'] if q['name']=='sort')
                    if operation in {'image_detail','video_detail'}:
                        try:
                            link=script.exports_sync.takeshare(wire.get('observation_id'))
                        except Exception:
                            link=None
                        result=bridge_result(result,link,valid_note_url)
                    return result
                remaining=deadline-self.monotonic()
                if remaining<=0:
                    raise CaptureError('CAPTURE_TIMEOUT')
                changed.wait(min(0.1,remaining));changed.clear()
        finally:
            try:
                script.unload()
            except Exception:
                # The app can terminate after a verified response. Cleanup failure
                # must not discard the response or hide the original error.
                pass
