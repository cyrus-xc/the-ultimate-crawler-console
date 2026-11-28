package xiaohongshu

import (
	"context"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

// Searches and profile visits move through the site the way a person does:
// the search box and author links first, the site's own router next, and a
// document load only when neither is available. Each fallback is logged.

const visibleSearchBoxJS = `() => {
 const e=document.querySelector('#search-input');
 if(!e)return null;
 const r=e.getBoundingClientRect();
 return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight?e:null;
}`

const searchSettledJS = `(k,before) => {
 if(!location.pathname.startsWith('/search_result'))return false;
 if((new URLSearchParams(location.search).get('keyword')||'').trim()!==k.trim())return false;
 const f=window.__INITIAL_STATE__?.search?.feeds;const v=f?.value??f?._value??f;
 if(!Array.isArray(v))return false;
 return before===''||v.map(x=>x.id).join(',')!==before;
}`

// typeSearch submits keyword through the visible search box. It reports
// false, leaving the page usable, whenever the caller should load the URL.
func typeSearch(ctx context.Context, page *rod.Page, keyword string) bool {
	if noteOverlayOpen(page.Context(ctx)) {
		return false
	}
	box, err := page.Context(ctx).Timeout(3 * time.Second).ElementByJS(rod.Eval(visibleSearchBoxJS))
	if err != nil {
		return false
	}
	before := ""
	if onSearchListPage(ctx, page) {
		before = readFeedIDs(ctx, page)
	}
	humanize.Delay(ctx, humanize.BeforeClick)
	if err := humanize.Click(ctx, box); err != nil {
		return false
	}
	humanize.Delay(ctx, humanize.AfterClick)
	if _, err := box.Context(ctx).Eval(`function(){this.select()}`); err != nil {
		return false
	}
	if err := humanize.Type(ctx, box, keyword); err != nil {
		return false
	}
	humanize.Delay(ctx, humanize.BeforeSubmit)
	if err := page.Context(ctx).Keyboard.Type(input.Enter); err != nil {
		return false
	}
	if err := waitScript(ctx, page, navTimeout, searchSettledJS, keyword, before); err != nil {
		logrus.Warnf("[navigation] search box did not settle: %v", err)
		return false
	}
	return true
}

const profileLinkJS = `(uid) => [...document.querySelectorAll('a[href*="/user/profile/'+uid+'"]')].find(a=>{
 if(a.target==='_blank')return false;
 const r=a.getBoundingClientRect();
 return r.width>4&&r.height>4&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;
})||null`

// The site's Vue router, wherever the app is mounted.
const findRouterJS = `const findRouter=()=>{
 const fromApp=e=>e?.__vue_app__?.config?.globalProperties?.$router;
 let r=fromApp(document.querySelector('#app'));if(r)return r;
 for(const e of document.querySelectorAll('#app,#app>*,section.note-item,#global')){
  for(let c=e.__vueParentComponent;c;c=c.parent){r=c.appContext?.config?.globalProperties?.$router;if(r)return r;}
 }
 for(const e of document.querySelectorAll('body *')){r=fromApp(e);if(r)return r;}
 return null;
};`

const routerProfileJS = `async (uid,tok) => {` + findRouterJS + `
 const router=findRouter();
 if(!router?.push)return 'unavailable';
 const query=tok?{xsec_token:tok,xsec_source:'pc_note'}:{};
 await router.push({path:'/user/profile/'+uid,query});
 return 'pushed';
}`

// Fingerprint of the profile state on screen, so a router move is not taken
// as ready while the previous creator's state is still shown.
const profileFingerprintJS = `() => {
 if(!location.pathname.startsWith('/user/profile/'))return '';
 const u=window.__INITIAL_STATE__?.user;const unwrap=x=>x?.value??x?._value??x;
 const p=unwrap(u?.userPageData),notes=unwrap(u?.notes),active=unwrap(u?.activeTab)||{};
 const f=notes?.[active.index||0]||[];
 return (p?.basicInfo?.nickname||'')+'|'+(f[0]?.id||f[0]?.noteId||f[0]?.noteCard?.noteId||'');
}`

const profileSettledJS = `(uid,prev) => {
 if(location.pathname!=='/user/profile/'+uid)return false;
 const u=window.__INITIAL_STATE__?.user;if(!u)return false;
 const unwrap=x=>x?.value??x?._value??x;
 const p=unwrap(u.userPageData),notes=unwrap(u.notes),active=unwrap(u.activeTab)||{};
 const feeds=notes?.[active.index||0];
 if(!p?.basicInfo?.nickname||!Array.isArray(feeds))return false;
 if(feeds.length&&!feeds.some(f=>/^[a-fA-F0-9]{24}$/.test(f.id||f.noteId||f.noteCard?.noteId||'')))return false;
 const fp=p.basicInfo.nickname+'|'+(feeds[0]?.id||feeds[0]?.noteId||feeds[0]?.noteCard?.noteId||'');
 return prev===''||fp!==prev;
}`

// moveToProfile opens the notes tab of uid without a document load when the
// page allows it and reports how ("link", "router"), or "" to load the URL.
func moveToProfile(ctx context.Context, page *rod.Page, uid, token string) string {
	page = page.Context(ctx)
	if !onSiteSPA(ctx, page) || noteOverlayOpen(page) {
		return ""
	}
	if r, err := page.Timeout(2 * time.Second).Eval(`(uid) => location.pathname==='/user/profile/'+uid`, uid); err != nil || r.Value.Bool() {
		return "" // same creator again: a fresh load gives a clean grid
	}
	prev := ""
	if r, err := page.Timeout(2 * time.Second).Eval(profileFingerprintJS); err == nil {
		prev = r.Value.Str()
	}
	method := ""
	if link, err := page.Timeout(2 * time.Second).ElementByJS(rod.Eval(profileLinkJS, uid)); err == nil {
		humanize.Delay(ctx, humanize.BeforeClick)
		if humanize.Click(ctx, link) == nil {
			method = "link"
		}
	}
	if method == "" {
		r, err := page.Timeout(5*time.Second).Eval(routerProfileJS, uid, token)
		if err != nil || r.Value.Str() != "pushed" {
			return ""
		}
		method = "router"
	}
	if err := waitScript(ctx, page, navTimeout, profileSettledJS, uid, prev); err != nil {
		logrus.Warnf("[navigation] profile %s did not settle: %v", method, err)
		return ""
	}
	humanize.Delay(ctx, humanize.AfterNavigate)
	return method
}

func onSiteSPA(ctx context.Context, page *rod.Page) bool {
	r, err := page.Context(ctx).Timeout(2*time.Second).Eval(`() => {` + findRouterJS + `
	 return location.hostname+'|'+location.pathname.split('/')[1]+'|'+(findRouter()?'router':'none');}`)
	if err != nil {
		logrus.Infof("[navigation] spa check failed: %v", err)
		return false
	}
	state := r.Value.Str()
	if !strings.HasPrefix(state, "www.xiaohongshu.com|") || !strings.HasSuffix(state, "|router") {
		logrus.Infof("[navigation] no site router: %s", state)
		return false
	}
	return true
}

// waitScript polls script(args...) until it returns true, the page shows an
// access block, or timeout passes.
func waitScript(ctx context.Context, page *rod.Page, timeout time.Duration, script string, args ...any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		if err := checkAccess(page.Context(ctx)); err != nil {
			return err
		}
		if r, err := page.Context(ctx).Eval(script, args...); err == nil && r.Value.Bool() {
			return nil
		} else if err != nil && !strings.Contains(err.Error(), "Execution context was destroyed") && ctx.Err() == nil {
			// A route change can briefly drop the context; anything else is real.
			logrus.Debugf("[navigation] wait: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
