# Linky durable database boundary

5 November 2026. Authored implementation and disposable fixtures; no local or
live application is claimed by this document. The standing scope is recorded in
[AGENTS](../AGENTS.md) and the [focused check proposal](proposals/persistent-service-checks.md).
The older [schema design](schema-contract.md) supplies product intent. This slice
implements eight tables; conversion credentials/events remain unavailable.

Apply [bootstrap](../db/bootstrap.sql), then the exact generated
[migration](../supabase/migrations/20261105080045_linky_initial_service.sql), using
a separately reviewed installer connection. Each artifact is transactional.
Neither is an application startup task. Bootstrap creates only the three Linky
roles and `linky_private`; it does not alter another application's objects or
ACLs. The installer receives explicit `SET TRUE, INHERIT FALSE` membership in
the new object owner so it can install as that owner. This is not granted to the
runtime or restricted provisioning operator. PostgreSQL 17 documents these
[membership options](https://www.postgresql.org/docs/17/sql-grant.html).

`linky_function_owner` is NOLOGIN, owns only Linky schema/tables/functions, and
has no superuser, role/database creation, replication or RLS-bypass attribute.
`linky_runtime` and `linky_operator` are restricted LOGIN roles with no role
memberships. Source supplies no passwords. A live operator must privately set
separate credentials, verify effective PUBLIC/inherited access and TLS, and
refuse deployment on unexpected access. Never use shared Auth or a service-role
credential. The runtime is granted schema USAGE and only the thirteen named
runtime functions; the operator only the two provisioning/recovery functions.
All other Linky functions and tables deny PUBLIC/runtime/operator access.
Every table enables RLS without public policies. The table owner's intentional
bypass permits the security-definer API; RLS is not capability authentication.
Every function fixes an empty search path and qualifies its database objects.

## Callable records

All runtime signatures are `(p_owner_hash text,p_payload jsonb)` or
`(p_recipient_hash text,p_payload jsonb)`, returning JSONB. Hashes are 64 lowercase
hexadecimal SHA-256 values of purpose-bound random capabilities. Their plaintext
never enters SQL, receipts or logs. Closed payloads reject unknown fields and
invalid JSON types. The [HTTP contract](http-contract.md) owns token transport
and recomputes the admitted URL/safety data before these defensive SQL checks.
Ordinary text also refuses recognized raw Linky capability strings, including
workspace names, so a committed record cannot later fail the secret-free DTO
boundary. Prefixless credential hashes remain accepted in their explicit fields.

| Function | Exact required payload; optional fields after semicolon |
| --- | --- |
| `owner_connect` | `{}` |
| `owner_rotate` | `workspaceId,mutationKey,newOwnerHash,expectedOwnerKeyVersion` |
| `owner_close` | `workspaceId,mutationKey,expectedOwnerKeyVersion` |
| `owner_create_link` | `workspaceId,mutationKey,linkId,revisionId,slug,label,destination,campaign,safety` |
| `owner_revise_link` | `workspaceId,mutationKey,linkId,revisionId,expectedVersion,label,destination,campaign,safety` |
| `owner_set_link_state` | `workspaceId,mutationKey,linkId,expectedVersion,state` |
| `owner_issue_grant` | `workspaceId,mutationKey,linkId,revisionId,expectedVersion,grantId,recipientHash,label,maxUses,expiresAt` |
| `owner_revoke_grant` | `workspaceId,mutationKey,linkId,grantId,expectedVersion` |
| `owner_list_links` | `workspaceId`; `limit,after,state,search` |
| `owner_list_grants` | `workspaceId,linkId`; `limit,after` |
| `owner_report` | `workspaceId`; `from,to,limit` |
| `recipient_inspect` | `grantId` |
| `recipient_redeem` | `grantId,redemptionKey` |

Operator functions have `(p_operator_id uuid,p_payload jsonb)`:
`operator_provision` requires `workspaceId,mutationKey,name,ownerHash`;
`operator_recover_owner` requires
`workspaceId,mutationKey,newOwnerHash,expectedOwnerKeyVersion`.
The separate provision CLI owns durable, private, exclusive 0600 secret/intent
storage **before** calling them. A receipt cannot recover a lost plaintext key.

Mutation ACKs have exactly these keys plus `replayed:boolean`:

- Create/revise: `workspaceId,linkId,revisionId,version`.
- State: `workspaceId,linkId,state,version`.
- Issue: `workspaceId,linkId,grantId,revisionId,version`.
- Revoke: `workspaceId,linkId,grantId,version`.
- Rotate/recover: `workspaceId,ownerKeyVersion`.
- Close/provision: `workspaceId,state,ownerKeyVersion`.

Connect returns `{workspace:{id,name,state,ownerKeyVersion}}`. Lists return
`{links:[...],nextCursor}` or `{grants:[...],nextCursor}`; UUID cursor/null,
default 50/max 100 in SQL (HTTP caps 50). State/null and cursor/null are accepted;
empty search is accepted. A full final page may supply a cursor followed by an
empty page. Lists contain admitted owner-visible destinations but no credential
hashes. Grant limits are integer 1–1,000,000; explicit UTC expiry is immutable.
Campaign is exactly `{source,medium,campaign}`, each at most 100 characters.
Safety is exactly `{policyVersion:'linky-address-v1',hostname,result,reputation:'unchecked'}`;
HTTP/public-address/IDN review is not a malware or reputation verdict. No SQL
function resolves DNS, fetches a URL, proxies a file or invokes a model.

Inspect returns only
`{grantId,linkId,label,hostname,safety,expiresAt,remainingUses}` and never consumes
a use or reveals the full destination. Redeem returns
`{receiptId,grantId,linkId,revisionId,useNumber,redeemedAt,destination,replayed}`
only after its transaction commits through the runtime. The runtime adapter
must commit before returning any function result.

Report returns numeric `redemptions`, `campaigns:[{campaign,redemptions}]`,
`coverage:{kind:'committed_redemptions',from,to,limit,recordCount,truncated}` and
`conversionsAvailable:false`. It uses newest committed receipts in `[from,to)`,
default last 30 days, maximum 366-day window and SQL limit 1–5000 (HTTP 1–50).
Explicit null dates select defaults. Counts refer only to that bounded cohort;
truncation is explicit, campaigns remain pinned to the redeemed revision, and
there is no claim of unique people, destination arrival, downloads or sales.

## Transaction and failure semantics

Runtime reads/writes authenticate current capability and hold workspace SHARE;
owner rotation/close and operator recovery use workspace UPDATE. Link locks
precede grant locks; redemption takes UPDATE on both. Inspection takes SHARE.
Database `clock_timestamp()` is read after locks to check expiry. Authorization,
active workspace/link, exact credential, expiry and revocation are checked
**before** any old receipt can disclose a target. An already exhausted but still
authorized grant may replay its exact receipt. A closed workspace denies all
runtime operations, including the old close ACK; it cannot be reopened here.

Owner writes require compare-and-swap versions, including grant issue/revoke
which advance link.version. Same mutation key and normalized semantic input
replays its historical ACK before checking the old expected version. Changed
resource, operation or input conflicts. Current authorizing hash is excluded
from semantic fingerprints; newly issued key hashes are included. Rotation
therefore invalidates the old key before replay, while the replacement may
recover an earlier matching ACK. Revisions, receipt/event/audit history and
mutation snapshots are append-only. Existing grants remain pinned when a link
is revised. Use increment, receipt, attribution and audit commit together; a
failure rolls all of them back. URL knowledge already disclosed cannot be
revoked downstream.

Controlled refusals are SQLSTATE `P0001` and one finite message:
`linky_invalid`, `linky_denied`, `linky_closed`, `linky_conflict`, `linky_scope`,
`linky_expired`, `linky_revoked`, `linky_exhausted`, `linky_inactive`,
`linky_immutable`. The HTTP adapter allowlists these; unexpected database errors
are unavailable, never raw SQL/details/destinations. Direct constraint failures
are not a public API. No generic action dispatcher or dynamic caller SQL exists.

## Disposable proof and rollback

[The integration fixture](../tests/integration/database.test.mjs) authors 18
serial cases using real PG17, separate restricted connections, actual competing
transactions and a workspace-scoped injected trigger failure. Before any driver
import/connection it requires CI=true, both disposable flags and the exact owned
loopback URL; before bootstrap it also verifies PostgreSQL major 17,
database `linky_checks` and comment `linky-disposable-ci-v1`. Fixture passwords
are authored CI-only values. Tests close every pool while deliberately retaining
the isolated schema/roles for subsequent browser acceptance. No live target or
local DB execution is implied; actual results belong in later receipts.

The expiry test observes the actual waiting backend lock before advancing past
expiry. Retry cases prove durable idempotency, not an induced network ACK loss.
The tests do not establish hosted TLS, project isolation, production quotas,
origin enforcement downstream or conversion ingestion. These remain separate
boundaries. [Rollback](../db/rollback.sql) requires explicit operator confirmation,
drops only `linky_private` and retains roles; export/review Linky records first.
It is destructive, never an automatic application or fixture teardown step.
