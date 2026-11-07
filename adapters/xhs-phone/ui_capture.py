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
    def __init__(self, code, diagnostics=None):
        super().__init__(code)
        self.diagnostics = diagnostics

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

def posted_page_groups(first_body, pages, first_cursor=None):
    """Partition observed pages without treating replay/gaps as cursor progress."""
    remaining=list(pages);following=[];previous=first_body
    visited={str(first_cursor)} if first_cursor is not None else set()
    while True:
        data=previous.get('data') or {};notes=data.get('notes') or []
        cursor=data.get('cursor') or data.get('start') or (notes[-1].get('cursor') if notes else None)
        if not cursor or str(cursor) in visited or data.get('has_more') is False:break
        visited.add(str(cursor))
        next_page=next((page for page in remaining if
            {q['name']:q['value'] for q in page.get('request',{}).get('query',[])}.get('cursor')==str(cursor)),None)
        if next_page is None:break
        next_data=next_page['response'].get('data') or {};next_notes=next_data.get('notes') or []
        next_cursor=next_data.get('cursor') or next_data.get('start') or (next_notes[-1].get('cursor') if next_notes else None)
        if next_cursor and str(next_cursor) in visited:break
        remaining.remove(next_page);following.append(next_page);previous=next_page['response']
    return following,remaining

class UiResponseCapture:
    def __init__(self, session, *, script_path=None, clock_ms=None, monotonic=time.monotonic):
        self.session = session
        self.script_path = Path(script_path or Path(__file__).with_name('observe-note-http.js'))
        self.clock_ms = clock_ms or (lambda: time.time()*1000)
        self.monotonic = monotonic

    def read(self, operation, contract, values, trigger, *, timeout=30, guard=lambda: None, valid_note_url=lambda u,n: False, related_contracts=None, notify_response=None):
        if not 0 < timeout <= 300:
            raise ValueError('Invalid capture timeout')
        ready, changed = threading.Event(), threading.Event()
        responses, cronet, errors, event_counts = [], [], [], {}
        clock_offset = [0]
        action_start = [None]
        notified = [False]
        script = self.session.create_script(self.script_path.read_text('utf-8'))
        def receive(message, unused):
            payload = clean(message).get('payload',{})
            if isinstance(payload.get('at'), (int,float)):
                payload['device_at_ms'] = payload['at']
                payload['at'] += clock_offset[0]
            transport = payload.get('transport')
            if isinstance(transport,dict):
                for key in ('sent_at_ms','received_at_ms'):
                    if isinstance(transport.get(key),(int,float)):
                        transport[key] += clock_offset[0]
            event = payload.get('event', 'unknown')
            event_counts[event] = event_counts.get(event, 0)+1
            if message.get('type') == 'error':
                errors.append('CAPTURE_OBSERVER_FAILED'); ready.set()
            if payload.get('event') == 'observer_ready':
                ready.set()
            if payload.get('event') == 'response_json':
                responses.append(payload)
                if notify_response and action_start[0] is not None and not notified[0] and payload.get('at',-1) >= action_start[0]:
                    if request_matches({**payload,'request':semantic_request(payload.get('request',{}),operation)},matching_contract,values):
                        notified[0] = True
                        notify_response()
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
            for extra in (related_contracts or {}).values():
                script.exports_sync.allowpath(extra['path'])
            if operation in {'image_detail','video_detail'}:
                script.exports_sync.allowshare(values['note_id'],contract['path'])
            # Defaults inferred for direct API invocations are not UI controls.
            # Match only explicitly requested/validated fields; caller must first
            # confirm supported parameter translations, never silently drop them.
            matching_contract = copy.deepcopy(contract)
            matching_contract['parameters'] = [p for p in contract['parameters'] if p['name'] in values]
            # Phone clocks are not necessarily host-synchronised. Compare action
            # boundaries in host time, while retaining the original device time.
            try:
                device_clock = getattr(script.exports_sync,'observerclock',None)
                if device_clock is None:
                    raise AttributeError('fixture has no device clock')
                before = self.clock_ms()
                device_now = device_clock()
                after = self.clock_ms()
                if isinstance(device_now, (int,float)):
                    clock_offset[0] = (before+after)/2-device_now
            except AttributeError:
                pass # Offline fixture scripts do not provide a device clock.
            # Drop every pre-action observation, including events received before
            # the clock calibration (a device clock ahead must not admit them).
            responses.clear();cronet.clear()
            start = self.clock_ms();action_start[0] = start
            def diagnostics():
                broad_values = copy.deepcopy(values)
                for key in ('cursor','start','page','page_context','search_id','search_session_id'):
                    broad_values.pop(key,None)
                    if isinstance(broad_values.get('query'),dict):broad_values['query'].pop(key,None)
                broad_contract = copy.deepcopy(matching_contract)
                broad_contract['parameters'] = [p for p in broad_contract['parameters'] if p['name'] in broad_values]
                return {'events':event_counts,'observed_requests':[
                    {'path':r.get('request',{}).get('path'),'host':r.get('request',{}).get('host'),'status':r.get('status'),
                     'query_names':[q.get('name') for q in r.get('request',{}).get('query',[])],
                     'requested_page_match':request_matches({**r,'request':semantic_request(r.get('request',{}),operation)},matching_contract,values),
                     'target_match_without_pagination':request_matches({**r,'request':semantic_request(r.get('request',{}),operation)},broad_contract,broad_values)}
                    for r in (responses+cronet)[:20]]}
            guard()
            try:trigger()
            except CaptureError as error:
                error.diagnostics=diagnostics()
                raise
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
                              'captured_at_ms':wire['at'],'device_captured_at_ms':wire.get('device_at_ms'),'observer_clock_offset_ms':clock_offset[0],'at_peek_limit':wire.get('at_peek_limit',False),
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
                    # App prefetch can load another page during one gesture.
                    # Preserve every matching target page observed by this action;
                    # no later cursor may silently hide an already loaded page.
                    if operation in {'search','user_posted','comments','topic_feed'}:
                        broad_values = copy.deepcopy(values)
                        for key in ('cursor','start','page','page_context','search_id','search_session_id'):
                            broad_values.pop(key,None)
                            if isinstance(broad_values.get('query'),dict):
                                broad_values['query'].pop(key,None)
                        broad_contract = copy.deepcopy(matching_contract)
                        broad_contract['parameters'] = [p for p in broad_contract['parameters'] if p['name'] in broad_values]
                        extras = []; related_errors=[]
                        for extra in responses:
                            if extra is wire or not isinstance(extra.get('at'),(int,float)) or not start <= extra['at'] <= now:
                                continue
                            if not request_matches({**extra,'request':semantic_request(extra.get('request',{}),operation)},broad_contract,broad_values):
                                continue
                            try:
                                extra_body=verify_payload(operation,broad_values,extra,contract)
                            except CaptureError as error:
                                related_errors.append(str(error));continue
                            extra_query=sorted((q['name'],q['value']) for q in extra.get('request',{}).get('query',[]))
                            extra_lower=[e for e in cronet if e.get('request',{}).get('path')==extra['request']['path'] and sorted((q['name'],q['value']) for q in e.get('request',{}).get('query',[]))==extra_query]
                            extras.append({'operation':operation,'input':clean(broad_values),'response':extra_body,'request':extra['request'],'status':extra['status'],'captured_at_ms':extra['at'],'device_captured_at_ms':extra.get('device_at_ms'),'observer_clock_offset_ms':clock_offset[0],'transport_evidence':classify_transport(extra,start,now,extra_lower),'trigger':'ui'})
                        if operation=='user_posted':
                            extras,replayed=posted_page_groups(body,extras,values.get('cursor'))
                            if replayed:result['replayed_pages']=replayed
                        if extras:result['related_pages']=extras
                        if related_errors:result['related_errors']=related_errors
                    # A profile navigation emits header and first notes in the
                    # same UI action. Preserve both rather than reopening the
                    # cached page and accidentally accepting its last cursor.
                    if operation == 'user_info' and related_contracts:
                        related_contract = copy.deepcopy(related_contracts.get('user_posted'))
                        if related_contract:
                            related_values = {'user_id': values.get('query', {}).get('user_id'), 'cursor': ''}
                            related_contract['parameters'] = [p for p in related_contract['parameters'] if p['name'] in related_values]
                            related_deadline = min(deadline, self.monotonic()+2)
                            while True:
                                guard()
                                candidates = [r for r in responses if isinstance(r.get('at'), (int,float)) and start <= r['at'] <= self.clock_ms() and request_matches(r, related_contract, related_values)]
                                if candidates:
                                    extra = candidates[0]
                                    extra_body = verify_payload('user_posted', related_values, extra, related_contract)
                                    extra_lower = [e for e in cronet if request_target_matches(e.get('request', {}), related_contract, related_values)]
                                    first = {'operation':'user_posted','input':related_values,'response':extra_body,'request':extra['request'],'status':extra['status'],'captured_at_ms':extra['at'],'transport_evidence':classify_transport(extra,start,self.clock_ms(),extra_lower),'trigger':'ui'}
                                    # Preserve all verified same-user observations, but only
                                    # contiguous successor cursors may advance pagination.
                                    broad_values={'user_id':related_values['user_id']}
                                    broad_contract=copy.deepcopy(related_contract)
                                    broad_contract['parameters']=[p for p in broad_contract['parameters'] if p['name']=='user_id']
                                    observed=[]
                                    for page in responses:
                                        if page is extra or not isinstance(page.get('at'),(int,float)) or not start<=page['at']<=self.clock_ms():continue
                                        if not request_matches(page,broad_contract,broad_values):continue
                                        try:page_body=verify_payload('user_posted',broad_values,page,related_contract)
                                        except CaptureError as error:
                                            first.setdefault('related_errors',[]).append(str(error));continue
                                        page_values={**broad_values,'cursor':{q['name']:q['value'] for q in page['request'].get('query',[])}.get('cursor')}
                                        lower=[e for e in cronet if request_target_matches(e.get('request',{}),related_contract,page_values)]
                                        observed.append({'operation':'user_posted','input':page_values,'response':page_body,'request':page['request'],
                                            'status':page['status'],'captured_at_ms':page['at'],
                                            'transport_evidence':classify_transport(page,start,self.clock_ms(),lower),'trigger':'ui'})
                                    pages,replayed=posted_page_groups(extra_body,observed,'')
                                    if pages:first['related_pages']=pages
                                    if replayed:first['replayed_pages']=replayed
                                    result['related']={'user_posted':first}
                                    break
                                if self.monotonic() >= related_deadline:
                                    break
                                changed.wait(min(.1, related_deadline-self.monotonic()));changed.clear()
                    return result
                remaining=deadline-self.monotonic()
                if remaining<=0:
                    raise CaptureError('CAPTURE_TIMEOUT', diagnostics())
                changed.wait(min(0.1,remaining));changed.clear()
        finally:
            try:
                script.unload()
            except Exception:
                # The app can terminate after a verified response. Cleanup failure
                # must not discard the response or hide the original error.
                pass
