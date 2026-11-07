package xiaohongshu

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-rod/rod"
)

// Capture the website's actual Copy link output. No system clipboard reads or
// writes, no share-to-friend action, and no synthesized URL from a route token.
const copyNoteShareJS = `async (id) => {
 const visible=e=>!!(e&&e.getClientRects().length);
 const note=window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note;
 const route=location.pathname.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/i);
 if(!note||note.noteId!==id||!route||route[1]!==id) return 'ERROR:note_identity_mismatch';
 const root=document.querySelector('#noteContainer, .note-detail-mask, .note-container');
 if(!root) return 'ERROR:share_root_missing';
 let copied='';
 const oldExec=document.execCommand;
 const clipboard=navigator.clipboard;
 const oldDescriptor=clipboard&&Object.getOwnPropertyDescriptor(clipboard,'writeText');
 const onCopy=e=>{ copied=e.clipboardData?.getData('text/plain')||copied; e.preventDefault(); };
 let overridden=false;
 try{
  if(clipboard){Object.defineProperty(clipboard,'writeText',{configurable:true,value:async text=>{copied=String(text)}});overridden=true;}
  document.execCommand=function(command,...args){
   if(String(command).toLowerCase()==='copy'){
    const a=document.activeElement;
    copied=(a&&['TEXTAREA','INPUT'].includes(a.tagName)?a.value:String(window.getSelection()))||copied;
    return true;
   }
   return oldExec.call(document,command,...args);
  };
  document.addEventListener('copy',onCopy,true);
  const icons=[...root.querySelectorAll('svg use')];
  const icon=icons.find(e=>/#share(?:$|[-_])/.test(e.getAttribute('href')||e.getAttribute('xlink:href')||''));
  const trigger=root.querySelector('.share-icon-container')||root.querySelector('.share-wrapper')||root.querySelector('button.share-icon')||
    (icon&&icon.closest('.share-wrapper, .share-container, button, [role=button]'))||
    [...root.querySelectorAll('[aria-label], [title]')].find(e=>['分享','Share'].includes(e.getAttribute('aria-label')||e.getAttribute('title')))||
    (icon&&icon.closest('svg')?.parentElement);
  if(!visible(trigger)) return 'ERROR:share_control_missing';
  trigger.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
  trigger.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
  const copyControl=()=>[...document.querySelectorAll('button, [role=button], li, div, span, p, a')].find(e=>
    visible(e)&&['复制链接','Copy link'].includes(e.textContent.trim())&&
    ![...e.children].some(c=>['复制链接','Copy link'].includes(c.textContent.trim())));
  await new Promise(r=>setTimeout(r,200));
  if(!copyControl()) trigger.click();
  const end=Date.now()+5000;
  let clicked=false;
  while(Date.now()<end){
   if(!clicked){
    const copy=copyControl();
    if(copy){copy.click();clicked=true;}
   }
   if(copied) return copied;
   await new Promise(r=>setTimeout(r,100));
  }
  return clicked ? 'ERROR:copy_output_missing' : 'ERROR:copy_control_missing';
 }catch(e){return 'ERROR:copy_capture_failed';
 }finally{
  document.execCommand=oldExec;
  document.removeEventListener('copy',onCopy,true);
  if(overridden){if(oldDescriptor)Object.defineProperty(clipboard,'writeText',oldDescriptor);else delete clipboard.writeText;}
  triggerCleanup();
 }
 function triggerCleanup(){
  const e=root.querySelector('.share-wrapper, .share-container');
  if(e)e.dispatchEvent(new MouseEvent('mouseleave',{bubbles:true}));
 }
}`

var shareTextURL = regexp.MustCompile(`https?://[^\s<>"']+`)

func matchingNoteShare(text, id string) string {
	for _, candidate := range shareTextURL.FindAllString(text, -1) {
		u, err := url.Parse(candidate)
		if err != nil || u.User != nil || (u.Port() != "" && u.Port() != "80" && u.Port() != "443") {
			continue
		}
		if u.Hostname() != "www.xiaohongshu.com" && u.Hostname() != "xiaohongshu.com" {
			continue // An opaque short link cannot be matched to this note offline.
		}
		if strings.TrimSuffix(u.Path, "/") != "/discovery/item/"+id && strings.TrimSuffix(u.Path, "/") != "/explore/"+id {
			continue
		}
		if token := u.Query().Get("xsec_token"); token != "" && token != "REDACTED" {
			return candidate
		}
	}
	return ""
}

func captureNoteShare(ctx context.Context, page *rod.Page, id string) (link, status string) {
	status = "unavailable"
	defer func() {
		if recover() != nil {
			link, status = "", "unavailable"
		}
	}()
	shareCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// XHS exposes its copy menu on real pointer hover. Dispatching JS mouse
	// events does not activate CSS :hover, and detail state precedes the DOM.
	hoverCtx, hoverCancel := context.WithTimeout(shareCtx, 3*time.Second)
	trigger, err := page.Context(hoverCtx).ElementByJS(rod.Eval(`() => {
	 const root=document.querySelector('#noteContainer, .note-detail-mask, .note-container');
	 if(!root)return null;
	 return root.querySelector('.share-icon-container')||root.querySelector('.share-wrapper')||root.querySelector('button.share-icon')||
	 [...root.querySelectorAll('[aria-label], [title]')].find(e=>['分享','Share'].includes(e.getAttribute('aria-label')||e.getAttribute('title')))||null;
	}`))
	if err == nil {
		_ = trigger.Hover()
	}
	hoverCancel()
	result, err := page.Context(shareCtx).Eval(copyNoteShareJS, id)
	if err != nil || result == nil {
		return "", status
	}
	if strings.HasPrefix(result.Value.Str(), "ERROR:") {
		return "", strings.TrimPrefix(result.Value.Str(), "ERROR:")
	}
	link = matchingNoteShare(result.Value.Str(), id)
	if link != "" {
		status = "captured"
	}
	return link, status
}
