"""Bounded reads using the existing signed browser fetch and response recorder."""
import time
from urllib.parse import urlencode, quote
from .fetch_script import FETCH_JS
from . import guard

class ReadError(RuntimeError):
    def __init__(self,code,scope='item'):
        super().__init__(code);self.code=code;self.scope=scope

class Transport:
    COMMON_PARAMS={'device_platform':'webapp','aid':'6383','channel':'channel_pc_web'}
    def __init__(self,browser,*,before_action=lambda:None,fetch_gap_seconds=2):
        self.browser=browser;self.before_action=before_action;self.fetch_gap_seconds=fetch_gap_seconds;self.last_fetch=0

    def check(self):
        self.before_action()
        hit=guard.check(self.browser.page)
        if hit:
            raise ReadError({'captcha':'VERIFICATION_REQUIRED','login_wall':'LOGIN_REQUIRED'}.get(hit['kind'],'PLATFORM_UNAVAILABLE'),'platform')

    def goto(self,url):
        self.check();self.browser.page.goto(url,wait_until='domcontentloaded',timeout=30000);self.check()

    def api(self,path,params):
        self.check()
        wait=self.fetch_gap_seconds-(time.monotonic()-self.last_fetch)
        if wait>0:self.browser.page.wait_for_timeout(wait*1000)
        self.check()
        response=self.browser.page.evaluate(FETCH_JS,path+'?'+urlencode({**self.COMMON_PARAMS,**params}))
        self.last_fetch=time.monotonic()
        body=response.get('body')
        if response.get('status')!=200 or not isinstance(body,dict) or body.get('status_code') not in (None,0):
            raise ReadError('UPSTREAM_REJECTED','platform')
        return body

    def detail(self,post_id):
        self.goto('https://www.douyin.com/video/'+quote(post_id,safe=''))
        body=self.api('/aweme/v1/web/aweme/detail/',{'aweme_id':post_id})
        detail=body.get('aweme_detail') or {}
        if str(detail.get('aweme_id',''))!=post_id:raise ReadError('POST_IDENTITY_MISMATCH')
        return body

    def pages(self,operation,target,*,max_items,max_pages,cursor=0,on_page=lambda page:None,include_profile=False):
        if operation not in {'profile.posts','post.comments'}:raise ReadError('UNSUPPORTED_OPERATION')
        if not isinstance(max_items,int) or max_items<1 or not isinstance(max_pages,int) or max_pages<1:raise ReadError('INVALID_LIMIT')
        is_profile=operation=='profile.posts';key='user_id' if is_profile else 'post_id'
        identity=target[key]
        self.goto('https://www.douyin.com/'+('user/' if is_profile else 'video/')+quote(identity,safe=''))
        seen=set();pages=[];more=True;stop='page_limit'
        if is_profile and include_profile:
            profile=self.api('/aweme/v1/web/user/profile/other/',{'sec_user_id':identity})
            if str((profile.get('user') or {}).get('sec_uid'))!=identity:raise ReadError('PROFILE_IDENTITY_MISMATCH')
            if on_page({'request_params':{'sec_user_id':identity},'body':profile,'items':[profile['user']],'cursor':cursor,'has_more':True,'page_index':0,'observed_at':time.time()})=='stop':
                return {'pages':[],'coverage':{'unique':0,'pages':0,'stop_reason':'client_stopped','end_observed':False}}
        for index in range(max_pages):
            if is_profile:
                request_params={'sec_user_id':identity,'max_cursor':cursor}
                body=self.api('/aweme/v1/web/aweme/post/',{**request_params,'count':18,'locate_query':'false','show_live_replay_strategy':1})
                items=body.get('aweme_list') or [];next_cursor=body.get('max_cursor');item_key='aweme_id'
                # Co-created posts may have a different author. The validated
                # profile request owns this list; retain its identity separately.

            else:
                request_params={'aweme_id':identity,'cursor':cursor}
                body=self.api('/aweme/v1/web/comment/list/',{**request_params,'count':min(50,max_items-len(seen)),'item_type':0})
                items=body.get('comments') or [];next_cursor=body.get('cursor');item_key='cid'
                if any(i.get('aweme_id') is not None and str(i['aweme_id'])!=identity for i in items):raise ReadError('COMMENT_IDENTITY_MISMATCH')
            if any(not i.get(item_key) for i in items):raise ReadError('ITEM_IDENTITY_MISSING')
            seen.update(str(i[item_key]) for i in items)
            more=bool(body.get('has_more'));stalled=more and (next_cursor is None or next_cursor==cursor)
            page={'request_params':request_params,'body':body,'items':items,'cursor':next_cursor,'has_more':more,'page_index':index+1,'observed_at':time.time()}
            decision=on_page(page);pages.append(page)
            if decision=='stop':stop='client_stopped';break
            if not more:stop='end_observed';break
            if len(seen)>=max_items:stop='item_limit';break
            if stalled:stop='cursor_stalled';break
            cursor=next_cursor
        return {'pages':pages,'coverage':{'unique':len(seen),'pages':len(pages),'stop_reason':stop,'end_observed':not more}}

    def search(self,keyword,*,max_items,max_pages,sort=None,filters=None,on_page=lambda page:None):
        from urllib.parse import urlparse,parse_qs
        sorts={None:'0','综合':'0','最新':'2','最多点赞':'1'}
        if sort not in sorts:raise ReadError('UNSUPPORTED_SORT')
        allowed={'publish_time','filter_duration','search_range'}
        filters=filters or {}
        if set(filters)-allowed:raise ReadError('UNSUPPORTED_FILTER')
        expected={'sort_type':sorts[sort],**{k:str(v) for k,v in filters.items()}}
        pending=[]
        def capture(response):
            parsed=urlparse(response.url)
            if parsed.hostname!='www.douyin.com' or not parsed.path.endswith('/search/item/'):return
            query=parse_qs(parsed.query)
            if query.get('keyword')!=[keyword]:return
            for key,value in expected.items():
                if query.get(key,['0'])!=[value]:return
            try:body=response.json()
            except Exception:return
            request_params={k:query[k][0] for k in ('keyword','cursor','offset','sort_type','publish_time','filter_duration','search_range') if query.get(k)}
            pending.append((body,request_params))
        self.browser.page.on('response',capture)
        seen=set()
        try:
            self.goto('https://www.douyin.com/search/'+quote(keyword,safe='')+'?'+urlencode({'type':'video',**expected}))
            for index in range(max_pages):
                self.check()
                for wait_index in range(20):
                    if pending:break
                    self.before_action()
                    self.browser.page.wait_for_timeout(500)
                batch=list(pending);pending.clear()
                for body,request_params in batch:
                    if body.get('status_code') not in (None,0):raise ReadError('UPSTREAM_REJECTED','platform')
                    items=[d['aweme_info'] for d in body.get('data') or [] if isinstance(d,dict) and d.get('aweme_info')]
                    if any(not item.get('aweme_id') for item in items):raise ReadError('ITEM_IDENTITY_MISSING')
                    seen.update(str(item['aweme_id']) for item in items)
                    more=bool(body.get('has_more',True))
                    decision=on_page({'endpoint':'aweme_v1_web_search_item','request_params':request_params,'body':body,'items':items,'cursor':body.get('cursor'),'has_more':more,'page_index':index+1,'observed_at':time.time()})
                    if decision=='stop' or not more or len(seen)>=max_items:return
                if index+1<max_pages:
                    self.check();self.browser.page.mouse.wheel(0,900)
            if not seen:raise ReadError('SEARCH_RESPONSE_UNAVAILABLE','platform')
        finally:self.browser.page.remove_listener('response',capture)

    def mix_views(self,user_id,*,max_mixes=5,max_videos=60,on_page=lambda page:None):
        body=self.api('/aweme/v1/web/mix/list/',{'sec_user_id':user_id,'req_from':'channel_pc_web','cursor':0,'count':12})
        if on_page({'endpoint':'aweme_v1_web_mix_list','request_params':{'sec_user_id':user_id,'cursor':0},'body':body,'items':[],'cursor':'mix-list','has_more':True})=='stop':return
        seen=0
        for mix in (body.get('mix_infos') or [])[:max_mixes]:
            cursor=0
            while seen<max_videos:
                body=self.api('/aweme/v1/web/mix/aweme/',{'mix_id':mix['mix_id'],'cursor':cursor,'count':20})
                items=body.get('aweme_list') or []
                seen+=sum(1 for item in items if (item.get('statistics') or {}).get('play_count'))
                next_cursor=body.get('cursor',cursor+20)
                if on_page({'endpoint':'aweme_v1_web_mix_aweme','request_params':{'mix_id':mix['mix_id'],'cursor':cursor},'body':body,'items':items,'cursor':'mix:'+str(mix['mix_id'])+':'+str(next_cursor),'has_more':bool(body.get('has_more'))})=='stop':return
                if not body.get('has_more') or next_cursor==cursor:break
                cursor=next_cursor
