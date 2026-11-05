# Persistent HTTP contract

5 November 2026. Source implementation under the owner's standing all-work
approval. These routes are not evidence of a configured or accepted hosted
service. PostgreSQL owns capability scope, database time, locks, CAS,
idempotency and committed outcomes; the browser never supplies an owner role.

`createHandler({repository, origin, allowInsecureLoopback:false})` from
`server/http.mjs` returns an async Web `Request` → `Response` handler.
`createPostgresRepository({connectionString, ca?, allowInsecureLoopback:false})`
from `server/postgres.mjs` returns the named repository methods and `close()`.
Its dynamic pg import, single-connection pool, unnamed bound queries and
explicit transaction commit precede every successful result. The TLS parser
`parseConnectionConfig(options)` is also available to the separately privileged
operator CLI; that CLI owns its operator-role checks. Runtime URL usernames are
only `linky_runtime` or `linky_runtime.<20-character project reference>`, and
each database operation verifies actual `current_user = 'linky_runtime'`.

## Transport and credentials

Protected reads and writes are **POST JSON** under `/api/v1`. Required keys
below are exact; null pagination/time fields must be explicit. Unknown keys,
malformed UTF-8/JSON, query data and bodies over 32 KiB are refused. Every POST
requires `Origin` equal to `LINKY_PUBLIC_ORIGIN`. HTTPS is required; explicit
insecure `127.0.0.1` transport is only allowed by the injected CI option while
`CI=true`. No CORS grant or ambient authentication cookie is issued.
Raw request reading has a five-second application deadline. Vercel's adapter
uses the same closed route inventory as the Web handler, including singleton
`status`; its internal rewrite parameter is removed before request validation.
Other query parameters and conflicting/unknown route hints are rejected.

Owner requests use `Authorization: Bearer lyo_<64 lowercase hex characters>`.
Recipient requests instead carry `recipientKey: lyr_<64 lowercase hex
characters>` in their POST body and reject an Authorization header. Each token
contains 32 random bytes; SHA-256 covers its complete purpose-prefixed value.
No secret or credential digest belongs in an ordinary response, query, log or
analytics record. Responses use `Cache-Control: no-store` and no-referrer.

`GET`/`HEAD /api/v1/status` is public, never queries PostgreSQL and returns:
`{service:'linky',configuration:'required'|'present',database:'unverified',conversionsAvailable:true}`.
Configuration presence is not a health check. Other API GET/HEAD requests do
not disclose records or redeem anything. `/r/<grant UUID>` loads the inert
recipient shell. The UI holds its fragment credential only in memory and
removes that fragment immediately; GET, previews and prefetch never consume a use.

## Owner requests

All owner request bodies include the stated `workspaceId`; SQL still derives
and verifies ownership from the current capability. UUIDs are canonicalized.
Lists have `limit` 1–50 and UUID `after` or null. `draft` always has exactly
`{title,destination,source,medium,campaign}` and is recomputed through the shared
destination/UTM policy on the server, without fetching a target.

| POST suffix | Required body |
| --- | --- |
| `/owner/connect` | `{}` |
| `/links/list` | `{workspaceId,limit,after,state,search}`; state `all`, `active`, `paused`, `blocked`; search ≤200 characters |
| `/links/create` | `{workspaceId,mutationKey,linkId,revisionId,slug,draft}`; slug 8–96 ASCII letters, digits, `_` or `-` |
| `/links/revise` | `{workspaceId,mutationKey,linkId,revisionId,expectedVersion,draft}` |
| `/links/state` | `{workspaceId,mutationKey,linkId,expectedVersion,state}` |
| `/grants/issue` | `{workspaceId,mutationKey,linkId,revisionId,expectedVersion,grantId,recipientKey,label,maxUses,expiresAt}` |
| `/grants/list` | `{workspaceId,linkId,limit,after}` |
| `/grants/revoke` | `{workspaceId,mutationKey,linkId,grantId,expectedVersion}` |
| `/reports/redemptions` | `{workspaceId,from,to,limit}`; dates canonical UTC ISO strings or null; limit 1–50 |
| `/owner/rotate` | `{workspaceId,mutationKey,newOwnerKey,expectedOwnerKeyVersion}` |
| `/owner/close` | `{workspaceId,mutationKey,expectedOwnerKeyVersion}` |

Grant limits are 1–1,000,000 uses, label ≤200 characters and an explicit
canonical UTC expiry. SQL checks expiry against post-lock database time.
Grant issue/revoke also CAS and increment the link version. Existing grants
retain their immutable destination revision. Revising the label/destination
does not silently retarget an issued grant.

Connect returns `{workspace:{id,name,state,ownerKeyVersion}}`. Link lists return
`{links:[{id,slug,label,state,version,currentRevisionId,destination,campaign,safety,createdAt,updatedAt}],nextCursor}`.
Grant lists return `{grants:[{id,linkId,revisionId,label,maxUses,usedCount,expiresAt,revokedAt,createdAt}],nextCursor}`.
`nextCursor` is a UUID or null. There is no returned recipient secret or hash.

Owner mutations acknowledge their committed IDs/version/state with `replayed`.
The HTTP layer adds the supplied `mutationKey` only **after** PostgreSQL commits.
Refresh lists after an acknowledgment: an idempotent replay describes the
original committed operation, not necessarily a resource's latest version.
The client generates and privately retains all mutation/resource UUIDs and
new capability material **before** sending the first request. An uncertain
acknowledgment retains exactly that intent/key for an explicit retry; the
service never recovers plaintext from a hash or automatically retries writes.

Committed mutation bodies are flat, exact records (the final `mutationKey` is
added by HTTP after commit):

| Mutation | Acknowledgment |
| --- | --- |
| create / revise | `{workspaceId,linkId,revisionId,version,replayed,mutationKey}` |
| state | `{workspaceId,linkId,state,version,replayed,mutationKey}` |
| issue | `{workspaceId,linkId,grantId,revisionId,version,replayed,mutationKey}` |
| revoke | `{workspaceId,linkId,grantId,version,replayed,mutationKey}` |
| rotate | `{workspaceId,ownerKeyVersion,replayed,mutationKey}` |
| close | `{workspaceId,state:'closed',ownerKeyVersion,replayed,mutationKey}` |

Reports return `{redemptions,campaigns,coverage,conversionsAvailable:false}`;
`redemptions` is a nonnegative integer count, not an array of receipts.
Campaign rows are `{campaign:{source,medium,campaign},redemptions}`. Coverage is
`{kind:'committed_redemptions',from,to,limit,recordCount,truncated}` for the
bounded `[from,to)` cohort. Null dates select SQL's last-30-day window; SQL caps
the window at 366 days. This is committed redemption evidence, not unique
people, destination arrival, accepted conversions or independently verified sales.

## Recipient requests

`POST /recipient/inspect {grantId,recipientKey}` returns
`{grantId,linkId,label,hostname,safety,expiresAt,remainingUses}` after current
authorization. It returns no usable destination and consumes no use.

`POST /recipient/redeem {grantId,recipientKey,redemptionKey}` returns
`{receiptId,grantId,linkId,revisionId,useNumber,redeemedAt,destination,replayed}`
only after the transaction commits the use, receipt, event and audit. Generate
the stable redemption UUID before the first request. Same-key replay can recover
an uncertain acknowledgment even after the final use, while current permission
still holds. Expiry, revocation, inactive links and closed workspaces deny fresh
disclosure, including old receipt replays. A target already learned cannot be
revoked outside Linky. The UI does not automatically open an undisclosed target.

## Failure and deployment boundary

All errors are `{error:{code}}` with finite public codes. Validation is 400,
credentials 401, scope/origin 403, unknown Web-handler route 404, unsupported method 405,
CAS/idempotency/inactive/exhausted 409, body timeout 408, revoked/expired/closed 410, body overflow
413, non-JSON 415 and unavailable/configuration 503. Raw SQL, parameters,
capabilities and private targets never appear in error responses. An uncertain
commit is an unavailable response, not an invented rollback acknowledgment.

Vercel's adapter rejects an unknown/conflicting rewrite hint as `invalid_request`
(400), before the Web handler. This is the same closed allowlist exercised by
its adapter cases; the deployed unknown-route rejection therefore differs from
the Web handler's direct 404. The source capture is named `linky_route` and
the destination is `/api/v1`; Vercel supplies only that expected route hint.
Do not strip unknown query keys to accommodate a routing mistake.

`LINKY_DATABASE_URL`, `LINKY_PUBLIC_ORIGIN` and optional `LINKY_PG_CA` are private
runtime configuration. Connection URL query parameters are refused so they
cannot override verified TLS settings. No database role/schema, pooler host,
credential, provider setting or production binding is established by this code.
The dedicated Linky project replaces the older Still-reuse proposal; rollout
still requires actual connection metadata, least-privilege and hosted proof.

The production adapter preserves raw byte validation rather than reading the
platform's parsed `request.body` helper. Vercel's current
[Node helper implementation](https://github.com/vercel/vercel/blob/main/packages/node/src/serverless-functions/helpers.ts)
restores raw `data`/`end` events after its own buffering; the application limit
does not claim to bound that earlier platform buffering. Static responses also
receive a self-only CSP and framing denial through `vercel.json`.
