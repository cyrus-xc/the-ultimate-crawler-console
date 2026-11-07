# Normal scanner navigation fallback

`scanner_album.png` is the album control cropped from the OnePlus 1440×3120
screen during a real authorized Douyin login test (2026-11-08). It contains no
QR, account identifier or platform content. The phone login helper first tries
UIAutomator. Douyin's animated scanner can refuse idle accessibility dumps; only
then does the helper compare this icon against one explicitly requested frame.
A correlation below 0.95 stops the action. It does not use OCR, read note content,
start streaming, or reuse stale accessibility nodes. Different resolutions/UI
versions require new observed calibration, never blind coordinate substitution.
