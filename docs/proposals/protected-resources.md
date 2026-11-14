# Protected resources, V3

Status: implementation and disposable qualification authorized by the user's
standing approval. This source does not activate the live database or bind a
production credential. V1/V2 migrations and accepted receipts remain immutable.

Linky's redirect gate cannot recall a destination URL. An integrating resource
server must call Linky before every GET/HEAD and prevent alternate public/static
routes and caches from serving the same private bytes. This release supplies that
guard, a runnable private-file example, and owner/recipient controls.

## Authority and use accounting

- `lyp_` is a server-only origin key scoped to one workspace, link and immutable
  HTTPS destination revision. SQL derives its exact resource URL from that
  revision. Issue/list/revoke require the current owner and link-version CAS.
- `lya_` is a resource access key scoped to one committed redemption receipt.
  The recipient authenticates with `lyr_` only to Linky to inspect and prepare it.
  The resource host receives only `lya_` and its access ID, never `lyr_`, owner,
  conversion or browser cookie authority.
- A use is a committed redemption, not a downstream page view or download.
  Repeated resource requests consume no additional uses or attribution events.
- There is one current access key per receipt. Explicit replacement requires the
  observed access version and invalidates the previous key. The raw key is
  generated before the first request; exact pending intent stays in tab memory
  for uncertain-response retries. A matching current request replays, changed
  content or an outdated version conflicts. Plaintext is never recovered from
  hashes. Losing the tab requires inspecting and explicitly replacing access.
- Current workspace/link/grant/origin-key state and expiry govern every request.
  Revocation blocks decisions after its commit. A decision already made and its
  in-flight stream may finish; delivered or copied bytes cannot be recalled.

## HTTP contracts

All routes are POST JSON under `/api/v1`. Existing 32 KiB/5 s body bounds,
closed DTOs, no queries, same-origin owner/recipient rules and commit-before-ACK
apply. New raw capability prefixes are refused in ordinary text and output.

| Route | Authority | Exact input (in addition to authority) |
| --- | --- | --- |
| `/origin-credentials/issue` | owner bearer | workspaceId, mutationKey, linkId, revisionId, expectedVersion, credentialId, originKey, label, expiresAt |
| `/origin-credentials/list` | owner bearer | workspaceId, linkId, limit, after |
| `/origin-credentials/revoke` | owner bearer | workspaceId, mutationKey, linkId, credentialId, expectedVersion |
| `/recipient/resource-inspect` | recipientKey in body | grantId, receiptId |
| `/recipient/resource-prepare` | recipientKey in body | grantId, receiptId, accessId, accessKey, expectedAccessVersion |
| `/origin/authorize` | origin bearer | credentialId, accessId, accessKey |

Origin authorization is server-to-server: absent Origin is allowed; a supplied
Origin must match Linky, cookies and cross-site browser contexts are refused.
The raw origin/access keys become SHA-256 digests before SQL. Six named runtime
functions are added; no SQL dispatcher or direct table access is granted.

Resource inspection returns grantId, receiptId, linkId, revisionId, resourceUrl,
accessVersion (zero if absent), expiresAt. Preparation returns the same scope with
accessId, version, expiresAt and replayed. Origin authorization returns exactly
authorized=true, credentialId, accessId, receiptId, linkId, revisionId, resourceUrl,
expiresAt (the earlier grant/key expiry). No response contains a key or hash.

## Database boundary

Two additive private tables: origin_credentials and resource_access. Composite
foreign keys bind revisions and receipts; receipt scope is immutable. A resource
access row can only replace its ID/hash/fingerprint with exactly version+1. RLS
is enabled without public policies. Existing roles and function grants are not
broadened; only the six named entry points are granted to linky_runtime.

Lock order is workspace, link, grant, origin credential, resource access. Reads
hold SHARE locks; revocations/rotations take conflicting write locks. Preparation
serializes on its grant. Authorization reads database wall time after the final
potentially waiting lock and checks both expiries there. See PostgreSQL's
[locking rules](https://www.postgresql.org/docs/17/explicit-locking.html) and
[row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

The local Supabase 2.117.0 scaffold command failed before generation because it
attempted a telemetry write outside the allowed workspace (two attempts, including
the absolute executable). No permission boundary was bypassed. The owned remote
qualification will generate the additive migration using pinned Supabase 2.122.0,
record its empty scaffold and populated hashes, and return the completed file.
The SQL proposal is not represented as an already generated/applied migration.

## Host and browser boundaries

The dependency-free Web Request/Response guard pins the Linky origin, credential
and exact canonical resource URL in trusted configuration. Only GET/HEAD reach
the handler, after bounded fail-closed authorization. It omits cookies, refuses
redirects and malformed/oversized replies, strips credentials before calling the
handler, and marks returned bytes private/no-store. CORS allows only the explicit
Linky or resource origin, without credentials or wildcard access. Preflight
permits only Authorization and X-Linky-Access-Id. See the Fetch standard's
[CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol).

The built-in recipient action explicitly downloads an inert attachment, bounded
to 20 MiB and 10 seconds. It does not navigate a page with a grant key or execute
downloaded HTML. The host guard streams; other trusted clients can handle larger
files. Host operators must avoid logging request secrets before the guard.

## Focused qualification and release

One task-owned public Linux job, capped at 20 minutes: 53 focused cases (27
protocol/guard/download, 22 real PostgreSQL, four browser journeys), pinned Node 24.21.0,
PostgreSQL 17, exact locked pg, CI-only pinned Chromium tooling. Generate V3;
apply V1/V2, seed authored V2 rows, snapshot them, apply V3 and verify preservation;
exercise new SQL/HTTP/host/UI cases including rotation, lost replies, revocation,
expiry after lock waits, cross-scope/purpose refusals and repeated GET accounting.
Desktop and narrow-screen browsers use two disposable HTTPS origins with authored
bytes and a CI-only certificate; they are not production TLS proof. Retain failures,
case identities, source hashes and cleanup evidence. Retire the workflow/ref after
publication. No production data, model calls, provider enrollment or paid plan.

Live activation remains gated on dedicated verified-TLS runtime/operator binding,
catalog review and applying the generated V3 to Linky's own database. Before that
application, check existing ordinary metadata for newly reserved lyp_/lya_ shapes;
do not rewrite historical rows or weaken secret refusal to bypass a conflict.

Case identities are defined in tests/unit/protected-resources.test.mjs (P01-P18,
with named response/failure variants), tests/integration/protected-resources.test.mjs
(D01-D21, with two final-lock expiry variants), and
tests/browser/protected-resources.mjs (B01-B04). The disposable runner alone maps
linky.example.com/resource.example.com to loopback and temporarily permits its
nonprivileged process to bind 443; cleanup restores those runner settings.
