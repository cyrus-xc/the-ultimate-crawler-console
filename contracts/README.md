# Request contract version 1

`service/contract.js` currently owns runtime validation and defaults. The schema
version is `crawler.request.v1`. Do not create a second independently maintained
validator in a pipeline.

Required fields: schema_version, idempotency_key, platform, operation, targets.
Platforms: xiaohongshu, douyin. Effort: full, half, auto (default).

Operations and target fields:

| Operation | Target |
| --- | --- |
| search.posts, place.search | keyword |
| profile.get, profile.posts | user_id |
| post.detail, post.comments | post_id |
| place.posts | place_id |

Each target may retain an observed_url for adapter-side host and identity
validation. An operation being part of the contract does not make it available:
only verified registered adapter capabilities can execute it.

Limits: max_pages (default 20), execution_timeout_seconds (600),
queue_timeout_seconds (1800). Routing can constrain kinds (web, android) and
device_ids. Cache modes: prefer_fresh, refresh, only. Context carries pipeline,
run_id, stage, source_revision; it grants no file access.

Device registrations and worker mutation are in-process APIs in this first
implementation. The HTTP server exposes authenticated submission, inspection,
durable result/event pagination, and pause/resume/cancel/retry only. Worker and
stream/control HTTP protocols will be added with their corresponding verified
execution paths.

Manual continuation: set `continuation: {mode: "manual", timeout_seconds: 300}`.
The worker commits data/checkpoint and calls waitForDecision(). The durable event
`business.decision_required` names a decision ID. The pipeline posts
`{action: "continue"}` or `{action: "stop"}` to
`/v1/requests/:id/decisions/:decisionId`. Repeated identical decisions are
idempotent; contradictory decisions are rejected. Business policy stays in the
pipeline. Ordinary requests omit continuation and collect automatically.

`GET /v1/requests/:id/events` supports JSON pagination or SSE. SSE accepts
Last-Event-ID; events remain persisted across disconnects.

## Pipeline-owned business decisions

Requests with `continuation: {mode: "manual"}` commit observations and a
checkpoint before waiting. The Python client's `wait_with_decisions(id, callback)`
calls `callback(unit, observations)` locally. Observations include every committed
result for that unit in order, and `unit.checkpoint` belongs to the queue. Return
`"continue"` or `"stop"`; Python functions are never transmitted to the backend.
The worker fences the next input while a decision is pending and after stop.
Decisions are idempotent and checkpoint-bound. Callback failure leaves the decision
pending; it does not implicitly continue, cancel, or submit a duplicate request.
