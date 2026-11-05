# Published unconfigured review

5 November 2026. [GitHub](https://github.com/alvarovillalbaa/linky) and
[public review](https://linky-alvaro.vercel.app). The [70 disposable cases](service-checks.md)
and [dedicated live schema](live-schema.md) are separate from pending runtime
connection and hosted owner/recipient acceptance.

- Target: production; READY `dpl_GxMnCgTdA2SETEqvzvAXxm7PGdJe`.
- Observed source: `09b4062e3e236fdc8b1dfdba9def2869a780386f`.
- Framework: none; Node 24.x; build 8.442 seconds.
- Vercel project: `prj_AGu9DYlJANbOhwV6NTf3oZXNzXhQ`, existing Clous Team.
- Readiness: **unconfigured review**; no database URL, workspace or owner key.

The [HTTP receipt](publication.json) records 23 anonymous requests: all fourteen
known GET routes (status 200, thirteen protected methods 405), HEAD status 200,
unconfigured owner POST 503, unknown query/hint refusals 400, and five source-byte
matches for root/recipient HTML, app/client modules and CSS. Status returned
`configuration:required`, `database:unverified`, `conversionsAvailable:false`.
All observed security headers include no-store, no-referrer, nosniff and DENY.
HEAD's curl output is a header-only capture, not a claimed response body.

First deployment `dpl_4gZ9Qty9bvUJLF243mhqhXZH9hNk` at `113bbb8` served matching
static assets but status returned 400. A bounded, redacted public-status probe
at `2acc6e6` observed redundant `path=status` alongside the intended route hint.
[Vercel's source](https://github.com/vercel/vercel/blob/main/packages/routing-utils/src/superstatic.ts#L509-L560)
explains the compiler's capture-to-query behavior. The fix changes the producer
to source `/api/v1/:linky_route*`, destination `/api/v1`. It does not strip
unknown query keys. The temporary diagnostic was removed; API source returned
to its exact accepted SHA `4c6f3a2532adee4180a55979cb4e2c3946164074a415d5c32ed7b81f9902dfff`.
No application/runtime/test input changed; only hosting routing config required
this separate live preflight. The 70 accepted cases were not rerun.

One probe initially expected unknown-route 404; actual adapter rejection was
400, exactly as its existing accepted unit case specifies. Direct Web handler
404 and invalid deployment rewrite-hint 400 are now explicit in the HTTP docs.
The receipt retains both the initial expectation and correction; no assertion
or request guard was weakened.

The deployment-scoped error scan (limit 20; through 09:04:44.355 UTC) returned no
logs. It proves neither continuous monitoring nor a configured log drain.
All 53 task-owned HTTP scratch files (256,739 bytes) were removed after response
verification, owner/type/inode checks and confirmation that no extra file existed.
New-project SSO protection was disabled for this intentionally public review;
no existing app protection changed. No privileged database fallback, account,
plan change or paid enrollment. Pooler/TLS/native login, runtime credentials,
workspace provisioning and hosted product checks remain pending.

This HTTP edition is pinned above. A later documentation-only publication may
have a newer Git/deployment SHA; do not relabel these observations as a rerun at
that newer head. Final source publication is independently verified outside
this self-referential receipt.
