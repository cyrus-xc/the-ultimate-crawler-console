package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-rod/rod"
)

// The share page is a preview, not a paginated venue inventory. Its displayed
// count and cards are unverified until individual note details are screened.
func ReadPOIEvidence(ctx context.Context, page *rod.Page, id string) (map[string]any, error) {
	page = page.Context(ctx)
	if err := page.Navigate("https://www.xiaohongshu.com/apps/sns-poi/detail/" + id); err != nil {
		return nil, err
	}
	if err := waitEvidenceReady(ctx, page, `() => !!document.querySelector('.basic-info__title')`); err != nil {
		return nil, err
	}
	r, err := page.Eval(`() => {
      let notes=[];
      for(const e of document.querySelectorAll('.note-block,.note-block__title')){
        let c=e.__vueParentComponent;
        for(let i=0;c&&i<8;i++,c=c.parent){
          if(c.props?.bizContent){try{const b=JSON.parse(c.props.bizContent);if(Array.isArray(b.notes)&&b.notes.length)notes=b.notes;}catch{}}
        }
      }
      const text=s=>document.querySelector(s)?.innerText||'';
      return JSON.stringify({poi_id:location.pathname.split('/').pop(),name:text('.basic-info__title'),
        visible_text:document.body.innerText,preview_notes:notes,
        preview_titles:[...document.querySelectorAll('.note-block h2')].map(e=>e.innerText),
        scope:'unverified_poi_web_preview'});
    }`)
	if err != nil {
		return nil, err
	}
	raw := json.RawMessage(r.Value.Str())
	if !json.Valid(raw) {
		return nil, fmt.Errorf("POI_STATE_UNAVAILABLE")
	}
	return map[string]any{"raw": raw, "end_observed": false, "stop_reason": "poi_web_preview_only", "source": "poi_share_page"}, nil
}
