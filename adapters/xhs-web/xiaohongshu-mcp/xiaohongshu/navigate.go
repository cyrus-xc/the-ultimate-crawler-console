package xiaohongshu

import (
	"context"
	"time"

	"github.com/go-rod/rod"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

type NavigateAction struct {
	page *rod.Page
}

// navTimeout 是「顶层文档导航」这一次 CDP 调用的硬上限。平台偶发把导航挂住
// （页面停在旧内容、不再发任何请求），导航不该因此吃掉整个 read 预算；卡住时
// 快速失败，让调用方回退到其他入口。
const navTimeout = 20 * time.Second

func NewNavigate(page *rod.Page) *NavigateAction {
	return &NavigateAction{page: page}
}

func (n *NavigateAction) ToExplorePage(ctx context.Context) error {
	page := n.page.Context(ctx).Timeout(60 * time.Second) // 加超时保护，避免 MustNavigate/MustWaitStable 无限挂

	page.MustNavigate("https://www.xiaohongshu.com/explore").
		MustWaitLoad().
		MustElement(`div#app`)

	return nil
}

func (n *NavigateAction) ToProfilePage(ctx context.Context) error {
	page := n.page.Context(ctx).Timeout(60 * time.Second) // 加超时保护，避免 MustNavigate/MustWaitStable 无限挂

	// First navigate to explore page
	if err := n.ToExplorePage(ctx); err != nil {
		return err
	}

	page.MustWaitStable()

	// Find and click the "我" channel link in sidebar
	profileLink := page.MustElement(`div.main-container li.user.side-bar-component a.link-wrapper span.channel`)
	humanize.Delay(ctx, humanize.BeforeClick)
	if err := humanize.Click(ctx, profileLink); err != nil {
		return err
	}

	// Wait for navigation to complete
	page.MustWaitLoad()

	return nil
}
