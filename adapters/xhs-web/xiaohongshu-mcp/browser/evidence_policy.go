package browser

import (
	"os"
	"strings"

	"github.com/go-rod/rod"
)

// PrepareTextEvidence avoids decoding CDN images/videos for text-only evidence.
// Document, scripts and JSON requests remain available, as do media URLs in JSON.
// Login and the optional MCP UI are unaffected. Visual acquisition can opt out.
func PrepareTextEvidence(page *rod.Page) error {
	if strings.EqualFold(os.Getenv("XHS_CRAWLER_LOAD_MEDIA"), "true") {
		return nil
	}
	return page.SetBlockedURLs([]string{
		"*://sns-webpic*.xhscdn.com/*", "*://sns-img*.xhscdn.com/*",
		"*://sns-avatar*.xhscdn.com/*", "*://sns-video*.xhscdn.com/*",
		"*://sns-video*.xhscdn.net/*", "*.mp4", "*.mp4?*", "*.m3u8", "*.m3u8?*",
	})
}
