package xiaohongshu

import "testing"

func TestMatchingNoteSharePreservesActualOutput(t *testing.T) {
	id := "aaaaaaaaaaaaaaaaaaaaaaaa"
	link := "https://www.xiaohongshu.com/discovery/item/" + id + "?source=webshare&xsec_token=fixture%3D&xsec_source=pc_share&xhsshare=pc_web"
	if matchingNoteShare("title 分享文案 "+link+" 复制", id) != link {
		t.Fatal("lost actual share URL")
	}
	for _, wrong := range []string{
		"https://evil.example/discovery/item/" + id + "?xsec_token=fixture",
		"https://www.xiaohongshu.com/user/profile/" + id + "?xsec_token=fixture",
		"https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb?xsec_token=fixture",
		"https://www.xiaohongshu.com/explore/" + id,
		"https://www.xiaohongshu.com/explore/" + id + "?xsec_token=REDACTED",
	} {
		if matchingNoteShare(wrong, id) != "" {
			t.Fatal("accepted mismatched or unusable link")
		}
	}
}
