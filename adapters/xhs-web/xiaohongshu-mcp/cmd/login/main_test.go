package main

import (
	"errors"
	"testing"

	pkgerrors "github.com/pkg/errors"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// The decision taken right after WaitForLogin: a login that landed on
// rednote.com (overseas account) is neither saved nor reported as success.
func TestSaveLogin(t *testing.T) {
	overseas := pkgerrors.WithMessage(xiaohongshu.ErrOverseasLogin, "www.rednote.com")
	cases := []struct {
		name      string
		unusable  error
		saveErr   error
		want      int
		saved     bool
	}{
		{"overseas account", overseas, nil, exitOverseas, false},
		{"host unreadable", errors.New("read login host failed"), nil, exitNotSaved, false},
		{"mainland account", nil, nil, exitSaved, true},
		{"save fails", nil, errors.New("disk full"), exitNotSaved, true},
	}
	for _, c := range cases {
		saved := false
		got := saveLogin(c.unusable, func() error { saved = true; return c.saveErr })
		if got != c.want || saved != c.saved {
			t.Errorf("%s: saveLogin = %d saved=%v, want %d saved=%v", c.name, got, saved, c.want, c.saved)
		}
	}
}
