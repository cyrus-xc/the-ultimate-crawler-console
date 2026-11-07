package xiaohongshu

import (
	"encoding/json"
	"errors"

	"github.com/go-rod/rod"
	"strings"
)

// errNoteGone 标记「帖子已不存在」，供 ReadDetailEvidence 包装成 NOTE_STATE_UNAVAILABLE。
var errNoteGone = errors.New("note gone (removed or unavailable)")

// 帖子「不存在」的快速判定。
//
// 平台对已删除 / 私密 / 过期 / 无法访问的帖子不渲染详情：把 `/explore/<id>` 302 到
// `/other`（占位文档），或落到一个明确的错误页。旧链路在这种情况会：导航 → 点不到
// 卡片 → 退回搜索 → 仍点不到 → 在 NOTE_STATE_UNAVAILABLE 上白等 40 秒（一条 ~90 秒），
// 同 worker 的下一条还会被串行排队，看起来就是「浏览器卡住了」。
//
// 判定只依赖可观测事实（当前文档路径），不猜测平台状态字段，也不在这里吞掉任何
// 需要人工处理的情况（风控 / 登录失效由既有 access 分类负责）。
//
// 这属于 owner 允许的边界情况：允许发生一次导航/点击去确认，然后立即跳过。

// gonePathJS 读取当前顶层文档路径，用于判断是否落到平台的「帖子不存在」占位页。
const gonePathJS = `() => location.pathname`

// gonePathPrefixes 是平台用于「内容不存在/不可访问」的占位路径。
var gonePathPrefixes = []string{"/other", "/404", "/not-found"}

// noteGoneByPath 判断当前页面是否已被平台落到「帖子不存在」占位页。
// 只读浏览器位置，不产生导航、不点击、不读页面文字。
func noteGoneByPath(page *rod.Page) bool {
	res, err := page.Eval(gonePathJS)
	if err != nil {
		return false
	}
	return isGonePath(res.Value.Str())
}

// isGonePath 判断路径是否为平台的「内容不存在/不可访问」占位页。
func isGonePath(path string) bool {
	for _, prefix := range gonePathPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// hasDetailFields reports whether a noteDetailMap entry is the detail response
// rather than the card preview the list page seeds on click. Any detail-native
// field counts; an empty caption is still a real detail (image-only posts).
func hasDetailFields(raw json.RawMessage) bool {
	var state struct {
		Note map[string]json.RawMessage `json:"note"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return false
	}
	for _, key := range []string{"desc", "time", "interactInfo"} {
		if _, ok := state.Note[key]; ok {
			return true
		}
	}
	return false
}
