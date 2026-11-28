package crawler

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPublishRequestStaysInsideTheApprovedFolder(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "a.jpg")
	outside := filepath.Join(t.TempDir(), "b.jpg")
	for _, p := range []string{inside, outside} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(root, "link.jpg")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	ok := PublishRequest{Title: "上海一人食", Content: "正文", Images: []string{inside}}
	if err := ok.Validate(root); err != nil {
		t.Fatalf("valid request refused: %v", err)
	}
	cases := map[string]PublishRequest{
		"outside":    {Title: "t", Content: "c", Images: []string{outside}},
		"symlink":    {Title: "t", Content: "c", Images: []string{link}},
		"no images":  {Title: "t", Content: "c"},
		"long title": {Title: "这是一个超过二十个字的标题这是一个超过二十个字的标题", Content: "c", Images: []string{inside}},
		"visibility": {Title: "t", Content: "c", Images: []string{inside}, Visibility: "all"},
	}
	for name, r := range cases {
		if r.Validate(root) == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if ok.Validate("") == nil {
		t.Error("publish without a configured root accepted")
	}
}
