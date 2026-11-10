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
 "mode":"count","count":40,"exclude_pinned":true,"timeout_seconds":7200}
```

Exactly one mode:
- `count`: integer 1..1000, no startdate/enddate. Collect whole pages until the
  count is reached; returning extra cards is intentional. Short/incomplete
  coverage is explicit, never silently reported as meeting the count.
  Optional `exclude_pinned: true` excludes observed pinned cards before counting
  the quota and from returned cards. It replays increasing profile targets until
  enough non-pinned cards, observed profile end, no growth, or the 1000-card bound.
  Unknown pin evidence fails with `DISCOVERY_PIN_STATE_UNOBSERVED`. Omitted/false
  preserves the original count behavior, including pinned cards. This option is
  count-only. Count never reads detail bodies in round one.
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
   "body":null,"body_observed":false,"like_count":null,"cover_url":"<observed URL or null>",
   "published_at":null,"is_pinned":false,"observed_url":null,"index":0}],
 "coverage":{"complete":true,"stop_reason":"target_loaded",
   "loaded_count":40,"returned_count":40,"date_probe_count":0,
   "target_met":true,"end_observed":false,"eligible_count":40,"excluded_pinned_count":0,
   "order_assumption":"non_pinned_newest_first"}}
```

For count, `complete` and `target_met` mean the requested quota was reached.
`end_observed: true` proves that a short profile is exhausted; `false` with
`target_met: false` is incomplete coverage, not proof of a newcomer. These two
flags can both be true. Full pages are retained, so downstream business sampling
chooses its requested number from returned cards. Card order is observation order,
not likes rank. `like_count` is an observed nonnegative integer or null; missing or
abbreviated values are not guessed as zero. `eligible_count` is returned-card count;
`excluded_pinned_count` counts observed pins excluded from a count request.

The response also includes `profile: null` or the observed envelope
`{profile: raw.profile, profile_user_id, native_profile?}`. Only an actually
returned, identity-matched profile header is exposed. No extra header operation
is added to phone discovery; its profile can be null.

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

## KOL profile-end observation (opt-in)

A count-mode caller may explicitly send
`"profile_end_policy":"observed_terminal_v1"`. The KOL evidence caller owns this
opt-in; ordinary discovery, search, date-mode, and queued profile requests do not
enable it. Other values and date-mode use are rejected. Android remains unchanged.
An existing valid cached listing must not be refreshed merely to obtain this field.

For opted-in Web reads, the first-round response adds
`profile_end_observation`. Each existing Go profile read performs at most one
additional DOM evaluation after its existing collection loop; a logical session
may already contain multiple profile reads. The service retains only the last
observation. This does not add navigation, scrolling, platform HTTP requests, or
a second observation command.

The observation is **not a profile-end decision**. Its schema is
`xhs_profile_end_observation_v1`, with `terminal_decision:"unverified"`.
`end_observed` remains false in the Web collector. Neither few cards, no growth,
viewport geometry, loading flags, nor text such as another page's “THE END” proves
that the current user's published-note list has ended.

The observation contains only the current-profile UID match, active tab index and
allowlisted tab kind, identified/visible card counts, the last identified card's
note ID and bounded CSS path, up to six visible tail text/path candidates, bounded
semantic loading-node paths, and boolean loading-state fields. It emits no page
URL, raw response, authentication data, or arbitrary application state. Text URLs
and token assignments are redacted before return. DOM failure is represented by a
bounded `unavailable_reason`; it does not retry collection or assert completion.

Current tests use synthetic DOM fixtures to verify propagation, negative cases,
and redaction. They do not establish a genuine Xiaohongshu profile terminal
signal. The remaining acceptance step requires one explicitly authorized, bounded
KOL refresh through the business UI after the evidence policy is deployed. Preserve
that run's observation and same-UID/list context, then derive and test a positive
terminal rule from the actual evidence. Existing incomplete lists must not be
rewritten to claim an end, and this observation opt-in cannot bypass cache policy.

## Round two (mandatory, including empty selection)

`POST /v1/discovery-sessions/{session_id}/complete`

```json
{"selected_ids":[]}
```

Choose 0..10 unique IDs from the returned cards. Each selected note is read on the
same reserved device; Web requests actual share capture, Android preserves an
actually observed share link when supplied by its response. A missing share URL
is not manufactured. Empty selection performs no detail read and still releases.

Optional completion fields are `comments` (boolean, default false),
`comment_target` (1..100, default 20), `comment_seconds` (1..3600, default 300),
`comment_mode` (`sample` or `limited_lazy_load_on_scroll`, default latter), and
`comment_lazy_load_limit` (1..20, default 2). Web uses the existing detail/comment
collector and these native options. Android requires verified `post.comments`
capability, relocates the same selected card, captures up to the target/page/time
budget, and restores the profile before the next selection. Its page budget is
`comment_lazy_load_limit`; it does not claim Web's reply-expansion behavior.
Missing Android capability leaves the session available for empty completion.

Comments appear in the existing `data.raw.comments.list` envelope. Android also
preserves per-page `comment_evidence`, `comments_stop_reason`, and
`comments_complete` based on observed end only. A capped collection is not complete.
Details preserve existing observed share/evidence envelopes. Empty selection still
performs no detail/comment reads. Repeating completion must retain the same IDs
and effective comment options. Business-specific smaller selection limits belong
to callers (CampaignWatch continues selecting at most three).

`detail` is not a third round-one mode: it is the selected-note operation in round
two, also independently available as queued `post.detail`.

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
