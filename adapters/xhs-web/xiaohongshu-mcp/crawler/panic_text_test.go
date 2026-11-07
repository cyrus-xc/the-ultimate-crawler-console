package crawler

import (
	"errors"
	"strings"
	"testing"
)

func TestPanicTextDropsURLQueries(t *testing.T) {
	got := panicText(errors.New(`navigation failed: https://www.xiaohongshu.com/explore/6a?xsec_token=SECRET&xsec_source=pc "context canceled"`))
	if strings.Contains(got, "SECRET") || strings.Contains(got, "xsec_source") {
		t.Fatalf("token kept: %s", got)
	}
	if !strings.Contains(got, "https://www.xiaohongshu.com/explore/6a?…") || !strings.Contains(got, "context canceled") {
		t.Fatalf("message lost: %s", got)
	}
	if long := panicText(strings.Repeat("x", 900)); len([]rune(long)) != 501 {
		t.Fatalf("not bounded: %d", len([]rune(long)))
	}
}
