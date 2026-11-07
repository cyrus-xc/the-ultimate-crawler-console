package xiaohongshu

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAlertPageRecordsCaptureAndFailureWithoutReusingOldImage(t *testing.T) {
	dir := t.TempDir()
	stamp := time.Now()
	if err := saveAlertPage(dir, "CRAWLER_VERIFICATION_REQUIRED", []byte("fixture"), stamp); err != nil {
		t.Fatal(err)
	}
	read := func() map[string]any {
		b, e := os.ReadFile(filepath.Join(dir, "incident.json"))
		if e != nil {
			t.Fatal(e)
		}
		var m map[string]any
		if e = json.Unmarshal(b, &m); e != nil {
			t.Fatal(e)
		}
		return m
	}
	m := read()
	if m["error"] != "CRAWLER_VERIFICATION_REQUIRED" || m["file"] == "" {
		t.Fatal(m)
	}
	f := filepath.Join(dir, m["file"].(string))
	st, e := os.Stat(f)
	if e != nil {
		t.Fatal(e)
	}
	if st.Mode().Perm() != 0600 {
		t.Fatal("screenshot must be private")
	}
	if err := saveAlertPage(dir, "CRAWLER_ACCESS_RESTRICTED", nil, stamp.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if read()["file"] != "" {
		t.Fatal("failed capture must not reuse old screenshot")
	}
}
