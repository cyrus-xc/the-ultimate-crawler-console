package xiaohongshu

import "testing"

// A non-+86 account finishes the QR login on rednote.com; that session is a
// guest on xiaohongshu.com, so the login helper must refuse to save it.
func TestIsOverseasHost(t *testing.T) {
	for host, want := range map[string]bool{
		"www.rednote.com":      true,
		"rednote.com":          true,
		"WWW.REDNOTE.COM.":     true,
		"www.xiaohongshu.com":  false,
		"xiaohongshu.com":      false,
		"notrednote.com":       false,
		"rednote.com.evil.com": false,
		"":                     false,
	} {
		if got := IsOverseasHost(host); got != want {
			t.Errorf("IsOverseasHost(%q) = %v, want %v", host, got, want)
		}
	}
}
