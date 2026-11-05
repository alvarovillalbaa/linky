# Second extension browser attempt

5 November 2026. [Run 42007061469](https://github.com/alvarovillalbaa/linky/actions/runs/42007061469),
job 127176393752, source `a5d9b6f47fb9c9f4badb1b27eb28a23f6be6b52f`
(preparation `3c5266f2`), 10:00:29–10:05:50 UTC.
Installation passed after 4m52s; it was a verified running step, never restarted.

The [receipt](extension-attempt-2.json) records source checks, fresh V1+V2 schema
setup and the browser command. The pinned 30+23 backend cases and four pure
helper inputs were carried forward without rerun. Source vectors match and all
command groups closed/disappeared without timeout, forced cleanup or interruption.

Desktop reached authenticated declarations, then received an existing event
ACK (200) where the harness expected revoked-key 410. No completed browser case
is accepted at this source; narrow was not attempted. Source inspection found
the wait `/revoked/` also matches the pre-revocation text `not revoked`, so it
could proceed before the UI mutation committed. This is not evidence of a
replay after a confirmed revocation. Replace the predicate with disappearance
of the specific revoke control and an assertion of its actual stored revoked
state, then keep the same 410 requirement. No product logic change or relaxed
authorization assertion is warranted by this failure.

One created context, browser/process group, server, pool/admin connection and
owned scratch all closed/removed; no late-error or cleanup failure. Outer
installation removal was conservatively refused after browser exit 1, retaining
owned installations for ephemeral runner teardown. Service container/network
removal passed. Preserve this failure and the first attempt unchanged.
