# Discovery sessions v1

Implementation: [session lifecycle and date boundaries](../service/discovery_sessions.js),
[HTTP routes](../service/server.js), [phone card relocation](../adapters/xhs-phone/navigation.js),
[phone response capture](../adapters/xhs-phone/consumer.js),
[Web DOM card navigation](../adapters/xhs-web/xiaohongshu-mcp/xiaohongshu/feed_open.go).
Design/limitations: [implementation record](../docs/DISCOVERY_SESSIONS.md).

All routes use the existing local Bearer authentication and scope. Browser origins
are rejected. This is a synchronous, two-round XHS API; it does not submit queue
work behind its own device reservation. Devices must advertise both profile.posts
and post.detail and have an enabled adapter. No alternate provider is selected on
failure. Both Web and Android use the same contract.

## Round one

`POST /v1/discovery-sessions`

```json
{"schema_version":"crawler.discovery.v1","platform":"xiaohongshu",
 "user_id":"<observed 24-hex UID>","routing":{"kinds":["web","android"],"device_ids":[]},
 "mode":"count","count":20,"timeout_seconds":7200}
```

Exactly one mode:
- `count`: integer 1..1000, no startdate/enddate. Collect whole pages until the
  count is reached; returning extra cards is intentional. Short/incomplete
  coverage is explicit, never silently reported as meeting the count.
- `date`: `startdate` required, `enddate` optional, no count. Both are ISO 8601
  timestamps with timezone. Omitted enddate is the service clock at open.
  Inclusive `[startdate,enddate]`; only cards within that range are returned.
  Pinned cards are checked individually. Non-pinned chronological order is an
  explicit caller assumption. Missing dates are read from selected detail probes;
  cached indices locate the inclusive boundaries without reading every body.
  Missing pin/date evidence or an unreached date boundary is an error.

`timeout_seconds` defaults to 7200, accepts 30..86400, and includes both collection
and LLM waiting. Set it to the total allowed model budget plus collection and
cleanup time. The service renews the exclusive device lease during that wait;
clients do not receive raw lease tokens or need a heartbeat endpoint.

Response (201):

```json
{"schema_version":"crawler.discovery.v1","session_id":"<uuid>",
 "device_id":"web:xhs:default","state":"awaiting_selection",
 "expires_at":"2026-11-08T12:00:00.000Z",
 "cards":[{"note_id":"<observed ID>","title":"observed title",
   "body":null,"body_observed":false,"cover_url":"<observed URL or null>",
   "published_at":null,"is_pinned":false,"observed_url":null,"index":0}],
 "coverage":{"complete":true,"stop_reason":"target_loaded",
   "loaded_count":20,"returned_count":20,"date_probe_count":0,
   "order_assumption":"non_pinned_newest_first"}}
```

Directly observed list time/create_time fields populate `published_at` with
`published_at_source: "profile_payload"`. No date is ever derived from note IDs.
Only missing dates require detail probes, marked `published_at_source: "detail"`.

A date-range card may have published_at null when its membership is established
by its position between observed date boundaries. Actually observed nonempty list text is returned as `body`, with
`body_observed: true` and `body_source: "profile_excerpt"`. It is a list excerpt,
not a claim that the complete detail body was read. Without observed list text,
body is null and body_observed is false. Private date probes never populate the
card body. `note_type` preserves the observed media type when present. Cover URLs are observed platform URLs; no cover is synthesized. The raw
probe data stays within the session and is not presented as card text.

## Round two (mandatory, including empty selection)

`POST /v1/discovery-sessions/{session_id}/complete`

```json
{"selected_ids":[]}
```

Choose 0..3 unique IDs from the returned cards. Each selected note is read on the
same reserved device; Web requests actual share capture, Android preserves an
actually observed share link when supplied by its response. A missing share URL
is not manufactured. Empty selection performs no detail read and still releases.

Response: `{session_id,state:"completed",details:[{note_id,data}],released:true}`.
`data` is the existing adapter detail data envelope (raw note plus observation
and share evidence). Android also returns `navigation`, containing only observed
action/index/identity-check metadata. `native_operation` distinguishes the actual
image_detail or video_detail response format; the latter uses the observed
rec.xiaohongshu.com videofeed contract and direct data array. It is not LLM content. A repeated identical successful
completion is idempotent for the current service lifetime; changing IDs conflicts.

`POST /v1/discovery-sessions/{session_id}/cancel {}` aborts owned work, drains
input, and releases. Errors use the existing `{error:{code,scope}}` envelope.
Invalid selection leaves the session available for correction or empty completion.
Operational failures clean up its reservation. A first-round HTTP disconnect
aborts its collection and cleans up; no caller can receive or use that session.

Sessions are service-process scoped, not durable resume jobs. A service crash
leaves its persisted lease to expire and quarantine under the existing supervisor
protocol. It never resumes input from stale in-memory session IDs. A cleanup or
stop timeout quarantines instead of falsely declaring the device released.
