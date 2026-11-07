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

    def pages(self,operation,target,*,max_items,max_pages,cursor=0,on_page=lambda page:None):
        if operation not in {'profile.posts','post.comments'}:raise ReadError('UNSUPPORTED_OPERATION')
        if not isinstance(max_items,int) or max_items<1 or not isinstance(max_pages,int) or max_pages<1:raise ReadError('INVALID_LIMIT')
        is_profile=operation=='profile.posts';key='user_id' if is_profile else 'post_id'
        identity=target[key]
        self.goto('https://www.douyin.com/'+('user/' if is_profile else 'video/')+quote(identity,safe=''))
        seen=set();pages=[];more=True;stop='page_limit'
        for index in range(max_pages):
            if is_profile:
                body=self.api('/aweme/v1/web/aweme/post/',{'sec_user_id':identity,'max_cursor':cursor,'count':18,'locate_query':'false','show_live_replay_strategy':1})
                items=body.get('aweme_list') or [];next_cursor=body.get('max_cursor');item_key='aweme_id'
                if any((i.get('author') or {}).get('sec_uid')!=identity for i in items):raise ReadError('PROFILE_IDENTITY_MISMATCH')
            else:
                body=self.api('/aweme/v1/web/comment/list/',{'aweme_id':identity,'cursor':cursor,'count':min(50,max_items-len(seen)),'item_type':0})
                items=body.get('comments') or [];next_cursor=body.get('cursor');item_key='cid'
                if any(i.get('aweme_id') is not None and str(i['aweme_id'])!=identity for i in items):raise ReadError('COMMENT_IDENTITY_MISMATCH')
            if any(not i.get(item_key) for i in items):raise ReadError('ITEM_IDENTITY_MISSING')
            seen.update(str(i[item_key]) for i in items)
            more=bool(body.get('has_more'));stalled=more and (next_cursor is None or next_cursor==cursor)
            page={'body':body,'items':items,'cursor':next_cursor,'has_more':more,'page_index':index+1,'observed_at':time.time()}
            on_page(page);pages.append(page)
            if not more:stop='end_observed';break
            if len(seen)>=max_items:stop='item_limit';break
            if stalled:stop='cursor_stalled';break
            cursor=next_cursor
        return {'pages':pages,'coverage':{'unique':len(seen),'pages':len(pages),'stop_reason':stop,'end_observed':not more}}
