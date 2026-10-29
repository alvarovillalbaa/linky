# Linky persistent-service implementation proposal

29 October 2026. **Awaiting explicit source/security/dependency/CI approval.**
This is the first gate, not permission to apply anything to a live database.
The [four-part product brief](../spec.md) stays intact. The
[schema contract](../schema-contract.md) specifies the proposed records and
transaction invariants; actual migration SQL will be authored only if approved.

## Exact first action proposed

1. Implement the independent Linky owner, recipient and conversion-ingest
   capability model below, its server API and persistent repository source.
   No Supabase Auth user/session sharing or external identity provider.
2. Author the versioned PostgreSQL schema/functions and provisioning source
   after the pinned Supabase migration generator creates its source file in the
   CI job below. The installed local CLI cannot start because its telemetry
   state is outside this workspace's writable scope; no permission bypass or
   local installation is proposed. Creating a file does not authorize applying
   it to Still or another database.
3. Pin the Node backend to the existing Node 24 line and add only `pg@8.23.1`.
   The npm registry was read on 29 October; its published integrity is
   `sha512-aL96AHANtWjPLDOLqnhx+ngp9+UK7ETEU8VJrDCGvsSSi/mGLcWYsS6Herg7lmaBJe4uwrfqsa7gTEFaSizDoQ==`.
4. Run the exact [inactive source-prerequisite workflow](source-prerequisites.workflow.yml)
   once on temporary public branch `qa/linky-source-prerequisites`: one Ubuntu
   job, five-minute timeout, pinned Node 24.21.0. Resolve only the pg lockfile
   with scripts/audit off; use CI-only `supabase@2.122.0` to inspect command help
   and generate one unlinked, unapplied migration source file. Retrieve only
   the lockfile, generated SQL scaffold and digest manifest, verify the approved
   packages/outputs, then remove the active temporary workflow. No backend,
   browser or database test, connection, schema application or private credential.

The CLI npm integrity observed on 29 October is
`sha512-6IQOuHnRFyUgQxi6j6WfxJ6R4sh6vgcyhKxapv/CCDqs3+O/UxMggPxGAPr2eTEt1MhAOpa6xftiNRHIsB7afQ==`.
The temporary runner may install that CLI tool in its own disposable cache;
the application manifest receives only the approved pg dependency.

The supplied `AGENTS.md` §14 and repository instructions require approval for
the new access policy, dependency and CI. Local dependency installation is not
proposed under the storage reserve constraint. The exact test/migration rollout
will need a later published approval scope after those artifacts exist.

## Independent ownership and access

- Operator-provisioned workspaces; no public signup endpoint. Provisioning and
  privileged recovery/rotation require a separate operator-only connection or
  approved privileged operator context, unavailable to the deployed API. The
  command must fail if that explicit context is absent; it never falls back to
  `linky_runtime` or widens runtime grants. Generate and privately retain the
  random 256-bit owner capability/stable provisioning ID before the write, so
  uncertain acknowledgement cannot lose the only recovery material. The
  recovery file is never committed, printed in logs or seeded in UI. No
  operator/admin database credential is deployed to the application.
- Owner keys authorize management only for their bound workspace. Recipient
  grant keys authorize one selected link/destination revision; conversion keys
  authorize write-only event ingestion for their recorded scope. Types are
  purpose-bound and cannot substitute for each other. Store digests at rest;
  neither plaintext nor digest is returned in ordinary list/detail records.
- The dashboard accepts an operator-held recovery credential into memory.
  Owner/recipient credentials use HTTPS headers or explicit POST bodies, never
  query strings, analytics, third-party scripts or ambient shared cookies.
  Recipient links may carry a public locator plus a fragment-held secret; the
  app captures that secret in memory and removes it from the current history
  entry. Reload requires reopening the original grant; there is no localStorage
  fallback or silent credential export.
- Owner key rotation invalidates the old management key. Recipient and ingest
  keys have their own explicit revocation/rotation and audited scope. Recovery
  is possession of the privately saved owner credential or a privileged
  operator rotation; there is no pretend email recovery or identity assurance.
- APIs bind workspace, revision and authorization from stored records, enforce
  same-origin browser requests, reject cross-origin credential forwarding and
  redact secrets/private destinations from errors and operational logs.

These are bearer capabilities, not verified recipient identities. Anyone given
the secret can exercise its recorded scope. Identified recipients, teams/SSO
and origin-integrated resource enforcement remain separate product scope.

## Recipient and redemption semantics

GET/HEAD loads an inert page without consuming a use or disclosing a private
destination. Explicit POST inspection may verify the grant and return only a
bounded destination hostname/safety summary, not the usable URL. A second
explicit Open action sends a stable idempotency key for redemption.

The database acquires locks in deterministic link → grant order, then samples
`clock_timestamp()` and verifies the current key, revocation, expiry, link
state and pinned destination revision. Revocation/policy changes use the same
lock order. While still authorized, replay returns an existing matching receipt
without incrementing usage, including when that receipt exhausted capacity.
Changed intent under the same key rejects. Revoked/expired grants cannot reveal
an old destination through replay.

For a new redemption, capacity, receipt insertion and attribution insertion
commit atomically before the URL leaves the service. A lost acknowledgement
does not undo a committed use; same-key retry recovers it. Bounded request,
connection, query and batch limits apply; no in-memory counter stands in for
database enforcement. Public reads never create unbounded event rows.

Destination revisions are immutable. Editing a link does not retarget existing
grants. Pausing/blocking the link prevents subsequent authorizations. A prior
committed response cannot be retracted, and an ordinary destination URL already
learned can still be opened without Linky. A protected-origin/gateway integration
is required for stronger downstream access and is not silently replaced by the
redirect implementation.

## Attribution and destination safety

Commit one redemption event per receipt, retaining its approved campaign and
destination revision. GET traffic/scanners, successful redirects and actual
arrivals are different observations. Metrics report committed redemptions,
not unique people. Authenticated ingest records declared leads/sales against
an existing matching receipt, with workspace/event idempotency independent of
credential rotation. Declared sales are not independently verified purchases;
optional monetary totals remain grouped by their recorded currency.

The initial safety source validates addresses and exposes actionable blocked,
review and unchecked states. No malware-free verdict, remote preview, general
proxy, third-party URL fetching or automatic reputation provider is included.
Those services require a separate reviewed integration. Destination review and
pause/revoke controls still form part of the real service, not a static badge.

## Proposed future hosting boundary

The candidate is Still's existing project `wosqlzijmyiemueoittw`, serving Still
and Kickoff. Fresh metadata shows it and Dearweek active, with the retired
Kickoff project inactive. The previous free-slot rejection and current metadata
are preserved in the [source receipt](../results/2026/10-29/source-preparation.md);
no new capacity, price quote or reuse authority is inferred.

The later rollout proposal will request `linky_private` plus a dedicated
`linky_runtime` login and a non-login, Linky-only function owner. Runtime gets
only schema usage and explicit execution of selected private functions, not
table DML, ownership, superuser, role creation or unrelated role membership.
New objects revoke PUBLIC/anon/authenticated access; function bodies use fixed
search paths, qualified names and their own bound capability checks. No public
RPC, shared Auth table/session, existing app secret or project-wide service key
is copied into Linky. No existing app ACL is relaxed or rewritten.

The connection must use the verified pooler hostname and certificate-verified
TLS, one connection per warm instance and unnamed queries compatible with
transaction pooling. Do not guess the pooler cluster from its region. Verify
private-object denial and unexpected inherited PUBLIC privileges before any
live rollout; stop rather than modify another app to force a pass.

Schema/role isolation still shares storage, compute, outages and quota with
Still/Kickoff. It is not a dedicated project. This first approval does **not**
authorize schema application, role creation, credentials, provider settings,
other-app data queries, app pauses, plan changes, production deployment,
local installations, backend/browser tests or additional CI. Those steps need exact
source artifacts and their own applicable approval before execution.
