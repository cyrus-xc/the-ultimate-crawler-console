# Two-round discovery implementation record

API: [Discovery sessions v1](../contracts/discovery-sessions-v1.md).
Index: [Local API index](../contracts/API_INDEX.md).

The service owns one external device lease while the caller receives cards,
asks its model to select notes, and completes the second request. Ordinary queue
jobs cannot claim that device during the wait. The service renews the lease and
honors a bounded conversation deadline. Empty second-round IDs explicitly release.

Count mode uses the existing sequential profile collectors and preserves full
loaded pages. Optional `exclude_pinned` replenishes the count using only observed
non-pinned cards; unknown pin state fails. Default behavior still includes pins.
Observed end is reported separately from reaching the requested quota, so short
incomplete collection cannot become evidence of a small portfolio. Public cards
now retain observed numeric likes; unknown counters remain null. Date mode uses directly observed profile dates when available,
then probes only missing dates and binary-searches cached card indices for the
requested boundaries. It independently evaluates pinned cards. No date is derived
from a note ID. This is binary searching loaded indices, not random access to
unseen platform pages. Only cards inside the inclusive date window are returned;
an incomplete date boundary fails visibly.

The observed title, cover, and any actual nonempty list text are retained. List
text is explicitly `body_source: profile_excerpt`; it does not claim a complete
detail body. Date-probe bodies never enter the model's card text. Dates carry
`published_at_source: profile_payload` or `detail`. Three owner-operated Web detail
comparisons agreed exactly with their observed list dates; equality between a
list date and an ID prefix is not evidence that this collector synthesized it.

## Navigation and capture

Web reuses the registered persistent adapter and author tab. Its existing card
navigation locates the observed note ID in the DOM, calls scrollIntoView, saves
scroll positions, and restores the list after the detail overlay closes.

Android discovery goes directly to the existing profile.posts collector; it does
not request the unused user_info header. It retains the normal App navigation,
page response validation, and existing bounded first-page recovery. It adds no
special loading-shell recovery or alternate collector. Expanding the profile
reopens it and replays to a larger target, deduplicating observations; it does not
pretend that pagination continued from a preserved scroll offset.

Android waits for an observed profile tab and grid, then parses the App's actual
combined accessibility card description to identify a unique complete title.
Known visible-card indices determine minimal forward/reverse one-screen swipes.
Ambiguous or missing titles fail instead of opening a different card. The selected
card is tapped once. The returned navigation trace contains actions and indices,
not private UI text. Back must restore the profile tab and a known grid card.
There is no discovery note-deep-link fallback.

One passive observer accepts the two observed native media response formats,
each with its own exact host/method/path/query and response identity checks:

- Image: the existing imagefeed contract and nested data[].note_list[].
- Video: GET rec.xiaohongshu.com/api/sns/v4/note/videofeed and direct data[].

The requested note can appear after other items in the video response; exact ID
selection is mandatory. Actual share links are retained for that target through
the observer's private channel and restored to the corresponding response shape.
No link is manufactured. Capture-local cancellation prevents further navigation
inputs while already-started actions drain, before releasing the device.

## Verification — 2026-11-08

Latest complete offline command:

`ENABLE_TIKHUB_NETWORK=0 ENABLE_LLM_NETWORK=0 PYTHON=.venv/bin/python npm test`

PASS: 255 Node tests and 61 Python tests. Tests cover exclusive holding,
heartbeat, disconnect/cancellation cleanup, empty/idempotent completion, selected
ID limits, missing-date binary probes, explicit excerpt provenance, page replay,
readiness polling, exact title navigation, video host/shape validation, and share
restoration. The system-Python invocation initially lacked cv2; the repository
virtual environment passed the complete suite.

Authorized physical acceptance used android:c7dee0b3, selected only while idle:

| Check | Actual result |
| --- | --- |
| Count 4, select one non-pinned uniquely titled card | 22 cards returned; two forward grid swipes and one exact-title tap; one video detail returned; title, note ID, and author ID matched; valid observed share URL; profile restored and lease released |
| Count 4, empty second round | 22 cards, zero detail probes; empty complete returned zero details and released |
| 2026-10-01 00:00:00 through 2026-11-08 23:59:59 (+08:00), empty second round | 22 loaded, 11 in range, zero detail probes; all 11 IDs exactly matched the independently collected Web window; empty complete released |

The device ended ready, unowned, and not quarantined after each successful check.
Another explicitly requested phone advertised no profile.posts capability and
was correctly refused; capabilities were not changed to bypass verification.

Private local evidence is under
`/tmp/watch-visual-verification/phone-private/c7dee0b3-attempt9/` and
`/tmp/watch-visual-verification/phone-private/c7dee0b3-empty-date-final/`.
Files are mode 0600 inside mode-0700 directories. Earlier failed attempts are
retained separately and do not substitute for these successful receipts. No raw
signed URL or credential belongs in this document. This acceptance proves these
operations on the tested phone, not universal compatibility with every device.

### Transient native image URLs

Only discovery enables a private observer RPC sideband for observed `xhscdn.com`
image URLs. It retains the complete original URL before generic decoding and
redaction, then binds it to the verified note, explicit image field path, and
matching redacted value. Only detached normalized `imageList`/`cover` fields are
restored; response evidence, `native_responses`, and `_native_original` stay
redacted. Video stream URLs and unrelated hosts are excluded. Ordinary queued
captures do not enable this channel. Authenticated discovery clients must download
these URLs in memory and persist local artifact references, never signed media
URLs in observations, logs, reports, or smoke-test receipts.


Private-media fix validation (2026-11-08):

- `ENABLE_TIKHUB_NETWORK=0 ENABLE_LLM_NETWORK=0 PYTHON=.venv/bin/python npm test`:
  256 Node and 62 Python tests passed. Coverage includes ordinary queue opt-out,
  exact note/field/host binding, and detached projection without evidence mutation.
- `node --check adapters/xhs-phone/observe-note-http.js` and `git diff --check` passed.
- Real `android:c7dee0b3` count 20 returned 22 cards; all 22 cover signatures
  were present and none redacted. The previously failing cover downloaded with
  HTTP 200 (80,351 bytes, image/heif), using User-Agent Mozilla/5.0 and the XHS
  homepage Referer. Empty complete returned 200 and released the device.
- Only a safe summary was persisted at
  `/tmp/watch-visual-verification/phone-private/private-media-verification.json`;
  original media URLs were never saved by that verification script. This verifies
  the crawler download path, not the downstream LLM run.

## Portfolio discovery extension

Round two supports up to ten selected cards and optional bounded comments. The
contract documents the options and native/Web differences. Android comment reads
use the existing verified operation, reopen the observed selected card without a
note-deep-link fallback, and restore the profile afterward. Profile metadata is
exposed only when already observed, without adding a legacy phone header read.
These changes are covered offline; no new physical-device acceptance is claimed.

Offline extension validation (2026-11-08):
`ENABLE_TIKHUB_NETWORK=0 ENABLE_LLM_NETWORK=0 PYTHON=.venv/bin/python npm test`
passed 266 Node tests and 62 Python tests. `node --check` passed for discovery
sessions and phone consumer; `git diff --check` passed. Added cases cover pinned
quota replenishment, genuine exhaustion versus incomplete loading, unknown pin
and like evidence, ten-note comments and option idempotence, missing phone comment
capability, capped comment evidence, and bounded profile restoration.
