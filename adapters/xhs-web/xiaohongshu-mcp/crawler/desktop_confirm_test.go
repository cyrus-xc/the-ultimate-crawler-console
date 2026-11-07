package crawler

import (
	"context"
	"testing"
)

func TestDesktopConfirmCannotAuthenticateMissingBrowser(t *testing.T) {
	e := New()
	defer e.Close()
	if err := e.ConfirmDesktopLogin(context.Background()); err == nil || err.Error() != "LOGIN_REQUIRED" {
		t.Fatalf("missing browser accepted: %v", err)
	}
}
