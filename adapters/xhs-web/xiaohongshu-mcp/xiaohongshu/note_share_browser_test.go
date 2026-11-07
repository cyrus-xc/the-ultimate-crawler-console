//go:build integration

package xiaohongshu

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

// Exercises the real browser JS against a local, deterministic note page.
// No XHS requests, saved login, clipboard writes or paid network.
func TestCaptureNoteShareBrowser(t *testing.T) {
	bin := os.Getenv("XHS_SHARE_TEST_CHROME")
	if bin == "" {
		t.Skip("set XHS_SHARE_TEST_CHROME to an installed Chrome binary")
	}
	id := "aaaaaaaaaaaaaaaaaaaaaaaa"
	link := "https://www.xiaohongshu.com/discovery/item/" + id + "?source=webshare&xsec_token=fixture%3D&xsec_source=pc_share"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<div id="noteContainer"><button class="share-icon">header</button><div class="share-wrapper"><div class="share-icon-container"><svg width="40" height="40"></svg></div></div></div>
<script>
window.__INITIAL_STATE__={note:{noteDetailMap:{'%s':{note:{noteId:'%s',desc:'body'}}}}};
window.clipboardWrites=0;
navigator.clipboard.writeText=async()=>{window.clipboardWrites++};
window.originalClipboard=navigator.clipboard.writeText;
window.originalExec=document.execCommand;
window.headerClicks=0;document.querySelector('button').onclick=()=>window.headerClicks++;
document.querySelector('.share-icon-container').onclick=()=>{
 const copy=document.createElement('div');copy.innerHTML='<p>复制链接</p>';
 copy.onclick=()=>{
  if(location.search.includes('exec')){
   const input=document.createElement('textarea');input.value='%s';document.body.append(input);input.focus();input.select();document.execCommand('copy');input.remove();
  }else navigator.clipboard.writeText('note title %s 复制');
 };document.querySelector('#noteContainer').append(copy);
};
</script>`, id, id, link, link)
	}))
	defer server.Close()
	l := launcher.New().Bin(bin).Headless(true).UserDataDir(t.TempDir()).Set("disable-background-networking").Set("no-first-run")
	endpoint, err := l.Launch()
	if err != nil {
		t.Fatal(err)
	}
	b := rod.New().ControlURL(endpoint).MustConnect()
	defer func() { b.MustClose(); l.Cleanup() }()
	for _, suffix := range []string{"", "?exec"} {
		page := b.MustPage(server.URL + "/explore/" + id + suffix)
		page.MustWaitLoad()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		got, status := captureNoteShare(ctx, page, id)
		cancel()
		if got != link || status != "captured" {
			t.Fatalf("share capture failed: status=%s", status)
		}
		if !page.MustEval(`() => window.headerClicks===0 && window.clipboardWrites===0 && navigator.clipboard.writeText===window.originalClipboard && document.execCommand===window.originalExec`).Bool() {
			t.Fatal("clipboard was touched or capture hooks were not restored")
		}
		got, status = captureNoteShare(context.Background(), page, "bbbbbbbbbbbbbbbbbbbbbbbb")
		if got != "" || status != "note_identity_mismatch" {
			t.Fatal("accepted another note")
		}
		page.MustClose()
	}
}
