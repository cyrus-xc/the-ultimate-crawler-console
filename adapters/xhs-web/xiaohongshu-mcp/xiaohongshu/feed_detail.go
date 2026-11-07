package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/avast/retry-go/v4"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/errors"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

// ========== 配置常量 ==========
const (
	defaultMaxAttempts   = 500
	stagnantLimit        = 20
	minScrollDelta       = 10
	maxClickPerRound     = 3
	largeScrollTrigger   = 5 // 停滞多少次后触发大滚动
	buttonClickInterval  = 3 // 每隔多少次尝试点击一次按钮
	finalSprintPushCount = 15

	// 懒加载模式默认最多触发 2 轮滚动懒加载（即「两页」）。
	defaultLazyLoadLimit = 2

	// commentScrollBudget 是评论区定位/滚动的一次性预算。详情页偶发 CDP eval
	// 不应答时，未绑超时的 ScrollIntoView 会把整个 read 拖满预算（表现为“卡住”）。
	// 有界懒加载模式下 Go 总预算只有 30s，这里单独压到 5s，不能把大头预算吃掉。
	commentScrollBudget = 5 * time.Second

	// scrollNotchTimeout 是单次滚轮事件的硬上限。rod 的 Mouse.Scroll 直接发
	// CDP，不感知调用方 ctx；渲染进程不应答时加一层短上限，避免整轮滚动卡死。
	scrollNotchTimeout = 3 * time.Second

	// 以下三个只用于查找单条评论，与批量加载的 defaultMaxAttempts 不共用
	maxSearchScrolls  = 25               // 最多下滚轮数
	maxExpandRounds   = 5                // 最多连续展开而不下滚的轮数
	maxSearchDuration = 90 * time.Second // 单次查找的墙钟上限
)

// ========== 数据结构 ==========

// CommentLoadConfig 控制评论加载。
//
// LazyLoadOnScroll 对应 comment_mode=limited_lazy_load_on_scroll：靠向下滚动
// 触发懒加载，每轮触发新增评论算一页，最多 LazyLoadLimit 页即停（不再追求
// 「加载到页面明确结束」）。这是有界的，避免长贴详情读取被拖到进程超时。
type CommentLoadConfig struct {
	LazyLoadOnScroll    bool
	LazyLoadLimit       int
	ClickMoreReplies    bool
	MaxRepliesThreshold int
	MaxCommentItems     int
	ScrollSpeed         string
}

// 未显式指定时的默认值。
const (
	defaultMaxCommentItems     = 20
	defaultMaxRepliesThreshold = 10
	defaultScrollSpeed         = "normal"
)

func DefaultCommentLoadConfig() CommentLoadConfig {
	return CommentLoadConfig{
		ClickMoreReplies:    false,
		MaxRepliesThreshold: defaultMaxRepliesThreshold,
		MaxCommentItems:     defaultMaxCommentItems,
		ScrollSpeed:         defaultScrollSpeed,
	}
}

// normalize 把零值字段填回默认值。零值一律按「未设置」处理，不再按「无上限」。
//
// 之所以必须在这一层做：配置从 MCP 和 HTTP 两条路进来，字段名和结构都不一样，
// 漏传很容易发生。HTTP 侧要的是嵌套的 comment_config，传扁平字段会被
// ShouldBindJSON 静默丢掉，于是 MaxCommentItems=0；而 0 以前表示「无上限」，
// 一次详情请求就会滚满 defaultMaxAttempts(500) 轮。放在 action 层而不是某个
// handler 里，两条路径和以后新增的调用方都能覆盖到。
//
// 真要拉更多评论，显式传一个大的 MaxCommentItems。
func (c CommentLoadConfig) normalize() CommentLoadConfig {
	if c.MaxCommentItems <= 0 {
		c.MaxCommentItems = defaultMaxCommentItems
	}
	if c.LazyLoadOnScroll {
		c.ClickMoreReplies = true
		c.MaxRepliesThreshold = 0
		if c.LazyLoadLimit <= 0 {
			c.LazyLoadLimit = defaultLazyLoadLimit
		}
	} else if c.MaxRepliesThreshold <= 0 {
		c.MaxRepliesThreshold = defaultMaxRepliesThreshold
	}
	if c.ScrollSpeed == "" {
		c.ScrollSpeed = defaultScrollSpeed
	}
	return c
}

type FeedDetailAction struct {
	page *rod.Page
}

func NewFeedDetailAction(page *rod.Page) *FeedDetailAction {
	return &FeedDetailAction{page: page}
}

// ========== 主要业务逻辑 ==========

func (f *FeedDetailAction) GetFeedDetail(ctx context.Context, feedID, xsecToken string, loadAllComments bool, config CommentLoadConfig) (*FeedDetailResponse, error) {
	return f.GetFeedDetailWithConfig(ctx, feedID, xsecToken, loadAllComments, config)
}

func (f *FeedDetailAction) GetFeedDetailWithConfig(ctx context.Context, feedID, xsecToken string, loadAllComments bool, config CommentLoadConfig) (*FeedDetailResponse, error) {
	config = config.normalize()

	page := f.page.Context(ctx).Timeout(10 * time.Minute)
	url := makeFeedDetailURL(feedID, xsecToken)

	logrus.Infof("打开 feed 详情页: %s", feedID)
	logrus.Infof("配置: 点击更多=%v, 回复阈值=%d, 最大评论数=%d, 滚动速度=%s",
		config.ClickMoreReplies, config.MaxRepliesThreshold, config.MaxCommentItems, config.ScrollSpeed)

	// 使用retry-go处理页面导航和DOM稳定等待；绑定 ctx 让取消能中断重试。
	err := retry.Do(
		func() error {
			if err := page.Navigate(url); err != nil {
				return err
			}
			return page.WaitDOMStable(300*time.Millisecond, 0.02)
		},
		retry.Attempts(3),
		retry.Context(ctx),
		retry.Delay(500*time.Millisecond),
		retry.MaxJitter(1000*time.Millisecond),
		retry.OnRetry(func(n uint, err error) {
			logrus.Debugf("页面导航重试 #%d: %v", n, err)
		}),
	)
	if err != nil {
		logrus.Errorf("页面导航失败: %v", err)
		return nil, err
	}
	humanize.Delay(ctx, humanize.AfterNavigate)

	if err := checkPageAccessible(ctx, page); err != nil {
		return nil, err
	}

	if loadAllComments {
		if err := f.loadAllCommentsWithConfig(ctx, page, config); err != nil {
			logrus.Warnf("加载全部评论失败: %v", err)
		}
	}

	// ctx 已取消时直接返回，避免在已取消的 page 上执行 MustEval 触发 panic
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	return f.extractFeedDetail(ctx, page, feedID)
}

// ========== 评论加载器 ==========

type commentLoader struct {
	lastRaw   json.RawMessage
	noteID    string
	page      *rod.Page
	config    CommentLoadConfig
	stats     *loadStats
	state     *loadState
	loadStart time.Time // [TEMP DEBUG] load 入口时间，用于逐轮 trace
}

// pageCtx 返回绑定到调用方 ctx 的 page，避免 loader 长期持有某个 loadCtx 的 page。
func (cl *commentLoader) pageCtx(ctx context.Context) *rod.Page {
	return cl.page.Context(ctx)
}

// [TEMP DEBUG] msSince 返回自 t 起的毫秒数。
func msSince(t time.Time) float64 { return float64(time.Since(t).Milliseconds()) }

type loadStats struct {
	totalClicked     int
	totalSkipped     int
	attempts         int
	lazyLimitReached bool
}

type loadState struct {
	lastCount      int
	lastScrollTop  int
	stagnantChecks int
	lazyRounds     int // 懒加载模式下已触发的滚动懒加载页数
}

func (f *FeedDetailAction) loadAllCommentsWithConfig(ctx context.Context, page *rod.Page, config CommentLoadConfig) error {
	loader := &commentLoader{
		page:   page,
		config: config,
		stats:  &loadStats{},
		state:  &loadState{},
	}

	return loader.load(ctx)
}

func (cl *commentLoader) load(ctx context.Context) error {
	maxAttempts := cl.calculateMaxAttempts()
	cl.loadStart = time.Now() // [TEMP DEBUG]

	// 每次 load 都用调用方当下的 ctx 重新绑定，不继承 loader 创建时的长 ctx。
	page := cl.pageCtx(ctx)

	logrus.Info("开始加载评论...")
	scrollErr := scrollToCommentsArea(ctx, page)
	logrus.Infof("[load] scrollToCommentsArea 完成 err=%v 耗时=%.0fms", scrollErr, msSince(cl.loadStart))
	humanize.Delay(ctx, humanize.BetweenScroll)

	// 检查是否没有评论
	if cl.checkNoComments(ctx) {
		logrus.Infof("[load] checkNoComments=true，直接返回")
		return nil
	}
	logrus.Infof("[load] 进入主循环 maxAttempts=%d lazyLimit=%d 耗时=%.0fms", maxAttempts, cl.config.LazyLoadLimit, msSince(cl.loadStart))

	for cl.stats.attempts = 0; cl.stats.attempts < maxAttempts; cl.stats.attempts++ {
		// [TEMP DEBUG] 逐轮 trace：定位卡在哪一步（预算是有限值，见 seconds）。
		roundStart := time.Now()
		logrus.Infof("[load] round=%d elapsed=%.1fs lazyRounds=%d lastCount=%d",
			cl.stats.attempts+1, time.Since(cl.loadStart).Seconds(), cl.state.lazyRounds, cl.state.lastCount)
		// 协作取消点：ctx 取消后干净退出，避免空转直到撞上 MustEval panic
		if err := ctx.Err(); err != nil {
			logrus.Infof("[load] ctx cancelled at round=%d: %v", cl.stats.attempts+1, err)
			return err
		}
		// 验证/限流弹窗挡住评论容器时，轮询/滚动都不会推进；先等它消失再继续本轮。
		// 若 60s 后仍在，按 CRAWLER_RATE_LIMITED 退出，让上层 cooldown 后重试。
		if err := WaitForRestrictionOverlay(ctx, page); err != nil {
			return err
		}

		logrus.Debugf("=== 尝试 %d/%d ===", cl.stats.attempts+1, maxAttempts)

		if cl.checkComplete(ctx) {
			logrus.Infof("[load] checkComplete=true 耗时=%.0fms", msSince(roundStart))
			return nil
		}
		logrus.Infof("[load] checkComplete=false 耗时=%.0fms", msSince(roundStart))

		if cl.shouldClickButtons() {
			cl.clickButtonsWithRetry(ctx)
		}
		logrus.Infof("[load] click 完成 耗时=%.0fms", msSince(roundStart))

		currentCount := getCommentCount(ctx, page)
		cl.updateState(ctx, currentCount)
		logrus.Infof("[load] count=%d 耗时=%.0fms", currentCount, msSince(roundStart))

		if cl.shouldStopAtTarget(currentCount) {
			logrus.Infof("[load] shouldStopAtTarget=true 耗时=%.0fms", msSince(roundStart))
			return nil
		}

		cl.performScroll(ctx)
		logrus.Infof("[load] performScroll 完成 耗时=%.0fms", msSince(roundStart))
		cl.handleStagnation(ctx)

		// 懒加载模式下，每轮滚动算「一页」；达到 comment_lazy_load_limit 页后
		// 立即停止。这里按轮计数（而不是只在评论数增长时计数），因为长贴可能出现
		// 「滚了但没有新评论」的空转，若按增长计数会退化成无界滚动，把详情读取拖到
		// 进程超时——这正是本次要修的问题。有界两轮保证详情读取始终快速返回。
		if cl.config.LazyLoadOnScroll {
			cl.state.lazyRounds++
			if cl.state.lazyRounds >= cl.config.LazyLoadLimit {
				cl.stats.lazyLimitReached = true
				logrus.Infof("[load] ✓ 懒加载已达 %d 页上限，停止加载 总耗时=%.1fs 轮次=%.0fms",
					cl.config.LazyLoadLimit, time.Since(cl.loadStart).Seconds(), msSince(roundStart))
				return nil
			}
		}

		logrus.Infof("[load] round=%d 完成 总耗时=%.1fs 轮耗时=%.0fms", cl.stats.attempts+1, time.Since(cl.loadStart).Seconds(), msSince(roundStart))
		humanize.Delay(ctx, humanize.BetweenScroll)
	}

	cl.performFinalSprint(ctx)
	return nil
}

func (cl *commentLoader) calculateMaxAttempts() int {
	if cl.config.LazyLoadOnScroll {
		return defaultMaxAttempts
	}
	if cl.config.MaxCommentItems > 0 {
		return cl.config.MaxCommentItems * 3
	}
	return defaultMaxAttempts
}

func (cl *commentLoader) checkNoComments(ctx context.Context) bool {
	if checkNoCommentsArea(ctx, cl.pageCtx(ctx)) {
		logrus.Infof("✓ 检测到无评论区域（这是一片荒地），跳过加载")
		return true
	}
	return false
}

func (cl *commentLoader) checkComplete(ctx context.Context) bool {
	page := cl.pageCtx(ctx)
	if cl.config.LazyLoadOnScroll && cl.noteID != "" {
		raw, err := ReadRawEvidence(ctx, page, "note", cl.noteID)
		if err == nil {
			cl.lastRaw = raw
			if commentsFullyObserved(raw) {
				return true
			}
		}
	}
	if !checkEndContainer(ctx, page) {
		return false
	}

	// 到底之后再展开一轮：评论区不用怎么滚就能到底时，循环第一轮就走到这里，
	// 主流程里的展开步骤根本没机会执行。点开了就先不算加载完，让下一轮重新判断
	// （展开会露出新的按钮）；一个都没点开就收工，避免被阈值跳过的按钮卡住。
	if cl.config.ClickMoreReplies && cl.clickButtonsWithRetry(ctx) > 0 {
		return false
	}
	// A bottom marker says nothing about unexpanded reply threads.
	if cl.config.LazyLoadOnScroll {
		return false
	}

	currentCount := getCommentCount(ctx, page)
	logrus.Infof("✓ 检测到 'THE END' 元素，已滑动到底部")
	humanize.Delay(ctx, humanize.BetweenScroll)
	logrus.Infof("✓ 加载完成: %d 条评论, 尝试次数: %d, 点击: %d, 跳过: %d",
		currentCount, cl.stats.attempts+1, cl.stats.totalClicked, cl.stats.totalSkipped)
	return true
}

func (cl *commentLoader) shouldClickButtons() bool {
	if cl.config.LazyLoadOnScroll {
		return cl.config.ClickMoreReplies
	}
	return cl.config.ClickMoreReplies && cl.stats.attempts%buttonClickInterval == 0
}

// clickButtonsWithRetry 展开当前页上的回复按钮，返回本次点开的个数。
func (cl *commentLoader) clickButtonsWithRetry(ctx context.Context) int {
	page := cl.pageCtx(ctx)
	clicked, skipped := clickShowMoreButtonsSmart(ctx, page, cl.config.MaxRepliesThreshold)
	if clicked == 0 && skipped == 0 {
		return 0
	}

	cl.stats.totalClicked += clicked
	cl.stats.totalSkipped += skipped
	logrus.Infof("点击'更多': %d 个, 跳过: %d 个, 累计点击: %d, 累计跳过: %d",
		clicked, skipped, cl.stats.totalClicked, cl.stats.totalSkipped)

	humanize.Delay(ctx, humanize.Reading)

	// 重试一轮
	clicked2, skipped2 := clickShowMoreButtonsSmart(ctx, page, cl.config.MaxRepliesThreshold)
	if clicked2 > 0 || skipped2 > 0 {
		cl.stats.totalClicked += clicked2
		cl.stats.totalSkipped += skipped2
		logrus.Infof("第 2 轮: 点击 %d, 跳过 %d", clicked2, skipped2)
		humanize.Delay(ctx, humanize.Reading)
	}

	return clicked + clicked2
}

func (cl *commentLoader) updateState(ctx context.Context, currentCount int) {
	totalCount := getTotalCommentCount(ctx, cl.pageCtx(ctx))
	logrus.Debugf("当前评论: %d, 目标: %d", currentCount, totalCount)

	if currentCount != cl.state.lastCount {
		logrus.Infof("✓ 评论增加: %d -> %d (+%d)",
			cl.state.lastCount, currentCount, currentCount-cl.state.lastCount)
		cl.state.lastCount = currentCount
		cl.state.stagnantChecks = 0
	} else {
		cl.state.stagnantChecks++
		if cl.state.stagnantChecks%5 == 0 {
			logrus.Debugf("评论停滞 %d 次", cl.state.stagnantChecks)
		}
	}
}

func (cl *commentLoader) shouldStopAtTarget(currentCount int) bool {
	if cl.config.LazyLoadOnScroll {
		return false
	}
	// 如果未设置最大评论数，或者还未达到目标，继续加载
	if cl.config.MaxCommentItems <= 0 {
		return false
	}

	// 如果已达到或超过目标评论数，立即停止
	if currentCount >= cl.config.MaxCommentItems {
		logrus.Infof("✓ 已达到目标评论数: %d/%d, 停止加载",
			currentCount, cl.config.MaxCommentItems)
		return true
	}

	return false
}

func (cl *commentLoader) performScroll(ctx context.Context) {
	page := cl.pageCtx(ctx)
	currentCount := getCommentCount(ctx, page)
	if currentCount > 0 {
		scrollToLastComment(ctx, page)
		time.Sleep(400 * time.Millisecond) // 技术 settle：等滚动落位
	}

	largeMode := cl.state.stagnantChecks >= largeScrollTrigger
	pushCount := 1
	if largeMode {
		pushCount = 3 + rand.Intn(3)
	}

	_, scrollDelta, currentScrollTop := humanScroll(ctx, page, cl.config.ScrollSpeed, largeMode, pushCount)

	if scrollDelta < minScrollDelta || currentScrollTop == cl.state.lastScrollTop {
		cl.state.stagnantChecks++
		if cl.state.stagnantChecks%5 == 0 {
			logrus.Debugf("滚动停滞 %d 次", cl.state.stagnantChecks)
		}
	} else {
		cl.state.stagnantChecks = 0
		cl.state.lastScrollTop = currentScrollTop
	}
}

func (cl *commentLoader) handleStagnation(ctx context.Context) {
	if cl.state.stagnantChecks >= stagnantLimit {
		logrus.Infof("停滞过多，尝试大冲刺...")
		page := cl.pageCtx(ctx)
		humanScroll(ctx, page, cl.config.ScrollSpeed, true, 10)
		cl.state.stagnantChecks = 0

		if checkEndContainer(ctx, page) {
			currentCount := getCommentCount(ctx, page)
			logrus.Infof("✓ 到达底部，评论数: %d", currentCount)
		}
	}
}

func (cl *commentLoader) performFinalSprint(ctx context.Context) {
	logrus.Infof("达到最大尝试次数，最后冲刺...")
	page := cl.pageCtx(ctx)
	humanScroll(ctx, page, cl.config.ScrollSpeed, true, finalSprintPushCount)

	currentCount := getCommentCount(ctx, page)
	hasEnd := checkEndContainer(ctx, page)
	logrus.Infof("✓ 加载结束: %d 条评论, 点击: %d, 跳过: %d, 到达底部: %v",
		currentCount, cl.stats.totalClicked, cl.stats.totalSkipped, hasEnd)
}

// ========== 按钮点击 ==========

func clickShowMoreButtonsSmart(ctx context.Context, page *rod.Page, maxRepliesThreshold int) (clicked, skipped int) {
	elements, err := page.Context(ctx).Timeout(2 * time.Second).Elements(".show-more")
	if err != nil {
		return 0, 0
	}

	replyCountRegex := regexp.MustCompile(`展开\s*(\d+)\s*条回复`)
	maxClick := maxClickPerRound + rand.Intn(maxClickPerRound)
	clickedInRound := 0

	for _, el := range elements {
		if clickedInRound >= maxClick {
			break
		}

		el = el.Context(ctx)
		if !isElementClickable(el) {
			continue
		}

		text, err := el.Text()
		if err != nil {
			continue
		}

		if !isSafeExpandButton(el, text) {
			continue
		}

		if shouldSkipButton(text, maxRepliesThreshold, replyCountRegex) {
			skipped++
			continue
		}

		if clickElementWithHumanBehavior(ctx, page, el, text) {
			clicked++
			clickedInRound++
		}
	}

	return clicked, skipped
}

// expandNearbyReplies 展开视口附近的「展开 N 条回复」，返回本轮点开的个数。
// 限定在视口附近，避免 ScrollIntoView 把页面拽回顶部、与向下滚动互相抵消。
func expandNearbyReplies(ctx context.Context, page *rod.Page) int {
	elements, err := page.Context(ctx).Timeout(2 * time.Second).Elements(".show-more")
	if err != nil || len(elements) == 0 {
		return 0
	}

	maxClick := maxClickPerRound + rand.Intn(maxClickPerRound)
	clicked := 0

	for _, el := range elements {
		if clicked >= maxClick {
			break
		}

		el = el.Context(ctx)
		if !isElementClickable(el) || !isNearViewport(ctx, page, el) {
			continue
		}

		text, err := el.Text()
		if err != nil {
			continue
		}

		if !isSafeExpandButton(el, text) {
			continue
		}

		if clickElementWithHumanBehavior(ctx, page, el, text) {
			clicked++
		}
	}

	return clicked
}

// isSafeExpandButton 判断 .show-more 是不是展开回复按钮。
func isSafeExpandButton(el *rod.Element, text string) bool {
	if !isExpandRepliesButton(text) {
		logrus.Debugf("跳过展开按钮：文案不匹配 %q", text)
		return false
	}

	if !hasReadableSize(el) {
		logrus.Debugf("跳过展开按钮：尺寸过小 %q", text)
		return false
	}

	return true
}

// 两种文案：「展开 N 条回复」，以及点开一次后不带数字的「展开更多回复」。
var expandRepliesTextRegex = regexp.MustCompile(`^展开\s*(\d+\s*条|更多)回复$`)

func isExpandRepliesButton(text string) bool {
	return expandRepliesTextRegex.MatchString(strings.TrimSpace(text))
}

// hasReadableSize 判断元素尺寸是否达到按钮的量级。
func hasReadableSize(el *rod.Element) bool {
	const minWidth, minHeight = 24, 10

	shape, err := el.Shape()
	if err != nil || len(shape.Quads) == 0 {
		return false
	}

	q := shape.Quads[0] // 四个角点，左上 (q0,q1) 右下 (q4,q5)
	return q[4]-q[0] >= minWidth && q[5]-q[1] >= minHeight
}

// isNearViewport 判断元素是否落在视口上下各一屏的范围内。上下各留一屏是为了重叠，
// 滚动后刚划出去的元素下一轮还能被捡回来。
func isNearViewport(ctx context.Context, page *rod.Page, el *rod.Element) bool {
	shapeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	shape, err := el.Context(shapeCtx).Shape()
	if err != nil || len(shape.Quads) == 0 {
		return false
	}

	// quads 是相对视口的 CSS 像素
	top := shape.Quads[0][1]
	height := float64(evalInt(ctx, page, `() => window.innerHeight`))

	return top > -height && top < 2*height
}

func isElementClickable(el *rod.Element) bool {
	visible, err := el.Visible()
	if err != nil || !visible {
		return false
	}

	box, err := el.Shape()
	return err == nil && len(box.Quads) > 0
}

func shouldSkipButton(text string, threshold int, regex *regexp.Regexp) bool {
	if threshold <= 0 {
		return false
	}

	matches := regex.FindStringSubmatch(text)
	if len(matches) > 1 {
		if replyCount, err := strconv.Atoi(matches[1]); err == nil && replyCount > threshold {
			logrus.Debugf("跳过'%s'（回复数 %d > 阈值 %d）", text, replyCount, threshold)
			return true
		}
	}
	return false
}

func clickElementWithHumanBehavior(ctx context.Context, page *rod.Page, el *rod.Element, text string) bool {
	var clickSuccess bool

	// [TEMP DEBUG] 逐步骤 trace：定位卡在哪一步（ScrollIntoView/Delay/Click）。
	stepStart := time.Now()
	defer func() {
		logrus.Infof("[click] '%s' 返回=%v 耗时=%.0fms ctxErr=%v", text, clickSuccess, msSince(stepStart), ctx.Err())
	}()

	// 点击滚动预算：有界懒加载 read 总预算只有 30s，单个按钮不能把大头吃掉。
	scrollBudget := 3 * time.Second
	if d, ok := ctx.Deadline(); ok {
		if remaining := time.Until(d) - 500*time.Millisecond; remaining < scrollBudget {
			scrollBudget = remaining
			if scrollBudget < 1*time.Second {
				scrollBudget = 1 * time.Second
			}
		}
	}

	// 使用retry-go进行点击操作重试；绑定 ctx 让取消能中断重试。
	err := retry.Do(
		func() error {
			// 滚动到元素：不再用 scrollIntoView（会触发同步 layout/动画，可能死锁
			// renderer），改为直接移动评论容器 scrollTop 把元素顶进视口。
			logrus.Infof("[click] '%s' scrollIntoElement 开始", text)
			scrollCtx, scrollCancel := context.WithTimeout(ctx, scrollBudget)
			_, err := el.Context(scrollCtx).Timeout(2 * time.Second).Eval(`() => {
				const el = this;
				let scroller = el.parentElement;
				while (scroller && scroller !== document.body) {
					if (scroller.scrollHeight > scroller.clientHeight) break;
					scroller = scroller.parentElement;
				}
				if (!scroller || scroller === document.body) return 'no_scroller';
				const targetTop = el.offsetTop - scroller.clientHeight / 2;
				scroller.scrollTop = Math.max(0, targetTop);
				return 'ok';
			}`)
			scrollCancel()
			if err != nil {
				logrus.Infof("[click] '%s' scrollIntoElement err=%v", text, err)
				return err
			}
			logrus.Infof("[click] '%s' scrollIntoElement 完成 耗时=%.0fms", text, msSince(stepStart))

			humanize.Delay(ctx, humanize.Reading)
			logrus.Infof("[click] '%s' Delay 完成 耗时=%.0fms", text, msSince(stepStart))

			// 已经手动滚到视图，跳过 WaitInteractable 的遮挡重试，避免其内部 rAF 等待。
			if err := humanize.ClickNoWait(ctx, el); err != nil {
				logrus.Infof("[click] '%s' humanize.ClickNoWait err=%v 耗时=%.0fms", text, err, msSince(stepStart))
				return err // 返回错误以触发重试
			}
			logrus.Infof("[click] '%s' humanize.ClickNoWait 完成 耗时=%.0fms", text, msSince(stepStart))

			humanize.Delay(ctx, humanize.Reading)
			clickSuccess = true
			return nil
		},
		retry.Attempts(3),
		retry.Context(ctx),
		retry.Delay(100*time.Millisecond),
		retry.MaxJitter(200*time.Millisecond),
		retry.OnRetry(func(n uint, err error) {
			logrus.Debugf("点击重试 #%d: %s, 错误: %v", n, text, err)
		}),
	)

	if err != nil {
		logrus.Debugf("点击失败 '%s': %v", text, err)
		return false
	}

	if clickSuccess {
		logrus.Debugf("点击了'%s'", text)
	}

	return clickSuccess
}

// ========== 滚动相关 ==========

func humanScroll(ctx context.Context, page *rod.Page, speed string, largeMode bool, pushCount int) (bool, int, int) {
	start := time.Now()
	beforeTop := getScrollTop(ctx, page)
	viewportHeight := evalInt(ctx, page, `() => window.innerHeight`)

	baseRatio := getScrollRatio(speed)
	if largeMode {
		baseRatio *= 2.0
	}

	scrolled := false
	actualDelta := 0
	currentScrollTop := beforeTop

	logrus.Debugf("[humanScroll] start top=%d vh=%d push=%d large=%v", beforeTop, viewportHeight, pushCount, largeMode)
	for i := 0; i < max(1, pushCount); i++ {
		if err := ctx.Err(); err != nil {
			logrus.Debugf("[humanScroll] ctx cancelled at push=%d 耗时=%.0fms", i, msSince(start))
			break
		}
		scrollDelta := calculateScrollDelta(viewportHeight, baseRatio)
		logrus.Debugf("[humanScroll] push=%d delta=%.0f", i+1, scrollDelta)
		smartScroll(ctx, page, scrollDelta)

		time.Sleep(150 * time.Millisecond) // 技术 settle：等滚动后懒加载渲染，再读 scrollTop

		currentScrollTop = getScrollTop(ctx, page)
		deltaThisTime := currentScrollTop - beforeTop
		actualDelta += deltaThisTime

		if deltaThisTime > 5 {
			scrolled = true
		}

		beforeTop = currentScrollTop
		logrus.Debugf("[humanScroll] push=%d end top=%d delta=%d 耗时=%.0fms", i+1, currentScrollTop, deltaThisTime, msSince(start))

		if i < pushCount-1 {
			humanize.Delay(ctx, humanize.BetweenScroll)
		}
	}

	// 兜底：常规幅度没推动，加大力度再滚一次。
	// 不用 window.scrollTo：详情页评论在容器内滚动，window 的 scrollTop 恒为 0
	// （见 getScrollTop）。实测滚 window 推不动评论容器，读回来的位移也不是它的。
	if !scrolled && pushCount > 0 {
		logrus.Debugf("[humanScroll] fallback large scroll")
		smartScroll(ctx, page, float64(viewportHeight)*3)
		time.Sleep(400 * time.Millisecond) // 技术 settle：等滚动落位
		currentScrollTop = getScrollTop(ctx, page)
		actualDelta += currentScrollTop - beforeTop
		scrolled = actualDelta > 5
	}

	logrus.Debugf("[humanScroll] finish top=%d delta=%d scrolled=%v 耗时=%.0fms", currentScrollTop, actualDelta, scrolled, msSince(start))
	return scrolled, actualDelta, currentScrollTop
}

func getScrollRatio(speed string) float64 {
	switch speed {
	case "slow":
		return 0.5
	case "fast":
		return 0.9
	default: // normal
		return 0.7
	}
}

func calculateScrollDelta(viewportHeight int, baseRatio float64) float64 {
	scrollDelta := float64(viewportHeight) * (baseRatio + rand.Float64()*0.2)
	if scrollDelta < 400 {
		scrollDelta = 400
	}
	return scrollDelta + float64(rand.Intn(100)-50)
}

func scrollToCommentsArea(ctx context.Context, page *rod.Page) error {
	start := time.Now()
	logrus.Info("滚动到评论区...")
	if err := ctx.Err(); err != nil {
		return err
	}

	// 评论区定位只花有限预算；不能让它占掉有界懒加载 read 的大部分时间。
	budget := commentScrollBudget
	if d, ok := ctx.Deadline(); ok {
		if remaining := time.Until(d) - 500*time.Millisecond; remaining < budget {
			budget = remaining
			if budget < 1*time.Second {
				budget = 1 * time.Second
			}
		}
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	// 用 JS 直接滚评论区容器，绕过 rod Mouse 的逐点移动（在渲染进程忙时
	// 每一步都可能阻塞到 CDP 超时），并且始终绑定调用方 ctx，避免内部
	// Background context 把 read 拖到引擎预算之外。
	// 不再用 scrollIntoView：同步 layout/动画可能死锁 renderer；改为直接
	// 设置 window.scrollTop 把容器顶到视口顶部，再往下滚 delta。
	scrollJS := `(sel, delta) => {
		const el = document.querySelector(sel);
		if (!el) return '';
		const rect = el.getBoundingClientRect();
		window.scrollTo({top: window.pageYOffset + rect.top, behavior: 'instant'});
		const before = el.scrollTop;
		el.scrollTop += delta;
		if (el.scrollTop === before) {
			el.dispatchEvent(new Event('scroll', {bubbles: true}));
		}
		return sel;
	}`
	for _, sel := range commentScrollerSelectors {
		if err := ctx.Err(); err != nil {
			return err
		}
		res, err := page.Context(ctx).Timeout(2 * time.Second).Eval(scrollJS, sel, 120)
		if err != nil {
			logrus.Infof("[scrollToCommentsArea] %s eval err=%v 耗时=%.0fms", sel, err, msSince(start))
			continue
		}
		if res.Value.Str() != "" {
			logrus.Infof("[scrollToCommentsArea] %s scrolled 耗时=%.0fms", sel, msSince(start))
			return nil
		}
	}
	logrus.Infof("[scrollToCommentsArea] 未找到评论区容器，跳过滚动 耗时=%.0fms", msSince(start))
	return nil
}

// smartScroll 向下滚动 delta 像素，触发评论区懒加载。
// 按滚轮格逐格发送，每格幅度小幅浮动、格间留间隔。
func smartScroll(ctx context.Context, page *rod.Page, delta float64) {
	start := time.Now()
	// 指针落在评论滚动容器上，滚轮才只作用于评论区（否则会滚整页）
	moveToCommentScroller(ctx, page)

	for remain := delta; remain > 0; {
		if err := ctx.Err(); err != nil {
			logrus.Debugf("[smartScroll] ctx cancelled remain=%.0f 耗时=%.0fms", remain, msSince(start))
			return
		}
		notch := scrollNotchSize()
		if notch > remain {
			notch = remain
		}

		// rod 的 Mouse.Scroll 直接发 CDP，不感知 ctx；加了上限后即使渲染进程
		// 不应答，也最多等 scrollNotchTimeout 而不是拖满整个 read 预算。
		notchCtx, notchCancel := context.WithTimeout(ctx, scrollNotchTimeout)
		err := page.Context(notchCtx).Mouse.Scroll(0, notch, 1)
		notchCancel()
		if err != nil {
			logrus.Debugf("[smartScroll] notch err=%v remain=%.0f 耗时=%.0fms", err, remain, msSince(start))
			return
		}
		remain -= notch
		logrus.Debugf("[smartScroll] notch=%.0f remain=%.0f 耗时=%.0fms", notch, remain, msSince(start))

		if remain > 0 {
			time.Sleep(scrollNotchInterval())
		}
	}
	logrus.Debugf("[smartScroll] finish delta=%.0f 耗时=%.0fms", delta, msSince(start))
}

// scrollNotchSize 单格滚轮的幅度，围绕标准的 120px 浮动。
func scrollNotchSize() float64 {
	return 100 + rand.Float64()*40
}

// scrollNotchInterval 连续滚轮格之间的间隔。
func scrollNotchInterval() time.Duration {
	return time.Duration(20+rand.Intn(45)) * time.Millisecond
}

// commentScrollerSelectors 评论区滚动容器，按优先级排列。
// 滚动与测量位移必须指向同一个容器，因此共用这一份定义。
var commentScrollerSelectors = []string{".note-scroller", ".comments-container"}

// moveToCommentScroller 把指针移到评论滚动容器内；找不到则退回视口中心。
// 指针已在容器内时不再移动，避免重复落到同一点。
func moveToCommentScroller(ctx context.Context, page *rod.Page) {
	start := time.Now()
	for _, sel := range commentScrollerSelectors {
		el, err := page.Context(ctx).Timeout(2 * time.Second).Element(sel)
		if err != nil {
			continue
		}
		// Shape() 不感知调用方 deadline，给单独短超时，避免单步把整轮拖满。
		shapeCtx, shapeCancel := context.WithTimeout(ctx, 2*time.Second)
		shape, err := el.Context(shapeCtx).Shape()
		shapeCancel()
		if err != nil || len(shape.Quads) == 0 {
			continue
		}
		q := shape.Quads[0]
		left, top, right, bottom := q[0], q[1], q[4], q[5]

		if pos := page.Mouse.Position(); pos.X > left && pos.X < right && pos.Y > top && pos.Y < bottom {
			logrus.Debugf("[moveToCommentScroller] 已在 %s 内，跳过 耗时=%.0fms", sel, msSince(start))
			return
		}

		// 落点在容器中心附近随机偏移，不固定在几何中心
		cx, cy := (left+right)/2, (top+bottom)/2
		target := proto.Point{
			X: cx + (rand.Float64()-0.5)*(right-left)*0.3,
			Y: cy + (rand.Float64()-0.5)*(bottom-top)*0.3,
		}
		moveCtx, moveCancel := context.WithTimeout(ctx, 3*time.Second)
		err = humanize.MoveTo(moveCtx, page, target)
		moveCancel()
		logrus.Debugf("[moveToCommentScroller] %s move err=%v 耗时=%.0fms", sel, err, msSince(start))
		return
	}
	vw := evalInt(ctx, page, `() => window.innerWidth`)
	vh := evalInt(ctx, page, `() => window.innerHeight`)
	if vw <= 0 || vh <= 0 {
		return
	}
	moveCtx, moveCancel := context.WithTimeout(ctx, 3*time.Second)
	defer moveCancel()
	err := humanize.MoveTo(moveCtx, page, proto.Point{X: float64(vw) / 2, Y: float64(vh) / 2})
	logrus.Debugf("[moveToCommentScroller] fallback center err=%v 耗时=%.0fms", err, msSince(start))
}

// evalInt 求值一个返回整数的 JS 表达式；失败或超时返回 0，绝不 panic/挂死。
func evalInt(ctx context.Context, page *rod.Page, js string) int {
	v, err := page.Context(ctx).Timeout(2 * time.Second).Eval(js)
	if err != nil || v == nil {
		return 0
	}
	return v.Value.Int()
}

func scrollToLastComment(ctx context.Context, page *rod.Page) {
	start := time.Now()
	if err := ctx.Err(); err != nil {
		return
	}

	// 单条滚动只花有限预算；有界懒加载模式下不能把 30s 预算大头吃掉。
	budget := 3 * time.Second
	if d, ok := ctx.Deadline(); ok {
		if remaining := time.Until(d) - 500*time.Millisecond; remaining < budget {
			budget = remaining
			if budget < 1*time.Second {
				budget = 1 * time.Second
			}
		}
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	// 不再调用 scrollIntoView：它触发同步 layout/动画，可能死锁 renderer main
	// thread，rod 的 Eval 会挂到整个 read 预算才被取消。改为直接设置容器
	// scrollTop，把最后一条父评论顶进视口；失败也继续走，不影响后续滚动。
	js := `(sels) => {
		let scroller = null;
		for (const sel of sels) {
			const el = document.querySelector(sel);
			if (el && el.scrollHeight > el.clientHeight) {
				scroller = el;
				break;
			}
		}
		if (!scroller) return 'no_scroller';
		const els = scroller.querySelectorAll('.parent-comment');
		if (!els.length) return 'no_comments';
		const last = els[els.length - 1];
		const targetTop = last.offsetTop - scroller.clientHeight / 2;
		scroller.scrollTop = Math.max(0, targetTop);
		return 'ok';
	}`
	res, err := page.Context(ctx).Timeout(2 * time.Second).Eval(js, commentScrollerSelectors)
	if err != nil {
		logrus.Debugf("[scrollToLastComment] eval err=%v 耗时=%.0fms", err, msSince(start))
	} else {
		logrus.Debugf("[scrollToLastComment] result=%s 耗时=%.0fms", res.Value.Str(), msSince(start))
	}
}

// ========== DOM 查询 ==========

func getScrollTop(ctx context.Context, page *rod.Page) int {
	var result int

	// 使用retry-go来处理可能的DOM查询失败
	err := retry.Do(
		func() error {
			evalResult, err := page.Context(ctx).Timeout(2*time.Second).Eval(`(sels) => {
				// 详情页的评论是在容器内滚动的，window 的 scrollTop 恒为 0，
				// 必须读实际滚动的那个容器；容器不可滚时才退回 window。
				for (const sel of sels) {
					const el = document.querySelector(sel);
					if (el && el.scrollHeight > el.clientHeight) {
						return el.scrollTop;
					}
				}
				return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
			}`, commentScrollerSelectors)
			if err != nil {
				return err
			}

			result = evalResult.Value.Int()
			return nil
		},
		retry.Attempts(3),
		retry.Context(ctx),
		retry.Delay(100*time.Millisecond),
		retry.MaxJitter(200*time.Millisecond),
		retry.OnRetry(func(n uint, err error) {
			logrus.Debugf("获取滚动位置重试 #%d: %v", n, err)
		}),
	)

	if err != nil {
		logrus.Warnf("获取滚动位置失败: %v", err)
		return 0 // 失败时返回0
	}

	return result
}

func getCommentCount(ctx context.Context, page *rod.Page) int {
	var result int

	// 使用retry-go来处理可能的DOM查询失败；绑定 ctx 让取消能中断重试。
	err := retry.Do(
		func() error {
			// 使用 Go 获取评论元素
			elements, err := page.Context(ctx).Timeout(2 * time.Second).Elements(".parent-comment")
			if err != nil {
				return err
			}
			result = len(elements)
			return nil
		},
		retry.Attempts(3),
		retry.Context(ctx),
		retry.Delay(100*time.Millisecond),
		retry.MaxJitter(200*time.Millisecond),
		retry.OnRetry(func(n uint, err error) {
			logrus.Debugf("获取评论计数重试 #%d: %v", n, err)
		}),
	)

	if err != nil {
		logrus.Warnf("获取评论计数失败: %v", err)
		return 0 // 失败时返回0
	}

	return result
}

// getTotalCommentCount 取笔记的评论总数，读 __INITIAL_STATE__ 里的
// interactInfo.commentCount，不依赖评论区文案。取不到返回 0。
func getTotalCommentCount(ctx context.Context, page *rod.Page) int {
	res, err := page.Context(ctx).Timeout(2*time.Second).Eval(`() => {
		const m = window.__INITIAL_STATE__?.note?.noteDetailMap;
		if (!m) return "";
		for (const v of Object.values(m)) {
			const c = v?.note?.interactInfo?.commentCount;
			if (c !== undefined && c !== null) return String(c);
		}
		return "";
	}`)
	if err != nil {
		logrus.Debugf("获取总评论计数失败: %v", err)
		return 0
	}

	count, err := strconv.Atoi(strings.TrimSpace(res.Value.Str()))
	if err != nil {
		return 0
	}
	return count
}

func checkNoCommentsArea(ctx context.Context, page *rod.Page) bool {
	// 查找无评论区域
	noCommentsEl, err := page.Context(ctx).Timeout(2 * time.Second).Element(".no-comments-text")
	if err != nil {
		// 未找到无评论元素，说明有评论或评论区正常
		return false
	}

	// 获取文本内容
	text, err := noCommentsEl.Text()
	if err != nil {
		return false
	}

	// 检查是否包含"这是一片荒地"等关键词
	text = strings.TrimSpace(text)
	return strings.Contains(text, "这是一片荒地")
}

func checkEndContainer(ctx context.Context, page *rod.Page) bool {
	var result bool

	// 使用retry-go来处理可能的DOM查询失败；绑定 ctx 让取消能中断重试。
	err := retry.Do(
		func() error {
			// 使用 Go 查找结束容器
			endEl, err := page.Context(ctx).Timeout(2 * time.Second).Element(".end-container")
			if err != nil {
				// 未找到元素，说明未到底部
				result = false
				return nil
			}

			// 获取文本内容
			text, err := endEl.Text()
			if err != nil {
				result = false
				return nil
			}

			// 转换为大写并检查
			textUpper := strings.ToUpper(strings.TrimSpace(text))
			result = strings.Contains(textUpper, "THE END") || strings.Contains(textUpper, "THEEND")
			return nil
		},
		retry.Attempts(3),
		retry.Context(ctx),
		retry.Delay(100*time.Millisecond),
		retry.MaxJitter(200*time.Millisecond),
		retry.OnRetry(func(n uint, err error) {
			logrus.Debugf("检查结束容器重试 #%d: %v", n, err)
		}),
	)

	if err != nil {
		logrus.Warnf("检查结束容器失败: %v", err)
		return false // 失败时返回false
	}

	return result
}

// ========== 页面检查 ==========

func checkPageAccessible(ctx context.Context, page *rod.Page) error {
	// 等错误提示 UI 渲染出来再检查
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(500 * time.Millisecond):
	}

	// 查找错误提示容器
	wrapperEl, err := page.Context(ctx).Timeout(2 * time.Second).Element(".access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper")
	if err != nil {
		// 未找到错误容器，说明页面可访问
		return nil
	}

	// 获取文本内容
	text, err := wrapperEl.Text()
	if err != nil {
		// 无法获取文本，假设页面可访问
		return nil
	}

	// 检查关键词
	keywords := []string{
		"当前笔记暂时无法浏览",
		"该内容因违规已被删除",
		"该笔记已被删除",
		"内容不存在",
		"笔记不存在",
		"已失效",
		"私密笔记",
		"仅作者可见",
		"因用户设置，你无法查看",
		"因违规无法查看",
	}

	for _, kw := range keywords {
		if strings.Contains(text, kw) {
			logrus.Warnf("笔记不可访问: %s", kw)
			return fmt.Errorf("笔记不可访问: %s", kw)
		}
	}

	// 如果有文本但不匹配关键词，返回未知错误
	trimmedText := strings.TrimSpace(text)
	if trimmedText != "" {
		logrus.Warnf("笔记不可访问（未知原因）: %s", trimmedText)
		return fmt.Errorf("笔记不可访问: %s", trimmedText)
	}

	return nil
}

// ========== 数据提取 ==========

func (f *FeedDetailAction) extractFeedDetail(ctx context.Context, page *rod.Page, feedID string) (*FeedDetailResponse, error) {
	var result string

	// 使用retry-go来处理可能的DOM查询失败
	err := retry.Do(
		func() error {
			obj, err := page.Context(ctx).Timeout(2 * time.Second).Eval(`() => {
				if (window.__INITIAL_STATE__ &&
					window.__INITIAL_STATE__.note &&
					window.__INITIAL_STATE__.note.noteDetailMap) {
					const noteDetailMap = window.__INITIAL_STATE__.note.noteDetailMap;
					return JSON.stringify(noteDetailMap);
				}
				return "";
			}`)
			if err != nil {
				return err
			}
			evalResult := obj.Value.Str()

			if evalResult != "" {
				result = evalResult
				return nil
			}
			return fmt.Errorf("无法获取初始状态数据")
		},
		retry.Attempts(3),
		retry.Context(ctx),
		retry.Delay(200*time.Millisecond),
		retry.MaxJitter(300*time.Millisecond),
		retry.OnRetry(func(n uint, err error) {
			logrus.Debugf("提取Feed详情重试 #%d: %v", n, err)
		}),
	)

	if err != nil {
		logrus.Errorf("提取Feed详情失败: %v", err)
		return nil, fmt.Errorf("提取Feed详情失败: %w", err)
	}

	if result == "" {
		return nil, errors.ErrNoFeedDetail
	}

	var noteDetailMap map[string]struct {
		Note     FeedDetail  `json:"note"`
		Comments CommentList `json:"comments"`
	}

	if err := json.Unmarshal([]byte(result), &noteDetailMap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal noteDetailMap: %w", err)
	}

	noteDetail, exists := noteDetailMap[feedID]
	if !exists {
		return nil, fmt.Errorf("feed %s not found in noteDetailMap", feedID)
	}

	return &FeedDetailResponse{
		Note:     noteDetail.Note,
		Comments: noteDetail.Comments,
	}, nil
}

func makeFeedDetailURL(feedID, xsecToken string) string {
	return fmt.Sprintf("https://www.xiaohongshu.com/explore/%s?xsec_token=%s&xsec_source=pc_feed", feedID, xsecToken)
}
