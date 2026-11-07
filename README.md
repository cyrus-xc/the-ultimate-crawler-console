# The Ultimate Crawler Console backend

A device-oriented crawler queue for the xhs-analysis console. The service owns requests, device leases, checkpoints and collection errors. Pipeline business policy and all UI stay in xhs-analysis.

Current implementation: durable SQLite requests, manual business continuation, UI-tree control self-healing, API, scoped idempotency, per-device leases, fencing, effort allocation, fair dispatch, checkpoint/results transactions, explicit pause/cancel, device failover, and a local worker contract. **No live adapter is enabled yet.** The standalone API accepts and stores work but does not run browsers or ADB. Local worker and adapter integration are under development. Do not switch production pipeline calls to this service yet.

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

Python client: `clients/python/crawler_queue.py`. The client never implements browser/ADB recovery; it preserves service errors and request IDs. Worker/lease mutation is currently in-process only, not exposed to arbitrary HTTP callers.

## Migration

See [execution plan](docs/EXECUTION_PLAN_ZH.md) and [source manifest](docs/migration-manifest.json). Source hashes refer to the actual dirty xhs-analysis worktree, not only its HEAD. Preserve existing response readers, normalizers, evidence and cache semantics. The change to phone collection replaces App internal-method request triggering with normal deep-link navigation/taps/swipes; it does not replace structured interface response reads with OCR.
