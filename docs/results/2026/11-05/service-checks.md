# Durable service acceptance

5 November 2026. **50 unit/HTTP + 18 real PostgreSQL + 2 browser journeys accepted**
in the recorded disposable environments. Full product and live binding remain
separate. [Attempt 1](service-attempt-1.md) remains an immutable failed browser
attempt and owns the original passing backend streams.

[Browser retry run 41996924948](https://github.com/alvarovillalbaa/linky/actions/runs/41996924948),
job 127142263874, 08:45:28–08:46:15 UTC, checked
`a7d5647100a8b5204052703afdbbcdfd81bb4ef9` (preparation `61283f0`).
The controller ran 08:46:05.986–08:46:12.117 UTC with Node 24.21.0.
The [raw receipt](service-checks.json) preserves before/after byte/mode/Git-blob
vectors, all command outcomes and compressed raw stdout/stderr. All digests
and byte lengths were independently decoded/verified before this record.

The retry hard-pinned the 33,669-byte first receipt at SHA-256
`91952a4560a6acc13e653280d95072eaa9faaff324e399807adf2cc3cb48a102`,
verified its 50/50 and 18/18 TAP results (zero fail/skip/cancel/TODO) and all 28
unchanged application/backend input fingerprints. **Zero accepted backend
cases repeated.** Setup applied the exact tested artifacts to a fresh, marked
loopback-only PostgreSQL 17 service; it is not another test pass or live binding.

Playwright 1.64.1 / Chromium 156.0.8078.4 exercised actual UI → HTTP → restricted
database functions at 1440×1000 and 390×844. Each case provisioned a disposable
workspace through the real recovery-file-first operator command, recovered the
same provisioning acknowledgment, connected an owner, created a durable link,
issued one finite grant and revised its destination. The recipient removed its
fragment, inspected without consuming a use/disclosing the URL, then explicitly
redeemed the original pinned revision. Actual committed count remained one.

Desktop deliberately aborted the reply **after** the server committed; explicit
retry recovered its receipt. Both cases recovered the same receipt again,
denied replay after link pause and grant revocation, cleared disclosed links
on denial, required the original credential after reload, loaded the actual
one-redemption report and reconnected to the persisted revised link after owner
reload. Cookies/localStorage were empty. Both scroll widths equalled viewports.
The narrow case is viewport emulation, not touch or a mobile-device claim.
No destination site was fetched. No model call, real product-account content
or payment was used.

All three retry command groups drained and disappeared. Both contexts, browser
and owned process group, HTTP server, pool and admin client closed; scratch
identity/absence checks passed. No interruption/timeout/source drift. The outer
installation cleanup succeeded, and job teardown removed its PostgreSQL service
and network. The active temporary workflow is retired after this terminal run.

Live pooler/TLS/login connection, runtime credentials and hosted owner/recipient
acceptance remain unverified. The dedicated project/schema is separately
recorded; do not turn catalog verification or this disposable proof into live
acceptance. Persisted bulk, conversion ingestion, identity/SSO, protected-origin
integration and reputation services remain unfinished full-product scope.
