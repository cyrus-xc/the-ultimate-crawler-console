"""Private stdio protocol for the passive observer; no App API invocation."""
import argparse
import json
import re
import sys
import threading
from pathlib import Path
from ui_capture import UiResponseCapture, CaptureError
from note_links import valid_note_url

emit_lock=threading.Lock()
def emit(value):
    with emit_lock:
        print(json.dumps(value,ensure_ascii=False),flush=True)

def error_event(error, stage):
    code=str(error)
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}',code):code='CAPTURE_FAILED'
    return {'event':'error','code':code,'diagnostics':{'exception_type':type(error).__name__,'stage':stage,**(getattr(error,'diagnostics',None) or {})}}

def load_contract(path, frida_version):
    contract=json.loads(Path(path).read_text())
    if frida_version!=contract['frida_version']:
        raise RuntimeError('FRIDA_VERSION_MISMATCH')
    return contract

def attach(frida, endpoint, pid):
    if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}',endpoint) or pid<=0:
        raise RuntimeError('INVALID_CAPTURE_TARGET')
    remote=frida.get_device_manager().add_remote_device(endpoint)
    # Never enumerate processes: Frida resolves their display names by
    # injecting an agent into system_server, which crashed Android twice
    # (JNI "accessed deleted Global", 2026-11-20 and 2026-11-27). Attach by
    # pid; the observer reports the attached App package before any capture.
    try:
        return remote.attach(pid)
    except frida.ProcessNotFoundError:
        raise RuntimeError('APP_MAIN_PROCESS_MISMATCH')

def run_capture(session, contract, operation_name, values, *, timeout, private_media, read_line):
    """One UI-triggered capture over an attached session (fresh or persistent)."""
    if not isinstance(values,dict):raise RuntimeError('INVALID_CAPTURE_INPUT')
    operation=contract['operations'].get(operation_name)
    if not operation:raise RuntimeError('UNSUPPORTED_OPERATION')
    def trigger():
        emit({'event':'perform_action'})
        action=json.loads(read_line())
        if action.get('action')=='failed' and action.get('code') in {'PHONE_FIRST_PAGE_UNOBSERVED','PHONE_PAGE_RESPONSE_UNOBSERVED'}:
            raise CaptureError(action['code'])
        if action.get('action')!='done':
            raise RuntimeError('ACTION_NOT_CONFIRMED')
    related={'user_posted':contract['operations']['user_posted']} if operation_name=='user_info' else ({name:value for name,value in contract['operations'].items() if name in {'image_detail','video_detail'} and name!=operation_name} if operation_name in {'image_detail','video_detail'} else None)
    if operation_name in {'image_detail','video_detail'} and values.get('observe_initial_comments') is True:
        related['comments'] = contract['operations']['comments']
    return UiResponseCapture(session).read(operation_name,operation,values,trigger,timeout=timeout,private_media_enabled=private_media,valid_note_url=valid_note_url,related_contracts=related,notify_response=lambda:emit({'event':'response_ready'}))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--contract',required=True)
    parser.add_argument('--endpoint',required=True)
    parser.add_argument('--pid',type=int,required=True)
    parser.add_argument('--operation',required=True)
    parser.add_argument('--private-media',action='store_true')
    parser.add_argument('--timeout',type=float,default=45)
    args=parser.parse_args()
    session=None
    stage='configuration'
    try:
        import frida
        contract=load_contract(args.contract,frida.__version__)
        if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}',args.endpoint) or args.pid<=0:
            raise RuntimeError('INVALID_CAPTURE_TARGET')
        values=json.loads(sys.stdin.readline())
        if not isinstance(values,dict):raise RuntimeError('INVALID_CAPTURE_INPUT')
        if not contract['operations'].get(args.operation):raise RuntimeError('UNSUPPORTED_OPERATION')
        stage='attachment'
        session=attach(frida,args.endpoint,args.pid)
        # Frida process display names need not be Android package identifiers.
        # Verify the attached process from read-only Android application metadata.
        checked=threading.Event();packages=[]
        identity=session.create_script("Java.perform(function(){ const app=Java.use('android.app.ActivityThread').currentApplication(); send({package:app ? String(app.getPackageName()) : null}); });")
        def identify(message, data):
            if message.get('type')=='send':packages.append((message.get('payload') or {}).get('package'))
            checked.set()
        identity.on('message',identify)
        try:
            identity.load()
            if not checked.wait(5) or packages!=[contract['package']]:
                raise RuntimeError('APP_MAIN_PROCESS_MISMATCH')
        finally:
            identity.unload()
        stage='capture'
        result=run_capture(session,contract,args.operation,values,timeout=args.timeout,private_media=args.private_media,read_line=sys.stdin.readline)
        emit({'event':'result','result':result})
        return 0
    except Exception as error:
        emit(error_event(error,stage))
        return 1
    finally:
        if session is not None:
            try:session.detach()
            except Exception:pass

if __name__=='__main__':sys.exit(main())
