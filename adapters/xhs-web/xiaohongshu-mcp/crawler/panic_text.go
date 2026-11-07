package crawler

import (
	"fmt"
	"regexp"
)

// urlQuery matches the query part of a URL; xsec tokens and share ids live there.
var urlQuery = regexp.MustCompile(`\?[^\s"'<>]*`)

// panicText is the loggable form of a recovered panic: its message with every
// URL query removed, so the debug log never stores note tokens.
func panicText(v any) string {
	s := fmt.Sprint(v)
	if r := []rune(s); len(r) > 500 {
		s = string(r[:500]) + "…"
	}
	return urlQuery.ReplaceAllString(s, "?…")
}
