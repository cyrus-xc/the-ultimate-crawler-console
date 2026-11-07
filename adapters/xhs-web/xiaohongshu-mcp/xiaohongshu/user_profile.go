package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

// ProfileTab 个人主页的子 tab。
type ProfileTab string

const (
	TabNotes     ProfileTab = "note"
	TabFavorites ProfileTab = "fav"
	TabLiked     ProfileTab = "liked"
)

// ParseProfileTab 解析 tab 名，空值默认为「笔记」。
func ParseProfileTab(s string) (ProfileTab, error) {
	switch strings.TrimSpace(strings.ToLower(s)) {
	case "", "note", "notes", "笔记":
		return TabNotes, nil
	case "fav", "favorites", "favorite", "收藏":
		return TabFavorites, nil
	case "liked", "like", "点赞":
		return TabLiked, nil
	}
	return "", fmt.Errorf("未知的主页 tab %q，可选：note / fav / liked", s)
}

// tabLabel 子 tab 对应的页面文字。
var tabLabel = map[ProfileTab]string{
	TabNotes:     "笔记",
	TabFavorites: "收藏",
	TabLiked:     "点赞",
}

type UserProfileAction struct {
	page *rod.Page
}

func NewUserProfileAction(page *rod.Page) *UserProfileAction {
	return &UserProfileAction{page: page}
}

// UserProfile 获取用户基本信息及指定 tab 下的帖子
func (u *UserProfileAction) UserProfile(ctx context.Context, userID, xsecToken string, tab ProfileTab) (*UserProfileResponse, error) {
	page := u.page.Context(ctx).Timeout(60 * time.Second)

	// 顶层文档导航单独定上限：平台偶发把导航挂住（页面停在旧内容、不再发请求），
	// 不做限制会吃掉整个 read 预算。卡住时快速失败，让上层回退。
	navCtx, navCancel := context.WithTimeout(ctx, navTimeout)
	navErr := page.Context(navCtx).Navigate(makeUserProfileURL(userID, xsecToken, tab))
	navCancel()
	if navErr != nil {
		return nil, navErr
	}
	// Profile animations can keep the DOM unstable after evidence is ready.
	// Wait for the actual profile and tab containers instead of layout silence.
	waitCtx, waitCancel := context.WithTimeout(ctx, 60*time.Second)
	defer waitCancel()
	if err := waitEvidenceReady(waitCtx, page, `() => {
	 const u=window.__INITIAL_STATE__?.user;if(!u)return false;
	 const unwrap=x=>x?.value??x?._value??x;
	 const p=unwrap(u.userPageData),notes=unwrap(u.notes),active=unwrap(u.activeTab)||{};
	 const feeds=notes?.[active.index||0];
	 // SSR placeholders have a title but empty note identities. Wait for hydration.
	 return !!p?.basicInfo?.nickname&&Array.isArray(feeds)&&
	  (feeds.length===0||feeds.some(f=>/^[a-fA-F0-9]{24}$/.test(f.id||f.noteId||f.noteCard?.noteId||'')));
	}`); err != nil {
		return nil, fmt.Errorf("PROFILE_STATE_UNAVAILABLE: %w", err)
	}

	return u.extractUserProfileData(ctx, page, tab)
}

// extractUserProfileData 从页面中提取用户资料数据的通用方法
func (u *UserProfileAction) extractUserProfileData(ctx context.Context, page *rod.Page, tab ProfileTab) (*UserProfileResponse, error) {
	if err := page.Context(ctx).Timeout(10 * time.Second).Wait(rod.Eval(`() => window.__INITIAL_STATE__ !== undefined`)); err != nil {
		return nil, fmt.Errorf("等待 __INITIAL_STATE__ 失败: %w", err)
	}

	userDataResult, err := page.Context(ctx).Timeout(10 * time.Second).Eval(`() => {
		if (window.__INITIAL_STATE__ &&
		    window.__INITIAL_STATE__.user &&
		    window.__INITIAL_STATE__.user.userPageData) {
			const userPageData = window.__INITIAL_STATE__.user.userPageData;
			const data = userPageData.value !== undefined ? userPageData.value : (userPageData._value !== undefined ? userPageData._value : userPageData);
			if (data) {
				return JSON.stringify(data);
			}
		}
		return "";
	}`)
	if err != nil {
		return nil, fmt.Errorf("读取 userPageData 失败: %w", err)
	}
	userDataResultStr := userDataResult.Value.Str()

	if userDataResultStr == "" {
		return nil, fmt.Errorf("user.userPageData.value not found in __INITIAL_STATE__")
	}

	// 2. 获取用户帖子及当前 tab：window.__INITIAL_STATE__.user
	notesResult, err := page.Context(ctx).Timeout(10 * time.Second).Eval(`() => {
		const u = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user;
		if (!u || !u.notes) return "";
		const unwrap = (o) => (o && o.value !== undefined) ? o.value : ((o && o._value !== undefined) ? o._value : o);
		const notes = unwrap(u.notes);
		if (!notes) return "";
		const active = unwrap(u.activeTab) || {};
		return JSON.stringify({notes: notes, index: active.index || 0, query: active.query || ""});
	}`)
	if err != nil {
		return nil, fmt.Errorf("读取 notes 失败: %w", err)
	}
	notesResultStr := notesResult.Value.Str()

	if notesResultStr == "" {
		return nil, fmt.Errorf("user.notes.value not found in __INITIAL_STATE__")
	}

	// 解析用户信息
	var userPageData struct {
		Interactions []UserInteractions `json:"interactions"`
		BasicInfo    UserBasicInfo      `json:"basicInfo"`
	}
	if err := json.Unmarshal([]byte(userDataResultStr), &userPageData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal userPageData: %w", err)
	}

	var notesData struct {
		Notes [][]Feed `json:"notes"`
		Index int      `json:"index"`
		Query string   `json:"query"`
	}
	if err := json.Unmarshal([]byte(notesResultStr), &notesData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal notes: %w", err)
	}

	// tab 不符时报错，避免把别的 tab 的内容当成结果返回
	want := tab
	if want == "" {
		want = TabNotes
	}
	if notesData.Query != "" && ProfileTab(notesData.Query) != want {
		return nil, fmt.Errorf("当前 tab 为 %q，与请求的 %q 不符", notesData.Query, want)
	}

	// 组装响应
	response := &UserProfileResponse{
		UserBasicInfo: userPageData.BasicInfo,
		Interactions:  userPageData.Interactions,
	}

	// 每个 tab 的内容存在各自的下标里，只取当前 tab 的，避免混入其他 tab
	if notesData.Index >= 0 && notesData.Index < len(notesData.Notes) {
		response.Feeds = append(response.Feeds, notesData.Notes[notesData.Index]...)
	}

	return response, nil
}

func makeUserProfileURL(userID, xsecToken string, tab ProfileTab) string {
	url := fmt.Sprintf("https://www.xiaohongshu.com/user/profile/%s?xsec_token=%s&xsec_source=pc_note", userID, xsecToken)
	if tab != "" && tab != TabNotes {
		url += fmt.Sprintf("&tab=%s&subTab=note", tab)
	}
	return url
}

func (u *UserProfileAction) GetMyProfileViaSidebar(ctx context.Context, tab ProfileTab) (*UserProfileResponse, error) {
	page := u.page.Context(ctx).Timeout(60 * time.Second) // 重设被 .Context 清掉的 deadline

	// 创建导航动作
	navigate := NewNavigate(page)

	// 通过侧边栏导航到个人主页
	if err := navigate.ToProfilePage(ctx); err != nil {
		return nil, fmt.Errorf("failed to navigate to profile page via sidebar: %w", err)
	}

	// 等待页面加载完成并获取 __INITIAL_STATE__
	if err := page.Context(ctx).WaitStable(300 * time.Millisecond); err != nil {
		return nil, fmt.Errorf("等待个人主页稳定失败: %w", err)
	}

	if err := u.selectTab(ctx, page, tab); err != nil {
		return nil, err
	}

	return u.extractUserProfileData(ctx, page, tab)
}

// selectTab 切到目标子 tab。「笔记」是默认 tab，无需点击。
func (u *UserProfileAction) selectTab(ctx context.Context, page *rod.Page, tab ProfileTab) error {
	if tab == "" || tab == TabNotes {
		return nil
	}

	label := tabLabel[tab]
	elems, err := page.Elements(`.reds-tab-item.sub-tab-list`)
	if err != nil {
		return fmt.Errorf("未找到主页子 tab: %w", err)
	}

	for _, elem := range elems {
		text, err := elem.Text()
		if err != nil || strings.TrimSpace(text) != label {
			continue
		}
		humanize.Delay(ctx, humanize.BeforeClick)
		if err := humanize.Click(ctx, elem); err != nil {
			return fmt.Errorf("切换到 %s 失败: %w", label, err)
		}
		humanize.Delay(ctx, humanize.AfterClick)
		if err := page.Context(ctx).Timeout(10 * time.Second).WaitStable(300 * time.Millisecond); err != nil {
			return fmt.Errorf("等待 %s tab 稳定失败: %w", label, err)
		}
		return nil
	}
	return fmt.Errorf("未找到子 tab %q", label)
}
