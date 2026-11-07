package xiaohongshu

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

// Real navigation helpers, isolated localhost website, no login or XHS traffic.
func navigationFixture(t *testing.T) (*rod.Page, *atomic.Int32) {
	t.Helper()
	bin := os.Getenv("XHS_NAVIGATION_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_NAVIGATION_TEST_BROWSER for the localhost navigation regression")
	}
	var loads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/user/profile/") {
			loads.Add(1)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<style>body{margin:0}.note-item{height:150px}.note-detail-mask{position:fixed;inset:0;background:white;z-index:10}.close-circle{position:fixed;right:30px;top:30px}.share-icon-container{width:60px;height:40px}</style>
<a id="logo" href="/explore/" style="position:fixed;top:0;left:0;width:30px;height:30px;z-index:20">logo</a>
<div id="cards"></div><div class="note-detail-mask" style="display:none"><button class="close-circle" aria-label="关闭">X</button><div id="noteContainer"><button class="share-icon-container">share</button></div></div>
<script>
const uid='111111111111111111111111', listPath='/user/profile/'+uid;
window.__INITIAL_STATE__={user:{userPageData:{basicInfo:{nickname:'fixture'}},notes:[[]],activeTab:{index:0}},note:{noteDetailMap:{}}};
window.noteCloseCount=0;window.logoClicks=0;document.querySelector('#logo').onclick=()=>window.logoClicks++;
for(let i=1;i<=30;i++){
 const id=i.toString(16).padStart(24,'0');
 window.__INITIAL_STATE__.user.notes[0].push({id,noteCard:{noteId:id}});
 const section=document.createElement('section');section.className='note-item';
 section.innerHTML='<a class="cover" href="/explore/'+id+'?xsec_token=fixture">note '+i+'</a>';
 section.querySelector('a').onclick=e=>{e.preventDefault();window.currentNote=id;
  history.pushState({},'',e.currentTarget.getAttribute('href'));
  window.__INITIAL_STATE__.note.noteDetailMap[id]={note:{noteId:id,user:{userId:uid},desc:'body '+i,title:'fixture',createTime:1790000000000}};
  document.querySelector('.note-detail-mask').style.display='block';
 };document.querySelector('#cards').append(section);
}
document.querySelector('.close-circle').onclick=()=>{window.noteCloseCount++;document.querySelector('.note-detail-mask').style.display='none';history.pushState({},'',listPath);window.scrollTo(0,0)};
document.querySelector('.share-icon-container').onclick=()=>{let a=document.createElement('button');a.textContent='复制链接';a.onclick=()=>navigator.clipboard.writeText('https://www.xiaohongshu.com/discovery/item/'+window.currentNote+'?xsec_token=fixture');document.querySelector('#noteContainer').append(a)};
</script>`)
	}))
	// This disposable localhost fixture has no account data; hosted Linux CI
	// cannot provide Chromium's user-namespace sandbox.
	l := launcher.New().Bin(bin).Headless(true).NoSandbox(true).Leakless(false).UserDataDir(t.TempDir()).Set("no-proxy-server").Set("disable-background-networking")
	b := rod.New().ControlURL(l.MustLaunch()).MustConnect()
	t.Cleanup(func() { b.MustClose(); l.Cleanup(); srv.Close() })
	page := b.MustPage(srv.URL + "/user/profile/111111111111111111111111").MustWaitLoad()
	return page, &loads
}

func TestNavigationHiddenOverlayDoesNotClickLogo(t *testing.T) {
	page, loads := navigationFixture(t)
	closeNoteOverlay(context.Background(), page, strings.Repeat("2", 24))
	if loads.Load() != 1 || !page.MustEval(`() => location.pathname.startsWith('/user/profile/') && window.logoClicks===0`).Bool() {
		t.Fatal("closing an invisible note left the author list or clicked the logo")
	}
}

func TestNavigationConsecutiveDetailsKeepListAndPosition(t *testing.T) {
	page, loads := navigationFixture(t)
	for _, index := range []int{20, 21, 2} { // includes a priority candidate above the current position
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		_, err := ReadDetailEvidence(ctx, page, fmt.Sprintf("%024x", index), "fixture", -1, 1, strings.Repeat("1", 24))
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if loads.Load() != 1 || !page.MustEval(`() => location.pathname.startsWith('/user/profile/') && window.logoClicks===0 && document.querySelector('.note-detail-mask').style.display==='none'`).Bool() {
			t.Fatal("next detail lost the original list or failed to use its close control")
		}
		if index >= 20 && page.MustEval(`() => window.scrollY`).Int() < 1000 {
			t.Fatal("closing the note lost the list's scroll position")
		}
	}
	if page.MustEval(`() => window.noteCloseCount`).Int() != 3 {
		t.Fatal("each detail must close exactly once through X")
	}
}

func TestNavigationTimeoutStillClosesOwnNote(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(clickNoteCardJS, fmt.Sprintf("%024x", 20))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	method, restored := closeNoteOverlay(ctx, page, fmt.Sprintf("%024x", 20))
	if method != "close_button" || !restored || page.MustEval(`() => window.noteCloseCount`).Int() != 1 {
		t.Fatal("timed-out read left its note open or lost the list")
	}
}

func TestNavigationChoosesOnscreenNoteXInsteadOfOffscreenCloseIcon(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(`() => {
 const wrong=document.createElement('button');wrong.className='close-icon';
 wrong.style.cssText='position:fixed;left:1672px;top:40px;width:40px;height:40px';
 wrong.onclick=()=>window.wrongCloseClicks++;
 window.wrongCloseClicks=0;document.querySelector('.note-detail-mask').prepend(wrong);
 }`)
	page.MustEval(clickNoteCardJS, fmt.Sprintf("%024x", 20))
	method, restored := closeNoteOverlay(context.Background(), page, fmt.Sprintf("%024x", 20))
	if method != "close_button" || !restored || page.MustEval(`() => window.wrongCloseClicks`).Int() != 0 || page.MustEval(`() => window.noteCloseCount`).Int() != 1 {
		t.Fatal("an offscreen close icon displaced the note's actual X")
	}
}

func TestNavigationWaitsForDelayedNoteX(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(clickNoteCardJS, fmt.Sprintf("%024x", 20))
	page.MustEval(`() => {
 const x=document.querySelector('.close-circle');x.style.display='none';
 setTimeout(()=>x.style.display='',350);
 }`)
	method, restored := closeNoteOverlay(context.Background(), page, fmt.Sprintf("%024x", 20))
	if method != "close_button" || !restored || page.MustEval(`() => window.noteCloseCount`).Int() != 1 {
		t.Fatal("body-only reads must wait for the real note X before falling back")
	}
}

func TestNavigationWaitsForNoteCloseTransitionInsteadOfEscaping(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(clickNoteCardJS, fmt.Sprintf("%024x", 20))
	page.MustEval(`() => {
 document.querySelector('.close-circle').onclick=()=>{
  window.noteCloseCount++;
  setTimeout(()=>{
   document.querySelector('.note-detail-mask').style.display='none';
   history.pushState({},'', '/user/profile/111111111111111111111111');
  },600);
 };
 }`)
	method, restored := closeNoteOverlay(context.Background(), page, fmt.Sprintf("%024x", 20))
	if method != "close_button" || !restored || page.MustEval(`() => window.noteCloseCount`).Int() != 1 {
		t.Fatal("the note's close transition was mistaken for a failed X")
	}
}

func TestNavigationNestedGridPositionAndUpwardSeek(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(`() => { const c=document.querySelector('#cards');c.style.cssText='height:400px;overflow:auto'; }`)
	page.MustEval(clickNoteCardJS, fmt.Sprintf("%024x", 20))
	before := page.MustEval(`() => document.querySelector('#cards').scrollTop`).Int()
	page.MustEval(`() => document.querySelector('#cards').scrollTop=0`)
	_, restored := closeNoteOverlay(context.Background(), page, fmt.Sprintf("%024x", 20))
	if !restored || before < 1000 || page.MustEval(`() => document.querySelector('#cards').scrollTop`).Int() != before {
		t.Fatal("the nested scroll container did not return to its card position")
	}
	if page.MustEval(seekNoteJS, fmt.Sprintf("%024x", 2)).Num() >= 0 {
		t.Fatal("a priority note above the viewport must be sought upwards")
	}
}

func TestNavigationRouterFallbackKeepsDocument(t *testing.T) {
	page, loads := navigationFixture(t)
	page.MustEval(`() => {
 const app=document.createElement('div');app.id='app';document.body.append(app);
 app.__vue_app__={config:{globalProperties:{$router:{push:async route=>{
  history.pushState({},'',route.path+'?'+new URLSearchParams(route.query));
  document.querySelector('.note-detail-mask').style.display='block';
 }}}}};
}`)
	page.MustEval(rememberListJS)
	origin := documentOrigin(page)
	if page.MustEval(routerNoteJS, strings.Repeat("3", 24), "fixture").Str() != "clicked" {
		t.Fatal("the site's router was not used")
	}
	method, restored := closeNoteOverlay(context.Background(), page, strings.Repeat("3", 24))
	if method != "close_button" || !restored || loads.Load() != 1 || documentOrigin(page) != origin {
		t.Fatal("router fallback reloaded the document or lost the original list")
	}
}

func TestNavigationPreservesVerificationScreen(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(clickNoteCardJS, fmt.Sprintf("%024x", 20))
	page.MustEval(`() => history.pushState({},'', '/website-login/captcha')`)
	method, restored := closeNoteOverlay(context.Background(), page, fmt.Sprintf("%024x", 20))
	if method != "access_blocked" || restored || page.MustEval(`() => window.noteCloseCount`).Int() != 0 {
		t.Fatal("cleanup navigated away from the operator's verification screen")
	}
}
