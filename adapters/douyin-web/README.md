# Douyin queue consumer

`CRAWLER_DOUYIN_WEB_ENABLED=true` registers `web:douyin:default`, independent of
XHS. Configure `CRAWLER_PYTHON` to a Python with this directory's requirements,
`DOUYIN_BROWSER_PROFILE` to the existing dedicated profile,
`CRAWLER_BROWSER_EXECUTABLE` (or the shared browser cache), and the hidden
`CRAWLER_WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR`. No session is copied.

A persistent private stdio process keeps its browser alive between requests.
Before every navigation, in-page fetch or scroll, it waits for Node's fenced
input admission. Cancel and shutdown wait for the owned process tree to exit.
Neither stderr nor credentials are returned as request errors.

Search observes structured responses to normal page navigation/scroll. Detail,
profile, comments and mix views preserve the previous page-signed fetch path.
Every result page carries original `body`, `items`, cursor, and `records` with
endpoint/body/captured_at/status for the existing pipeline materializer. All
loaded items survive a stop condition. Profile metadata and mix view evidence
remain explicit records. Shortlinks resolve through normal browser navigation
restricted to Douyin's known domains. Unknown filters and reply collection fail
explicitly instead of silently changing the requested operation.

Tests use fake transports and private child processes. Deployment still requires
an actual login/collection smoke; source registration alone is not evidence of
a working session or successful platform response.

## 2026-11-08 smoke record

The prior default Douyin profile did not exist on this host. A dedicated profile
under the new backend runtime was created. Its Chromium opened on hidden
`wayland-2` concurrently with the XHS smoke; `is_logged_in()` returned false.
This verifies process/display separation, not authenticated collection. The
smoke browser was closed. Platform operation acceptance remains pending login.
