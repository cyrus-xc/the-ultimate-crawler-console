package xiaohongshu

import (
	"context"
	"testing"
)

func TestLoginStateRejectsGuestMenuAndUnwrapsAccount(t *testing.T) {
	page, _ := navigationFixture(t)
	page.MustEval(`() => {
 document.body.insertAdjacentHTML('beforeend','<div class="main-container"><div class="user"><div class="link-wrapper"><div class="channel">Me</div></div></div></div>');
 window.__INITIAL_STATE__.user.loggedIn={_value:false};
 window.__INITIAL_STATE__.user.userInfo={_value:{guest:true}};
}`)
	action := NewLogin(page)
	if ok, err := action.authenticated(context.Background()); err != nil || ok {
		t.Fatalf("guest authenticated=%v err=%v", ok, err)
	}
	page.MustEval(`() => {
 window.__INITIAL_STATE__.user.loggedIn={_value:true};
 window.__INITIAL_STATE__.user.userInfo={_value:{guest:false,userId:'111111111111111111111111',nickname:'fixture'}};
}`)
	if ok, err := action.authenticated(context.Background()); err != nil || !ok {
		t.Fatalf("account authenticated=%v err=%v", ok, err)
	}
	user, err := action.CurrentUser(context.Background())
	if err != nil || user.UserID != "111111111111111111111111" {
		t.Fatalf("account missing: %v", err)
	}
}
