# The Ultimate Crawler Console backend

A device-oriented crawler queue for the xhs-analysis console. The service owns requests, device leases, checkpoints and collection errors. Pipeline business policy and all UI stay in xhs-analysis.

Current implementation: durable SQLite requests, manual business continuation, UI-tree control self-healing, API, scoped idempotency, per-device leases, fencing, effort allocation, fair dispatch, checkpoint/results transactions, explicit pause/cancel, device failover, and a local worker contract. **No live collection adapter is enabled yet.** Stage 2 adds a persistent scheduler, external device leases, an opt-in fenced ADB gateway, discovery, and legacy-worker isolation. The default adapter registry is empty; submitted collection work is stored but not executed. Do not switch production pipeline collection calls to this service yet.

`auto` can use the only compatible device. With two or more compatible devices it leaves one free, or two under competing demand when capacity permits. `half` rounds up. Each pagination chain stays sequential; a request can parallelize independent targets. An expired lease quarantines its device until the supervisor confirms that the old input process has stopped.

## Development

```sh
npm ci
npm test
```

Tests use simulated adapters and temporary databases. HTTP tests only listen on loopback. They do not operate phones or call platform APIs. Preserve `ENABLE_TIKHUB_NETWORK=0` and `ENABLE_LLM_NETWORK=0` for all tests and child processes.

## Local API

Configure `CRAWLER_SERVICE_TOKEN_FILE` to a private file containing a random service credential of at least 32 characters. Do not commit or print this credential. Set `CRAWLER_RUNTIME_DIR` for the SQLite state directory and optionally `CRAWLER_PORT` (default 18323). Run `npm start`; the service binds to `127.0.0.1` only. Platform sessions and existing pipeline data are not copied or touched.

All `/v1` endpoints require `Authorization: Bearer <credential>`. Direct browser origins are rejected; use the existing authenticated console backend as the proxy. `/health` is a minimal read-only probe. Requests use `crawler.request.v1` and `POST /v1/requests`; polling, results, durable event pagination, pause/resume/cancel/retry are available. Durable SSE is available through the events endpoint with Accept: text/event-stream. Stream/control endpoints and production adapter integration remain pending.

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
through capture drain and runtime cleanup. The standalone HTTP server still has
no automatically enabled live consumers; these modules are not a deployment switch.

## Stage 2 device gateway

Set `CRAWLER_DEVICE_GATEWAY_ENABLED=true` only after draining existing phone
operators. `CRAWLER_LEGACY_ANDROID_LOCK_DIR` must be the absolute original
`XHS_ANDROID_LOCK_DIR`; the service refuses to enable input without its migration
barrier. The original console operators use `CRAWLER_DEVICE_LOCK_MODE=queue`,
`CRAWLER_SERVICE_URL`, and the same private credential file. No environment or
running deployment is switched by this change.

The independent guardian retains the legacy lock after a service crash. Forced
command cancellation is also treated as uncertain remote state: the barrier
must remain until an operator/supervisor has verified that remote input stopped.
Do not delete or reclaim the lock merely because the service or local ADB child
is gone. A normal, fully drained shutdown releases it. Per-device quarantine and
persisted command records are separate recovery checks.

Discovery reads `adb devices -l` and registers phones without advertising
collection capabilities. Single screenshots are explicit commands; no continuous
stream is started. See [stage 2 acceptance](docs/PHASE2_ACCEPTANCE_ZH.md).
