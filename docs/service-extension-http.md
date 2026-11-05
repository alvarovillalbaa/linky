# Bulk creation and declared-conversion HTTP boundary

5 November 2026. Authored source under the owner's standing approval; these
contracts are not an assertion of applied V2 SQL, live credentials or hosted
acceptance. The [product contract](spec.md), [initial HTTP contract](http-contract.md)
and [database contract](database-contract.md) retain their historical boundaries.
The extension uses the same named-query repository, verified TLS, exact runtime
role, one-connection pool and explicit COMMIT-before-response behavior.

All routes below are POST JSON under `/api/v1`. Bodies remain at most 32 KiB,
read within five seconds, with closed key sets and no query credentials. Owner
routes retain the exact same-origin policy and `Bearer lyo_…` authorization.
UUIDs are canonicalized and positive versions remain compare-and-swap inputs.
There is no generic SQL dispatcher, provider call, URL fetch or publishing API.

## Persistent bulk creation

`/links/bulk-create` accepts exactly:

```text
{workspaceId,rows:[{mutationKey,linkId,revisionId,slug,draft}]}
draft = {title,destination,source,medium,campaign}
```

There must be 1–50 rows and the entire encoded body must fit 32 KiB. A CSV
preview may contain up to 500 rows; the caller prepares smaller explicit
batches. The API supplies each row's zero-based `sourceIndex` from its position
in this batch. Unknown row keys, malformed IDs/slugs and duplicate mutation
keys, link IDs, revision IDs or slugs reject the batch before any mutation.
The server recomputes each draft through the existing destination/UTM policy.
Invalid drafts receive `destination_invalid`; valid normalized rows enter one
`owner_bulk_create_links` transaction. No client-provided safety verdict,
destination hash, campaign authority or in-memory catalogue substitutes for SQL.

The exact response is `{outcomes:[...]}`, with each row containing:

```text
{sourceIndex,mutationKey,linkId,revisionId,
 status:'committed'|'replayed'|'error',version:number|null,error:null|string}
```

Rows are returned in batch-index order. Committed/replayed outcomes have a
positive version and null error. Error outcomes have null version and a finite
public error code. Expected SQL row refusals are isolated by database
subtransactions; unexpected row failures are `service_unavailable`, never SQL
text. All database row outcomes are withheld until the outer transaction
commits. A batch containing only invalid drafts returns only local validation
errors and does not connect to PostgreSQL or authenticate a workspace record;
it discloses no existing records and performs no write.

Generate and privately retain every row's exact intent/IDs before sending.
After a known partial outcome, explicitly retry failed intents without changing
their IDs. After an uncertain whole acknowledgment, explicitly retry the same
whole batch body so durable receipts can recover its committed outcomes. The
server performs no automatic write retry and never regenerates client IDs.

## Conversion credentials

Owner-generated ingest keys have a distinct `lyi_` prefix followed by 64
lowercase hexadecimal characters: 32 random bytes. SHA-256 covers the entire
purpose-prefixed key. Owner, recipient and ingest keys cannot substitute for
one another. The owner retains the key, credential UUID and mutation UUID
before issuance; SQL stores only its hash. Ordinary draft text, labels and
success DTOs reject recognized raw `lyo_`, `lyr_` and `lyi_` key strings.

| POST suffix | Exact request |
| --- | --- |
| `/conversion-credentials/issue` | `{workspaceId,mutationKey,linkId,revisionId,expectedVersion,credentialId,ingestKey,label,expiresAt}` |
| `/conversion-credentials/list` | `{workspaceId,linkId,limit,after}` |
| `/conversion-credentials/revoke` | `{workspaceId,mutationKey,linkId,credentialId,expectedVersion}` |

Labels are at most 200 characters, expiry is a canonical UTC ISO timestamp,
and lists use limit 1–50 plus explicit UUID/null cursor. Issue/revoke CAS and
increment link version; the credential remains pinned to its exact revision.
Issue returns `{workspaceId,linkId,credentialId,revisionId,version,replayed,mutationKey}`;
revoke returns `{workspaceId,linkId,credentialId,version,replayed,mutationKey}`.
HTTP adds `mutationKey` only after committed SQL acknowledgment.

Listing returns `{credentials,nextCursor}`, with each entry exactly
`{id,linkId,revisionId,label,purpose:'conversion_ingest',expiresAt,revokedAt,createdAt}`.
There is no plaintext-key recovery, hash response, recipient disclosure or
wildcard credential scope. Lost key material requires explicit new issuance.

## Authenticated declarations

`/conversions/ingest` accepts exactly:

```text
{credentialId,receiptId,eventKey,kind,amountMinor,currency,declaredAt}
```

Its only credential is `Authorization: Bearer lyi_…`. This endpoint alone
permits absent Origin for server-to-server callers. A supplied Origin must be
the exact configured public origin; cross-site Fetch Metadata is refused.
Cookies are refused, no CORS grant is issued, and GET/HEAD cannot ingest or
disclose. Owner/recipient credentials and body/query credential fields fail.

`kind` is `lead_declared` or `sale_declared`. Leads require both value fields
null. Sales use either both null for unknown value, or a nonnegative safe
integer `amountMinor` and three uppercase ASCII currency letters. Zero is a
known value. `declaredAt` is canonical UTC ISO evidence, never authorization
time. SQL checks current workspace/link/credential, purpose, expiry, revocation
and exact committed receipt/revision scope under locks and database wall time.
Current denial applies to retries too. Same-scope rotated credentials can
recover matching event keys; changed semantic payload conflicts. No campaign,
destination, owner role or arbitrary metadata is accepted from ingestion.

After commit, the exact acknowledgment is
`{eventId,workspaceId,linkId,revisionId,receiptId,eventKey,kind,acceptedAt,replayed}`.
The caller retains its stable event UUID before writing. An unavailable result
does not prove rollback; explicitly retry identical intent under current valid
authorization. Finite expiry/revocation errors on this endpoint are
`credential_expired` and `credential_revoked`, distinct from grant failures.

## Bounded attribution

`/reports/attribution` accepts owner-authorized
`{workspaceId,from,to,limit}`: canonical UTC ISO/null endpoints and limit 1–50.
SQL defaults to the last 30 days and caps the window at 366 days. Each dataset
selects its own newest bounded cohort using committed/accepted database time,
with `[from,to)`, record count and truncation retained. The response is:

```text
{conversionsAvailable:true,
 redemptions:{count,campaigns:[{campaign,count}],coverage},
 declarations:{total,leads,sales,unknownValueSales,
   campaigns:[{campaign,leads,sales,unknownValueSales}],
   currencies:[{currency,amountMinor:string,sales}],coverage}}
campaign = {source,medium,campaign}
coverage = {kind,from,to,limit,recordCount,truncated}
```

Coverage kinds are `committed_redemptions` and
`accepted_conversion_declarations`. Currency totals are canonical decimal
integer strings, preserving exact sums beyond JavaScript's safe-integer range.
Unknown-value sales are counted separately and excluded from currency totals;
currencies are never combined or converted. The HTTP guard checks closed
shapes, count/cohort consistency and exact decimal bounds before responding.
The aggregate response is capped at 256 KiB.

These are authenticated declarations, not verified purchases, unique people,
destination arrival or independent revenue evidence. Public `/status` now reports
`conversionsAvailable:true` for implemented functionality while retaining
configuration presence and `database:'unverified'` as separate facts. The older
redemption-only report retains `conversionsAvailable:false` because that endpoint
does not include declarations. No live service binding or provider acceptance
follows from these source contracts or injected-repository unit fixtures.

The [focused HTTP fixtures](../tests/unit/service-extension-http.test.mjs) are
authored without a database/provider; actual named-function transactions,
locking, expiry, replay and rollback require the separate PostgreSQL fixtures.
