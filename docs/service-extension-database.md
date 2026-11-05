# V2 declaration and bulk database contract

5 November 2026. This source extends the accepted [V1 boundary](database-contract.md)
through the separately generated
[V2 migration](../supabase/migrations/20261105092311_linky_service_extension.sql).
V1 migration bytes remain immutable. This document describes authored source,
not a live schema application, accepted check run or configured hosted service.
The user's standing implementation/temporary-CI approval remains in [AGENTS](../AGENTS.md).

The migration is one transaction under the existing NOLOGIN object owner. It
adds only `conversion_credentials` and `conversion_events`, their indexes and
immutable-history guards, six named runtime functions and two private helpers.
It extends the closed mutation/audit allowlists and replaces `_text` to reject
raw `lyi_` capabilities in ordinary text alongside `lyo_`/`lyr_`. It neither
changes old rows nor broadens the operator role. New tables enable RLS, have no
runtime/operator/PUBLIC data grants, and functions retain empty fixed search
paths. Only the six new entry points receive runtime EXECUTE; helpers remain
private. The same explicit table-owner bypass as V1 applies.

## Credential and declaration API

Every entry point is `(hash text,p_payload jsonb) RETURNS jsonb`, with closed
payload keys. Hashes are SHA-256 of complete purpose-prefixed tokens, never
plaintext. Owner functions use the existing owner capability; ingestion uses
only an independent `lyi_<64 lowercase hexadecimal characters>` capability.
The [V2 HTTP contract](service-extension-http.md) owns transport and public error labels.

| Function | Required fields; optional fields after semicolon |
| --- | --- |
| `owner_issue_conversion_credential` | `workspaceId,mutationKey,linkId,revisionId,expectedVersion,credentialId,ingestHash,label,expiresAt` |
| `owner_list_conversion_credentials` | `workspaceId,linkId`; `limit,after` |
| `owner_revoke_conversion_credential` | `workspaceId,mutationKey,linkId,credentialId,expectedVersion` |
| `conversion_ingest` | `credentialId,receiptId,eventKey,kind,amountMinor,currency,declaredAt` |
| `owner_attribution_report` | `workspaceId`; `from,to,limit` |
| `owner_bulk_create_links` | `workspaceId,rows` |

Issue/revoke hold workspace SHARE → link UPDATE → relevant credential lock and
CAS/increment the link version. Issue binds one exact workspace/link/immutable
revision, with purpose `conversion_ingest` and an explicit future UTC expiry.
Credential scope/key/expiry are immutable; replacement is a separate issue and
explicit revoke. The caller retains its stable mutation/resource UUIDs and
new secret privately before writing. Matching mutation receipts replay only
after current owner authorization, before checking the historical expected
version. A response never recovers plaintext from a digest.

Issue ACK: `{workspaceId,linkId,credentialId,revisionId,version,replayed}`.
Revoke ACK: `{workspaceId,linkId,credentialId,version,replayed}`.
List: `{credentials:[{id,linkId,revisionId,label,purpose,expiresAt,revokedAt,createdAt}],nextCursor}`;
default 50/max 100 SQL rows, UUID/null cursor (HTTP caps 50). No digest appears
in these records. A full final page may have a cursor followed by an empty page.

Ingestion holds workspace SHARE → link SHARE → credential SHARE, checks the
current hash/purpose, active workspace/link and post-lock database expiry and
revocation, then reads the matching immutable redemption receipt. It takes a
workspace/event-key advisory lock and checks wall-clock expiry again after
that possible wait. Revocation/rotation/closure serialize against these locks.
The redemption's grant may have expired; current ingestion permission is a
different purpose and lifetime. No destination or recipient key is disclosed.

`kind` is `lead_declared` or `sale_declared`. Leads require null amount/currency.
Sales accept both null (unknown value), or integer minor units from zero through
9,007,199,254,740,991 together with exactly three uppercase currency letters.
Zero is known value; null is unknown. SQL enforces these rules and same-scope
composite foreign keys. `declaredAt` is caller-supplied UTC evidence, not an
authorization clock. `acceptedAt` is database wall time.

ACK: `{eventId,workspaceId,linkId,revisionId,receiptId,eventKey,kind,acceptedAt,replayed}`.
Workspace/event-key identity is unique across credential rotations. Semantic
fingerprints bind exact receipt/scope, kind, amount, currency and normalized
declared instant; they exclude credential ID/hash. A still-authorized replacement
credential in the same scope may recover an identical earlier event ACK. An
expired/revoked credential cannot replay. The originally accepting credential ID
stays immutable internally. Changed semantic input conflicts. Event insertion
and audit commit atomically; neither a retry nor a failed transaction inflates
the report. These are authenticated declarations, not independently verified sales.

## Independently bounded report cohorts

The new report has two SQL top-level keys; the old V1 redemption report remains
unchanged. Optional null dates select the last 30 days, maximum window 366 days.
SQL limit is 1–5000 (default 1000); HTTP limits 1–50. Each cohort independently
selects its newest committed records in the same `[from,to)` window:

```text
redemptions: {
  count, campaigns:[{campaign:{source,medium,campaign},count}],
  coverage:{kind:'committed_redemptions',from,to,limit,recordCount,truncated}
}
declarations: {
  total,leads,sales,unknownValueSales,
  campaigns:[{campaign:{source,medium,campaign},leads,sales,unknownValueSales}],
  currencies:[{currency,amountMinor:string,sales}],
  coverage:{kind:'accepted_conversion_declarations',from,to,limit,recordCount,truncated}
}
```

Redemptions use stored redemption time; declarations use acceptance time, not
declared time. Campaigns come from the redeemed revision, not ingestion bodies.
Currency totals are exact decimal **strings** because summing individually safe
amounts may exceed JavaScript's safe integer range. Currencies are never mixed;
unknown-value sales are counted separately and excluded from money totals.
Known zero-value sales remain included. Empty cohorts are observed zero records
within explicit coverage, not proof that no transaction or person existed.
Truncation is independent; never compare these bounded denominators as a verified
conversion rate. Counts do not establish unique humans, arrival or commercial truth.

## Bounded durable bulk creation

SQL accepts 1–50 prevalidated normalized rows, each exactly
`{sourceIndex,mutationKey,linkId,revisionId,slug,label,destination,campaign,safety}`.
`sourceIndex` is integer 0–499; HTTP can use its batch-local array index and the
UI maps it back to the original CSV preview. It is metadata, not a SQL identifier.
HTTP retains its 32 KiB wire limit; the server-normalized top-level SQL payload
has a separate 256 KiB bound because derived safety/hostname data repeats bytes
absent from the wire DTO. Each row retains V1's closed shape and text bounds.
500-row CSVs require multiple explicit batches. Duplicate source index, mutation/link/revision UUID
or slug within a batch rejects before any row write. Malformed metadata rejects
the batch. HTTP separately merges invalid draft outcomes without sending them
to SQL; an all-invalid HTTP batch performs no database mutation.

The function authenticates current owner/workspace, acquires its complete sorted
mutation-key advisory lock set, then processes links in UUID order. Each row
calls the existing reviewed `owner_create_link` function inside a PostgreSQL
subtransaction. A failed row's provisional link/revision/receipt/audit rolls back
while independent rows may succeed. The enclosing transaction still must commit
before any outcomes leave the runtime. An outer rollback commits none of them.
Replaying a batch reuses original row intents and matching row mutation receipts;
there is no opaque batch-success receipt or 500-row implicit transaction.

Result: `{outcomes:[{sourceIndex,mutationKey,linkId,revisionId,status,version,error}]}`,
ordered by source index. `status` is `committed`, `replayed` or `error`. Successful
rows have integer version and null error; errors have null version and one finite
SQL code. Existing controlled codes are retained; unexpected internal failures
become `linky_unavailable` metadata, never raw exception text or false success.
HTTP maps these to public codes. Clients retain uncertain intent and explicitly
retry; they must not silently create new IDs or skip failed rows.

## Authored disposable proof and limits

[V2 fixtures](../tests/integration/service-extension.test.mjs) author 23 cases:
pre-migration V1 seed preservation and critical replay/capacity behavior, private
ACL/RLS, credential CAS/scope/purpose, concurrent event identity across rotation,
fresh expiry after an observed lock wait, revoke/state/close fencing, known/unknown
values, exact multi-currency sums, independent coverage, transaction fault rollback,
50-row bulk/replay, mixed failures, duplicate rejection and reverse-order races.
They do not repeat the old 18-case suite. Both migrations are applied to a fresh
owned database; all original rows are snapshotted before and after V2.

Before pg import/connection, fixtures require `CI=true`,
`LINKY_DISPOSABLE_DATABASE=true`, `LINKY_DISPOSABLE_DB=linky-pg17-extension-v2`, and
the exact authored loopback URL for `linky_extension_checks`. Before applying
source they verify PG major 17 and comment `linky-extension-disposable-ci-v2`.
All pools close; the schema/roles remain for the later real browser stage.
No local database or test execution is claimed here. Live migration, native TLS,
runtime credentials, hosted owner/recipient/ingest acceptance, reputation checks,
origin-enforced resource protection and account integrations remain separate.
