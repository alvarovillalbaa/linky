# First import/conversion acceptance attempt

5 November 2026. [Run 42005457064](https://github.com/alvarovillalbaa/linky/actions/runs/42005457064),
job 127170932247, 09:48:46–09:49:48 UTC, source
`9e45e566369658858e1c05af439ae926d24aa86b` (preparation `2210f49e`).
The immutable [receipt](extension-attempt-1.json) preserves all compressed raw
streams and exact matching before/after source vectors. Node 24.21.0.

Source checks, **30/30 relevant HTTP cases and 23/23 real PostgreSQL cases
passed**, zero fail/cancel/skip/TODO. All stream byte lengths/SHA-256 values and
TAP totals were decoded/validated before this record. The four unchanged pure
helper inputs carried forward their previous 34 accepted cases without rerun.
Current HTTP/database scopes close for unchanged inputs.

Desktop completed its actual 51-valid/one-invalid CSV journey, lost the first
50-row committed reply, explicitly retried the same body and separately resumed
the last row. It issued/rotated/revoked ingest keys, accepted five declarations
without duplicate replay, and rendered exact USD `18014398509481982` and JPY `7`
minor-unit totals. Its source-specific pass remains historical evidence.

Narrow failed waiting for `#grant-label` after selecting a saved link following
refresh. The exact browser state at failure was not retained, so the timeout
alone does not establish a cause. Independent source inspection found Manage
buttons remained clickable while a refresh was busy even though their handler
refused busy actions. Repair that real readiness defect and test pending-refresh
button state. Since UI source changes, rerun both layouts; do not count the old
desktop result as current-source proof. Do not repeat the unchanged 53 backend
cases.

Both created contexts, browser/process group, server, pools and admin client
closed; identity-checked scratch was removed, no cleanup errors/interruption.
All four command groups drained/disappeared without forced cleanup/timeouts.
The outer install-removal guard conservatively refused removal after browser
exit 1, leaving its owned installations for ephemeral runner teardown. Container
and network removal succeeded. Do not call that outer removal verified.
