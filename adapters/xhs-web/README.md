# XHS queue consumer

The migrated Go engine is the data reader; Node owns its authenticated loopback
session and device lease. Build `xiaohongshu-mcp/cmd/crawler` into a private
runtime binary and configure `XHS_CRAWLER_BIN`. Do not point this setting at a
previous binary: this revision adds `max_pages` and `stream_pages`.

`CRAWLER_XHS_WEB_ENABLED=true` registers `web:xhs:default` with one scheduler
slot. The existing session is referenced through `XHS_BROWSER_PROFILE`,
`COOKIES_PATH`, and `XHS_BROWSER_CACHE`; do not copy a live profile. Stop/drain
its former owner first. The persistent Go session owns its Chromium process.

`CRAWLER_WAYLAND_DISPLAY=wayland-N` and `XDG_RUNTIME_DIR` must identify the
existing hidden desktop socket. The consumer refuses to fall back to the user's
normal desktop. Chromium uses class `ultimate-crawler-xhs`.

The adapter preserves raw results, structured share-selection phases and
profile-walk callbacks. It additionally publishes a raw snapshot after each
search/profile load observation. `max_pages` bounds observed load/scroll rounds;
it does not pretend to control the platform's internal HTTP page size. Whole
loaded batches are retained. A new process replays the entry route, and stable
result keys preserve first observations. Cancellation drains its session before
the worker releases the device.

`params.native_request` is a compatibility escape hatch for the existing read-only
Go Request fields only. Its kind and target must match the normalized queue
request. It never accepts a shell command, host path, or publication operation.
Cache-only reads currently return `CACHE_MISS` without launching a browser; the
pipeline's existing offline evidence cache is preserved separately.

## 2026-11-08 smoke record

The new binary was built and the persistent session started on the existing
hidden `wayland-2` desktop. A bounded search returned `CRAWLER_TIMEOUT`; no
successful search/profile/detail/comments collection is claimed. A separate
read-only inspection of the normal `/explore` page observed login prompts and
no verification prompt. All smoke-owned processes were closed before handing
session ownership back to deployment. Private raw fixtures were not committed.
