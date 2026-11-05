# First persistent-service acceptance attempt

5 November 2026. [Run 41995657052](https://github.com/alvarovillalbaa/linky/actions/runs/41995657052),
job 127138052096, source `b9405c02c8bf4defdd46c28a75b10af98d6b9d11`
(preparation `b7dbf427b11312d7186ebc87f9f4352d6597bdd0`).
The exact [receipt](service-attempt-1.json) preserves compressed raw streams and
matching before/after source vectors. All four command groups drained and ended;
no timeout, cancellation or source drift.

Source checks passed. **50 unit/HTTP cases and 18 actual PostgreSQL 17 cases
passed**, with no skipped/cancelled/TODO case. These scopes close for unchanged
inputs. They establish the recorded disposable service only, not live TLS or
hosted readiness.

The browser stage failed its first desktop journey at the final reload wait for
`Manage Revised desktop`. Reload retained Attribution; the harness omitted the
explicit navigation back to Links. No browser journey is accepted, and narrow
was not attempted. This is a fixture navigation defect; no app input repair is
inferred. The observed Chromium version was 156.0.8078.4.

One created context closed; browser and its owned process group, server, runtime
pool and admin client closed, and identity-checked scratch was removed. No
interruption occurred. The outer installation cleanup conservatively refused
removal because browser exit was nonzero; that step failed and retained its
task-owned installations for ephemeral runner teardown. Job logs confirm the
PostgreSQL container and owned network were stopped/removed. Do not call that
outer installation removal verified or turn earlier assertions into a passed
browser case. Preserve this attempt when repairing the harness.
