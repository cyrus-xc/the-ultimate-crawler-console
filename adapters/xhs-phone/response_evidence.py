"""Preserved response interpretation from android-lab capture-native-note.py.

No active App API agent is loaded by this module.
"""
import copy
import json
from urllib.parse import parse_qs, urlsplit
from runtime_redaction import clean

def bridge_result(result, link, valid_note_url):
    """Restore only an observed, identity-bound note link in the private pipe copy."""
    output = copy.deepcopy(result)
    nid = result.get('note_id')
    if result.get('operation') not in {'image_detail', 'video_detail'} or not valid_note_url(link, nid):
        return output
    parsed = urlsplit(link)
    # Short links require resolution and cannot establish this note's identity.
    if parsed.hostname not in {'www.xiaohongshu.com', 'xiaohongshu.com'}:
        return output
    token = parse_qs(parsed.query).get('xsec_token', [''])[0]
    if token.strip('[]<>').upper() == 'REDACTED':
        return output
    payload = output.get('response', {}).get('data')
    actual_operation=output.get('response_operation') or output.get('operation')
    notes = [note for group in payload if isinstance(group, dict)
             for note in ([group] if actual_operation=='video_detail' else group.get('note_list', [])) if isinstance(note, dict) and note.get('id') == nid] if isinstance(payload, list) else []
    if len(notes) == 1:
        notes[0]['share_info'] = {**(notes[0].get('share_info') or {}), 'link': link}
    return output

def request_matches(wire, contract, values):
    """Match the requested page/filters, not an incidental same-note response."""
    request = wire.get('request',{})
    if request.get('method') != contract['http_method']:
        return False
    return request_target_matches(request,contract,values)

def request_target_matches(request,contract,values):
    if request.get('path') != contract['path'] or request.get('host') not in contract['allowed_hosts']:
        return False
    actual={q['name']:q['value'] for q in request.get('query',[])}
    for definition in contract['parameters']:
        name=definition['name']
        value=values.get(name,definition.get('default'))
        if value is None or name in {'session_id','request_tag'}:
            continue
        if definition['type'] == 'java.util.Map':
            for key,item in value.items():
                expected=json.dumps(item) if type(item) is bool else str(item)
                if actual.get(key) != clean(expected):
                    return False
            continue
        expected=json.dumps(value) if type(value) is bool else str(value)
        if actual.get(name) != clean(expected):
            return False
    return True

def classify_transport(wire, invocation_started_at_ms, invocation_finished_at_ms=None, cronet_events=None):
    """Only claim a fresh roundtrip from affirmative, invocation-bound evidence."""
    transport = wire.get('transport') or {}
    observed = wire.get('at')
    in_window = isinstance(observed,(int,float)) and observed >= invocation_started_at_ms
    if invocation_finished_at_ms is not None:
        in_window = in_window and observed <= invocation_finished_at_ms
    sent, received = transport.get('sent_at_ms'), transport.get('received_at_ms')
    timed = (isinstance(sent,(int,float)) and isinstance(received,(int,float))
             and invocation_started_at_ms <= sent <= received <= observed) if in_window else False
    network, cache = transport.get('network_response_present'), transport.get('cache_response_present')
    lower = [event for event in (cronet_events or []) if
             event.get('event') == 'cronet_response_started' and
             invocation_started_at_ms <= event.get('at',-1) <= observed and
             event.get('status') == wire.get('status')] if in_window else []
    # Caller already matched host/path and every declared query parameter.
    native = lower[-1] if len(lower) == 1 else None
    if not in_window:
        state = 'outside_invocation'
    elif native and native.get('was_cached') is False:
        state = 'fresh_cronet_network_response'
    elif native and native.get('was_cached') is True:
        state = 'app_http_cache_response'
    elif network is True and timed:
        state = 'fresh_network_revalidation' if cache is True else 'fresh_network_response'
    elif cache is True and network is False:
        state = 'app_http_cache_response'
    else:
        state = 'unknown'
    return {'classification':state,'observed_during_invocation':in_window,
            'fresh_server_roundtrip_observed':state in {'fresh_network_response','fresh_network_revalidation','fresh_cronet_network_response'},
            'basis':'Native Cronet cache flag when uniquely correlated; otherwise OkHttp response metadata',
            'transport':transport,'cronet_response':native,'matching_cronet_callbacks':len(lower)}
