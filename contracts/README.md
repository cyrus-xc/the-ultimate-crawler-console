# Request contract version 1

Other APIs: [API index](API_INDEX.md), including [two-round discovery](discovery-sessions-v1.md).

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

Q11 extends each decision with `phase` and `subject_id`: `page`, `detail_start`,
`detail_ready`, or `profile_note`. The checkpoint's `decision` member supplies
these values, so distinct stages have distinct decision identities. A
`detail_ready` response requires an explicit Boolean `capture_share` alongside
`action`; `false` means skip sharing, not stop collection. Other stages reject
that field. `stop` cannot request a new share capture. Python callbacks receive
phase information as `unit["decision"]` and may return
`{"action":"continue", "capture_share":False}`. Worker adapters receive this
structured decision, including after failover as `context.resumeDecision`.
Existing v3 decisions migrate to phase `page` without losing their checkpoint,
action, deadline, or waiting state (database schema v4).

The pipeline adapter must preserve source-specific callback semantics: Web
`detail_ready` bool selects sharing; `profile_note` false stops, non-bool continues.
Native profile selector truthy stops; its observer return value is ignored.
These mappings are not business policy and do not serialize Python functions.

## Durable original-response references

Results retain their `seq`, `item_key`, `attempt_id`, phase and observation clock.
Complete platform response bodies live once in the shared private
`XHS_RAW_EVIDENCE_ROOT` (default
`/run/media/pcd/optane2/database/backup/raw-evidence`), not inside SQLite result
JSON. A reference is exactly:

```json
{"schema":"raw_ref.v1","sha256":"<64 lowercase hex>","observation_id":"<64 lowercase hex>","pointer":""}
```

`evidence.sqlite` contains immutable producer-owned UTF-8 JSON bytes in
`objects(hash,bytes,content)` and independent canonical observation records in
`observations(hash,object_hash,metadata)`. Capture commits both rows atomically
with WAL, synchronous FULL, a 30-second busy timeout, foreign keys and immutable
UPDATE/DELETE guards. Read connections are read-only/query-only. Hashes describe these exact bytes, not a semantic re-encoding:
readers must not parse and re-encode to manufacture another original. Existing
adapter objects use their first durable producer JSON representation. Original
wire whitespace/number spelling already consumed by an adapter's JSON parser
is not claimed to survive that earlier boundary.

The observation metadata BLOB contains sorted-key, compact UTF-8 JSON with `schema`, `sha256`, integer `bytes`, `media_type`, `platform`,
`kind`, `subject`, `observed_at`, `source`, `outcome`. Subjects and source metadata
have string leaves, and an unknown observation time stays null. Identical body
bytes deduplicate; different observations do not acquire each other's clocks.
A fragment uses a strict RFC 6901 JSON pointer into the same object. Python and
Node read the same files and verify object and observation hashes before use.

| Result source | Durable data |
| --- | --- |
| XHS Web | `data.raw_ref` replaces `data.raw` and points at that original raw body; its note/feeds/comments remain addressable by pointer. |
| XHS native | `data.response_ref` replaces `data.response`. `data.raw` retains the explicit normalized business projection, with duplicate `_native_original` removed. `data.raw.native_profile_ref` replaces native_profile and points into the original response. Never append Web `/note` paths to this response reference. |
| Douyin | `data.records[].raw_ref` replaces each record body. Endpoint, capture clock and request metadata remain. Duplicate `data.body` and `data.items` are omitted. A resolved link retains explicit `data.resolved_url`, `post_id` and `user_id` when observed. |

Result reads return these references without automatic hydration. A consumer
explicitly reads only the original fragment needed for normalization or audit,
then keeps business fields and the original reference. No body/ref fallback or
second archived wrapper is part of this contract. First committed item evidence
wins across retries; pause/resume, decisions, checkpoints, leases and error
history retain their existing semantics. Archive failures are item errors, never
a phone/device fault. Removing a queue/run reference does not garbage-collect a
shared original. Historical conversion is a separately verified migration;
starting this service never silently rewrites historical rows.
