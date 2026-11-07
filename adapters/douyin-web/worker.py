"""Private stdio worker. Every browser action waits for its lease owner admission."""
import json,sys,os,signal,time,re,base64
from urllib.parse import urlparse
from pathlib import Path
from douyin_web.browser import DouyinBrowser
from douyin_web.transport import Transport,ReadError
from douyin_web import guard
from login_diagnostics import LoginDiagnostics

def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)
def answer():
    line=sys.stdin.readline()
    if not line:raise ReadError('OWNER_DISCONNECTED','device')
    return json.loads(line)
def admission():
    emit({'type':'input'})
    if answer().get('action')!='continue':raise ReadError('STOP_REQUESTED','item')
def page(value):
    body=value.get('body',{})
    endpoint=('aweme_v1_web_aweme_detail' if 'aweme_detail' in body else
              'aweme_v1_web_user_profile_other' if 'user' in body else
              'aweme_v1_web_comment_list' if 'comments' in body else
              'aweme_v1_web_aweme_post' if 'aweme_list' in body else 'aweme_v1_web_search_item')
    value['records']=[{'endpoint':value.get('endpoint',endpoint),'body':body,'captured_at':value.get('observed_at',time.time()),'status':200}]
    emit({'type':'page','data':value})
    return answer().get('action','stop')
def shutdown(*_):raise KeyboardInterrupt()

def main():
    signal.signal(signal.SIGTERM,shutdown)
    browser=None
    login_diagnostics=LoginDiagnostics(os.environ.get('CRAWLER_RUNTIME_DIR','runtime'))
    try:
        while True:
            line=sys.stdin.readline()
            if not line:break
            request=json.loads(line)
            if request.get('type')=='close':break
            try:
                admission()
                if browser is None:
                    browser=DouyinBrowser(None,profile_dir=Path(os.environ['DOUYIN_BROWSER_PROFILE']));browser.__enter__()
                    browser.context.on('response',login_diagnostics.response)
                transport=Transport(browser,before_action=admission)
                operation=request['operation'];target=request['target'];params=request.get('params',{})
                if operation=='login_qr':
                    login_diagnostics.start()
                    if browser.is_logged_in():emit({'type':'qr','data':{'authenticated':True}});emit({'type':'done'});continue
                    admission()
                    if urlparse(browser.page.url).hostname not in ('www.douyin.com','douyin.com'):
                        browser.page.goto('https://www.douyin.com/',wait_until='domcontentloaded',timeout=30000)
                        browser.page.wait_for_timeout(1500)
                    admission()
                    if guard.check(browser.page,login_wall_is_block=False):raise ReadError('VERIFICATION_REQUIRED','platform')
                    import cv2,numpy as np
                    qr=None
                    for attempt in range(4):
                        admission()
                        if guard.check(browser.page,login_wall_is_block=False):raise ReadError('VERIFICATION_REQUIRED','platform')
                        for refresh_label in ('点击刷新','刷新二维码','刷新'):
                            refresh=browser.page.get_by_text(refresh_label,exact=True).first
                            if refresh.is_visible():admission();refresh.click(timeout=3000);browser.page.wait_for_timeout(500);break
                        scan_panel=browser.page.get_by_text('扫码登录',exact=True).first.is_visible()
                        if scan_panel:
                            data=browser.page.screenshot(type='png',animations='disabled',timeout=5000)
                            frame=cv2.imdecode(np.frombuffer(data,dtype=np.uint8),cv2.IMREAD_COLOR)
                            found,points=cv2.QRCodeDetector().detect(frame)
                            if found:
                                polygon=points[0]
                                evidence=browser.page.evaluate("""({x,y}) => {
                                  let node=document.elementFromPoint(x,y),ancestors=[];
                                  for(let i=0;node&&i<24;i++,node=node.parentElement){
                                    const r=node.getBoundingClientRect(),text=node.innerText||'';ancestors.push({tag:node.tagName,width:Math.round(r.width),height:Math.round(r.height),scan:text.includes('扫码登录'),sms:text.includes('验证码登录')});
                                    if(r.width>=400&&r.width<=1000&&r.height>=250&&r.height<=900&&text.includes('扫码登录')&&text.includes('验证码登录'))
                                      return {verified:true,context:'scan-login-dialog',tag:node.tagName,width:Math.round(r.width),height:Math.round(r.height)};
                                  }
                                  return {verified:false,ancestors,x,y,viewport:[innerWidth,innerHeight],ratio:devicePixelRatio};
                                }""",{'x':float(polygon[:,0].mean()),'y':float(polygon[:,1].mean())})
                                evidence_path=Path(os.environ.get('CRAWLER_RUNTIME_DIR','runtime'))/'douyin-login-qr-context.json'
                                evidence_path.write_text(json.dumps(evidence));evidence_path.chmod(0o600)
                                if not evidence.get('verified'):raise ReadError('LOGIN_QR_CONTEXT_UNVERIFIED','platform')
                                left=max(0,int(polygon[:,0].min())-12);top=max(0,int(polygon[:,1].min())-12)
                                right=min(frame.shape[1],int(polygon[:,0].max())+13);bottom=min(frame.shape[0],int(polygon[:,1].max())+13)
                                encoded=cv2.imencode('.png',frame[top:bottom,left:right])[1];qr=encoded.tobytes()
                        if qr is not None:break
                        if not scan_panel:
                            buttons=browser.page.get_by_text('登录',exact=True)
                            for button in buttons.all():
                                if button.is_visible():admission();button.click(timeout=5000);break
                        browser.page.wait_for_timeout(1500)
                    if qr is None:
                        diagnostic=Path(os.environ.get('CRAWLER_RUNTIME_DIR','runtime'))/'douyin-login-unavailable.png'
                        browser.page.screenshot(path=str(diagnostic));diagnostic.chmod(0o600)
                        raise ReadError('LOGIN_QR_UNAVAILABLE','platform')
                    emit({'type':'qr','data':{'authenticated':False,'png_base64':base64.b64encode(qr).decode()}});emit({'type':'done'});continue
                if operation=='resume':
                    for attempt in range(7):
                        admission()
                        wall=guard.check(browser.page,login_wall_is_block=False)
                        if wall and wall.get('kind') in ('identity_verification','captcha'):
                            login_diagnostics.wall(wall['kind'])
                            raise ReadError('VERIFICATION_REQUIRED','platform')
                        if browser.is_logged_in():break
                        if attempt==6:
                            state=browser.login_state();state['visible_login_buttons']=sum(button.is_visible() for button in browser.page.get_by_text('登录',exact=True).all())
                            state['wall']=(guard.check(browser.page) or {}).get('kind')
                            destination=Path(os.environ.get('CRAWLER_RUNTIME_DIR','runtime'))/'douyin-auth-state.json'
                            destination.write_text(json.dumps(state));destination.chmod(0o600)
                            browser.page.screenshot(path=str(destination.with_suffix('.png')));destination.with_suffix('.png').chmod(0o600)
                            raise ReadError('LOGIN_REQUIRED','platform')
                        browser.page.wait_for_timeout(500)
                    emit({'type':'done'});continue
                if operation=='desktop':
                    # A human must be able to see the existing verification UI.
                    # Focusing it must neither navigate away nor reject its wall.
                    browser.show_desktop(before_action=admission)
                    emit({'type':'done'});continue
                if operation=='link.resolve':
                    url=target['url'];parsed=urlparse(url)
                    if parsed.scheme!='https' or parsed.hostname not in ('v.douyin.com','www.douyin.com','douyin.com','www.iesdouyin.com'):raise ReadError('INVALID_OBSERVED_URL')
                    transport.goto(url)
                    browser.page.wait_for_timeout(1000)
                    resolved=browser.page.url;parts=urlparse(resolved)
                    if parts.hostname not in ('www.douyin.com','douyin.com','www.iesdouyin.com'):raise ReadError('INVALID_RESOLVED_URL')
                    match=re.search(r'/(?:video|note)/(\d+)',parts.path)
                    user=re.search(r'/user/([^/?]+)',parts.path)
                    data={'resolved_url':resolved}
                    if match:data['post_id']=match.group(1)
                    if user:data['user_id']=user.group(1)
                    page({'body':data,'items':[],'cursor':None,'has_more':False})
                elif operation=='post.detail':
                    body=transport.detail(target['post_id']);page({'body':body,'items':[body['aweme_detail']],'cursor':None,'has_more':False})
                elif operation=='profile.get':
                    transport.goto('https://www.douyin.com/user/'+target['user_id'])
                    body=transport.api('/aweme/v1/web/user/profile/other/',{'sec_user_id':target['user_id']})
                    if str((body.get('user') or {}).get('sec_uid'))!=target['user_id']:raise ReadError('PROFILE_IDENTITY_MISMATCH')
                    decision=page({'body':body,'items':[body['user']],'cursor':None,'has_more':False})
                    if decision!='stop' and body['user'].get('mix_count'):transport.mix_views(target['user_id'],on_page=page)
                elif operation=='search.posts':
                    transport.search(target['keyword'],max_items=params.get('max_items',50),max_pages=request['limits']['max_pages'],sort=params.get('sort'),filters=params.get('filters'),on_page=page)
                else:
                    if params.get('include_replies'):raise ReadError('UNSUPPORTED_REPLY_COLLECTION')
                    transport.pages(operation,target,max_items=params.get('max_items',50),max_pages=request['limits']['max_pages'],cursor=request.get('cursor') or 0,on_page=page,include_profile=operation=='profile.posts')
                emit({'type':'done'})
            except Exception as exc:
                if request.get('operation')=='login_qr':
                    import traceback
                    diagnostic=Path(os.environ.get('CRAWLER_RUNTIME_DIR','runtime'))/'douyin-login-error.json'
                    diagnostic.write_text(json.dumps({'type':type(exc).__name__,'frames':[{'name':f.name,'line':f.lineno} for f in traceback.extract_tb(exc.__traceback__)]}))
                    diagnostic.chmod(0o600)
                    if browser is not None:
                        try:
                            screenshot=diagnostic.with_suffix('.png');browser.page.screenshot(path=str(screenshot));screenshot.chmod(0o600)
                        except Exception:pass
                code=getattr(exc,'code',None)
                if code is None:code=str(exc) if re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}',str(exc)) else 'DOUYIN_READ_FAILED'
                emit({'type':'error','code':code,'scope':getattr(exc,'scope','device')})
    finally:
        if browser is not None:browser.__exit__(None,None,None)
if __name__=='__main__':
    try:main()
    except (KeyboardInterrupt,BrokenPipeError):pass
