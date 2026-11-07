# The Ultimate Crawler Console backend

A device-oriented crawler queue for the xhs-analysis console. The service owns requests, device leases, checkpoints and collection errors. Pipeline business policy and all UI stay in xhs-analysis.

The service provides durable SQLite requests, a persistent scheduler, device leases,
fencing, fair dispatch, checkpoints, manual business decisions, failover, independent
XHS/Douyin Web consumers, and UI-driven passive phone response capture. Consumers
are enabled explicitly; a phone advertises only its configured verified capabilities.
Pipeline business decisions remain in xhs-analysis. See [deployment and recovery](docs/DEPLOYMENT_ZH.md)
and [phone verification](docs/PHONE_UI_ACCEPTANCE_ZH.md) for operational limits.

`auto` can use the only compatible device. With two or more compatible devices it leaves one free, or two under competing demand when capacity permits. `half` rounds up. Each pagination chain stays sequential; a request can parallelize independent targets. An expired lease quarantines its device until the supervisor confirms that the old input process has stopped.

## Development

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r adapters/douyin-web/requirements.txt
PYTHON=.venv/bin/python npm test
```

Tests use simulated adapters and temporary databases. HTTP tests only listen on loopback. They do not operate phones or call platform APIs. Preserve `ENABLE_TIKHUB_NETWORK=0` and `ENABLE_LLM_NETWORK=0` for all tests and child processes.

## Local API

Configure `CRAWLER_SERVICE_TOKEN_FILE` to a private file containing a random service credential of at least 32 characters. Do not commit or print this credential. Set `CRAWLER_RUNTIME_DIR` for the SQLite state directory and optionally `CRAWLER_PORT` (default 18323). Run `npm start`; the service binds to `127.0.0.1` only. Platform sessions and existing pipeline data are not copied or touched.

All `/v1` endpoints require `Authorization: Bearer <credential>`. Direct browser origins are rejected; use the existing authenticated console backend as the proxy. `/health` is a minimal read-only probe. Requests use `crawler.request.v1` and `POST /v1/requests`; polling, results, durable event pagination, pause/resume/cancel/retry are available. Durable SSE is available through the events endpoint with Accept: text/event-stream. Explicit PNG display sessions, exclusive phone control and fenced Web desktop access are also exposed to the console proxy.

Python client: `clients/python/crawler_queue.py`. The client never implements browser/ADB recovery; it preserves service errors and request IDs. External device leases are available to authenticated local operators through `POST /v1/device-leases` and `/v1/device-leases/{assert,heartbeat,command,release}`. Commands carry a lease and are restricted to the registered device and gateway allowlist; arbitrary ADB execution is not exposed.

## Migration

See [execution plan](docs/EXECUTION_PLAN_ZH.md) and [source manifest](docs/migration-manifest.json). Source hashes refer to the actual dirty xhs-analysis worktree, not only its HEAD. Preserve existing response readers, normalizers, evidence and cache semantics. The change to phone collection replaces App internal-method request triggering with normal deep-link navigation/taps/swipes; it does not replace structured interface response reads with OCR.

### Passive phone runtime

`adapters/xhs-phone/runtime.js` owns version checks, the explicitly selected
ADB connection, a dynamically allocated localhost forward, and any Frida server
it starts. Supply a local Frida 16.7.19 Android arm64 binary and its SHA-256;
`adapters/xhs-phone/requirements.txt` pins the matching Python dependency.
Runtime installers/binaries and login state are not source-controlled.
`capture.js`/`capture_cli.py` coordinate a UI action after the observer is ready,
then return its structured response through a private stdio channel. They do not
load the former active App invocation agent. The caller owns the device lease
through capture drain and runtime cleanup. The HTTP service registers these consumers only when enabled and configured with verified device operations.

## Stage 2 device gateway

Set `CRAWLER_DEVICE_GATEWAY_ENABLED=true` only after draining existing phone
operators. `CRAWLER_LEGACY_ANDROID_LOCK_DIR` must be the absolute original
`XHS_ANDROID_LOCK_DIR`; the service refuses to enable input without its migration
barrier. The original console operators use `CRAWLER_DEVICE_LOCK_MODE=queue`,
`CRAWLER_SERVICE_URL`, and the same private credential file. The installed deployment explicitly enables both queue collection and queue device locking; use the deployment guide when switching an existing installation.

The independent guardian retains the legacy lock after a service crash. Forced
command cancellation is also treated as uncertain remote state: the barrier
must remain until an operator/supervisor has verified that remote input stopped.
Do not delete or reclaim the lock merely because the service or local ADB child
is gone. A normal, fully drained shutdown releases it. Per-device quarantine and
persisted command records are separate recovery checks.

Discovery reads `adb devices -l` and registers phones without advertising
collection capabilities. Single screenshots are explicit commands; no continuous
stream is started. See [stage 2 acceptance](docs/PHASE2_ACCEPTANCE_ZH.md).

## Phone-assisted Web login

`tools/phone_web_login.js` uses an explicitly selected logged-in phone to complete
the platform's normal QR login flow. It holds both the Web and phone leases,
imports only the current private login QR, navigates the App UI, verifies browser
authentication and removes the QR before releasing control. It never invokes App
internal data methods. Use the deployment guide for the actual CLI arguments and
platform verification status.

For an Android device missing Chrome, `tools/provision-phone-chrome.js` supports
fixed-package export/install through the same gateway. The local manifest pins
APK hashes; no account/profile data is copied and callers cannot supply arbitrary
ADB commands or file destinations.
