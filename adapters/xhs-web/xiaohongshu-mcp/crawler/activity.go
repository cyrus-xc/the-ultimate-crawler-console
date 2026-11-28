package crawler

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-rod/rod"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// Activity runs one non-reading action in its own tab of the collector
// browser. The service starts it only when no read is active.

type BrowseRequest struct {
	Seconds int `json:"seconds"`
	Opens   int `json:"opens"`
}

type FollowRequest struct {
	UserID string `json:"user_id"`
	Token  string `json:"xsec_token,omitempty"`
}

type PublishRequest struct {
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	Tags       []string `json:"tags,omitempty"`
	Images     []string `json:"images"`
	Visibility string   `json:"visibility,omitempty"`
}

var visibilities = map[string]bool{"": true, "公开可见": true, "仅自己可见": true, "仅互关好友可见": true}

// Validate keeps a publish to approved local images and site limits.
func (r PublishRequest) Validate(root string) error {
	if r.Title == "" || utf8.RuneCountInString(r.Title) > 20 || r.Content == "" || utf8.RuneCountInString(r.Content) > 1000 ||
		len(r.Images) == 0 || len(r.Images) > 9 || len(r.Tags) > 10 || !visibilities[r.Visibility] {
		return errors.New("INVALID_PUBLISH")
	}
	if root == "" {
		return errors.New("PUBLISH_ROOT_UNSET")
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return errors.New("PUBLISH_ROOT_UNSET")
	}
	for _, p := range r.Images {
		real, err := filepath.EvalSymlinks(p)
		if err != nil || !strings.HasPrefix(real, base+string(os.PathSeparator)) {
			return errors.New("PUBLISH_IMAGE_OUTSIDE_ROOT")
		}
		ext := strings.ToLower(filepath.Ext(real))
		if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" {
			return errors.New("INVALID_PUBLISH")
		}
	}
	return nil
}

func (e *Engine) activityTab(ctx context.Context, key string) (*rod.Page, func()) {
	e.ensureBrowser()
	e.mu.Lock()
	page := e.page(ctx, key)
	e.busy[key] = true
	e.mu.Unlock()
	return page, func() {
		e.mu.Lock()
		e.busy[key] = false
		e.used[key] = time.Now()
		e.mu.Unlock()
	}
}

func (e *Engine) Browse(ctx context.Context, r BrowseRequest) (map[string]any, error) {
	page, done := e.activityTab(ctx, "explore")
	defer done()
	return xiaohongshu.BrowseExplore(ctx, page, r.Seconds, r.Opens)
}

func (e *Engine) Follow(ctx context.Context, r FollowRequest) (string, error) {
	page, done := e.activityTab(ctx, "user:"+r.UserID)
	defer done()
	return xiaohongshu.FollowUser(ctx, page, r.UserID, r.Token)
}

func (e *Engine) Publish(ctx context.Context, r PublishRequest) error {
	page, done := e.activityTab(ctx, "creator")
	defer done()
	action, err := xiaohongshu.NewPublishImageAction(page.Context(ctx))
	if err != nil {
		return err
	}
	return action.Publish(ctx, xiaohongshu.PublishImageContent{Title: r.Title, Content: r.Content, Tags: r.Tags, ImagePaths: r.Images, Visibility: r.Visibility, IsOriginal: true})
}
