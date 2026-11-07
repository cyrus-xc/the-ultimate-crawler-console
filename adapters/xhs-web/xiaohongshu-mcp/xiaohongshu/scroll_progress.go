package xiaohongshu

import "time"

// Preserve the former three x 1.5s loading opportunity even when random
// pauses are short. No growth is still partial evidence, never proof of end.
func scrollStalled(rounds int, elapsed time.Duration) bool {
	return rounds >= 3 && elapsed >= 4500*time.Millisecond
}
