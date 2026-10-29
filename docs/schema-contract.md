# Proposed PostgreSQL contract

29 October 2026. **Reviewed design proposal, not SQL, an applied schema or an
accepted security implementation.** The [full product contract](spec.md) remains
binding. The [first approval request](proposals/persistent-service.md) covers
implementing the proposed capability model, adding `pg@8.23.1` and authoring a
reviewable migration, with any additional action limited to that request's exact
published scope. This dictionary itself authorizes no dependency installation,
live role creation, migration application, production configuration, tests or CI.

The root's [source-preparation receipt](results/2026/10-29/source-preparation.md)
and [metadata record](results/2026/10-29/source-preparation.json) own the fresh
provider observations. This document's author did not query provider metadata,
application rows or credentials. Still is only the proposed hosting candidate;
its earlier consolidation approval does not authorize Linky reuse.

## Identity, types and bounds

All ten proposed tables and callable database functions belong to the new,
non-exposed `linky_private` schema. There are no Linky public RPCs, public-table
catalogues, `auth.users` foreign keys, `auth.uid()` authorization checks or shared
Supabase Auth sessions. Linky owner, recipient and conversion-ingest capabilities
have distinct purposes. A recipient or ingest credential never becomes an owner.

- IDs and mutation/redemption/event keys are UUIDs. A capability has at least
  32 cryptographically random bytes; only its SHA-256 hash is persisted, as
  64 lowercase hexadecimal characters. Credential hashes are not public IDs.
- Provisioning is an explicit operator action, with no public signup. Newly
  issued secrets and stable IDs must be retained privately by their issuing
  operator/client before the corresponding write, so a lost acknowledgement
  does not require recovering plaintext from the database. Ordinary receipts
  never contain plaintext secrets. Lost secret material is not recoverable from
  a hash; replacement is an explicit revoke/rotate action.
- `timestamptz` fields use server-generated UTC instants unless identified as
  a declared event time. Database authorization uses `clock_timestamp()` after
  acquiring its locks, not the browser clock or transaction-start `now()`.
- A `hash` below is a checked 64-character SHA-256 value. A `snapshot` is bounded
  JSONB with a closed field set, never arbitrary imported metadata. Fingerprints
  cover the normalized operation, complete resource scope and semantic payload;
  authorization secrets and transient request timestamps are excluded.
- HTTP(S) destination strings are bounded to 2,048 characters after URL
  normalization. No embedded credentials or executable schemes are accepted.
  The separately reviewed destination/address policy governs admission; saving
  an address performs no fetch and supplies no malware/reputation verdict.
- Owner batches contain at most 50 rows; an explicit CSV import contains at most
  500 rows and is previewed before submission in bounded batches. Each row has a
  stable mutation key and an explicit committed/replayed/conflict outcome. CSV
  size does not imply one 500-row transaction or all-or-nothing import.
- Composite foreign keys always retain workspace/link/revision ownership.
  UUID uniqueness alone must not permit a foreign workspace's row to be attached.
  No cross-app cascade, trigger, function or foreign key is introduced.

## Ten-table dictionary

The following column lists are complete proposed application records. PostgreSQL
constraints, exact function signatures, ownership and rollback SQL must still
be reviewed in the later migration artifact.

### 1. `workspaces`

Columns: `id uuid`, `name varchar(160)`, `owner_key_hash char(64)`,
`owner_key_version bigint`, `state text`, `created_at timestamptz`,
`updated_at timestamptz`, `closed_at timestamptz null`.

Primary key `id`; unique owner hash; positive key version; nonblank name;
state is `active` or `closed`, with `closed_at` present exactly when closed.
Operator provisioning creates the initial owner binding. Rotation changes the
hash and increments its version transactionally; old owner credentials stop
authorizing operations. Closing blocks new redemptions and conversion ingestion
without claiming to revoke a URL already disclosed. No automatic physical
deletion or retention policy is implied. Index `(state, created_at, id)` supports
operator inventory without exposing it to runtime callers.

### 2. `links`

Columns: `id uuid`, `workspace_id uuid`, `slug varchar(96)`, `label varchar(200)`,
`state text`, `version bigint`, `current_revision_id uuid`,
`created_at timestamptz`, `updated_at timestamptz`.

Primary key `id`; unique `(workspace_id,id)` and global `slug`; workspace FK;
nonblank label; slug contains 8–96 ASCII letters, digits, underscores or hyphens.
State is `active`, `paused` or `blocked`; version is positive. Slugs identify
links and are not credentials. A deferred composite FK binds the current
revision to this exact workspace/link; creation commits both records together.
Owner updates require the expected link version and increment it once. Index
`(workspace_id,state,updated_at,id)` supports bounded owner lists.

### 3. `destination_revisions`

Columns: `id uuid`, `workspace_id uuid`, `link_id uuid`, `revision_number bigint`,
`destination_url varchar(2048)`, `destination_sha256 char(64)`,
`campaign_snapshot jsonb`, `safety_snapshot jsonb`, `created_at timestamptz`.

Primary key `id`; unique `(workspace_id,link_id,id)` and
`(workspace_id,link_id,revision_number)`; same-workspace link FK; positive
revision number. Campaign snapshot has only `source`, `medium`, `campaign`,
each a string of at most 100 characters. It records declared tags, not an
authenticated third-party campaign identity. Other destination-query bytes
remain preserved without claiming to interpret or track them. Safety
snapshot contains the checked policy version, canonical hostname and observed
address-check result; reputation remains explicitly `unchecked` unless a later
approved integration supplies provenance. Both snapshots are at most 4 KiB.
Rows are immutable. Changing destination or campaign creates a new revision and
CAS-updates the link pointer; existing grants keep their pinned revision.
The server recomputes the destination hash from the normalized URL's UTF-8 bytes.
Index `(workspace_id,link_id,revision_number desc)` supports history.

### 4. `grants`

Columns: `id uuid`, `workspace_id uuid`, `link_id uuid`, `revision_id uuid`,
`recipient_key_hash char(64)`, `label varchar(200)`, `max_uses integer`,
`used_count integer`, `expires_at timestamptz`, `revoked_at timestamptz null`,
`created_at timestamptz`.

Primary key `id`; unique recipient hash and
`(workspace_id,link_id,revision_id,id)`; composite revision FK. `max_uses > 0`,
`0 <= used_count <= max_uses`; expiry is explicit and after creation. Recipient
key, pinned revision, limit and expiry are immutable; revocation is one-way.
Changing these terms requires a new grant, not silent retargeting. Only the
redemption transaction increments use count. Index
`(workspace_id,link_id,created_at,id)` supports owner grant lists. A link state
change affects all its grants, including grants to older destination revisions.

### 5. `redemption_receipts`

Columns: `id uuid`, `workspace_id uuid`, `link_id uuid`, `revision_id uuid`,
`grant_id uuid`, `redemption_key uuid`, `request_fingerprint char(64)`,
`use_number integer`, `destination_sha256 char(64)`, `campaign_snapshot jsonb`,
`redeemed_at timestamptz`.

Primary key `id`; unique `(grant_id,redemption_key)` and `(grant_id,use_number)`;
unique `(workspace_id,link_id,revision_id,id)` for conversion references;
composite FK to the exact grant workspace/link/revision. `use_number > 0`.
The immutable destination hash and campaign snapshot must match that revision.
The full target is obtained from the pinned immutable revision only after fresh
authorization, not copied into public receipt metadata. Receipt creation, one
counter increment and its attribution event commit together. Index
`(workspace_id,link_id,redeemed_at,id)` supports scoped attribution.

### 6. `attribution_events`

Columns: `id uuid`, `workspace_id uuid`, `link_id uuid`, `revision_id uuid`,
`receipt_id uuid`, `kind text`, `campaign_snapshot jsonb`,
`observed_at timestamptz`.

Primary key `id`; unique `receipt_id`; composite receipt FK. Kind is only
`redemption_committed` in this proposal. Snapshot equals the receipt's campaign;
time equals its committed redemption time. Append-only: refresh/replay creates
no second event. Index `(workspace_id,observed_at,link_id,id)` supports actual
event counts. These rows prove neither unique people nor target arrival. No
raw capability, IP, user agent, referrer, private target or arbitrary personal
metadata is collected by this initial event contract.

### 7. `conversion_credentials`

Columns: `id uuid`, `workspace_id uuid`, `link_id uuid`, `revision_id uuid`,
`ingest_key_hash char(64)`, `label varchar(200)`, `purpose text`,
`expires_at timestamptz`, `revoked_at timestamptz null`, `created_at timestamptz`.

Primary key `id`; unique ingest hash and `(workspace_id,link_id,revision_id,id)`;
composite revision FK. Purpose is exactly
`conversion_ingest`; expiry is explicit and after creation; scope/key are
immutable and revocation one-way. Initial scope is one workspace/link/revision,
with no wildcard, owner permission, destination disclosure or receipt-list API.
Rotation issues a separate credential. Index
`(workspace_id,link_id,revision_id,created_at,id)` supports owner administration.

### 8. `conversion_events`

Columns: `id uuid`, `workspace_id uuid`, `link_id uuid`, `revision_id uuid`,
`receipt_id uuid`, `credential_id uuid`, `event_key uuid`, `kind text`,
`amount_minor bigint null`, `currency char(3) null`,
`declared_at timestamptz`, `accepted_at timestamptz`,
`request_fingerprint char(64)`, `campaign_snapshot jsonb`.

Primary key `id`; unique `(workspace_id,event_key)` across credential rotations;
composite receipt FK and same-scope credential FK. Kind is `lead_declared` or
`sale_declared`. Leads have null amount/currency. Sales may have both null when
value is unknown: count the declaration but exclude it from monetary totals.
Otherwise both are required: an integer amount from zero through `2^53-1` and
uppercase ASCII three-letter currency. Currency totals remain separate; no
exchange rate or verified-revenue claim is added.
`declared_at` is supplied evidence, not authorization time. `accepted_at` is
database wall time. Campaign snapshot comes from the receipt, never the ingest
body. Immutable rows preserve the originally accepting credential ID; an
authorized same-scope retry may use a rotated credential without changing it.
Index `(workspace_id,accepted_at,kind,currency,link_id,id)` supports reporting.

### 9. `mutation_receipts`

Columns: `id uuid`, `workspace_id uuid`, `mutation_key uuid`, `operation text`,
`resource_id uuid`, `request_fingerprint char(64)`, `owner_key_version bigint`,
`result_snapshot jsonb`, `created_at timestamptz`.

Primary key `id`; unique `(workspace_id,mutation_key)`; workspace FK. Operation
is a closed owner-write allowlist; resource ID is checked against the relevant
same-workspace record by that operation. Result snapshot contains only bounded
IDs, versions and committed status, at most 8 KiB; no raw capability or target.
Write and receipt commit together. Same key with changed operation/scope/input
conflicts; replay requires current owner authorization. A receipt is not an
authorization credential or plaintext-key recovery facility. A replay describes
that original committed write, not a claim that no later version exists. Index
`(workspace_id,created_at,id)` supports bounded operator investigation.

### 10. `audit_events`

Columns: `id uuid`, `workspace_id uuid`, `actor_kind text`,
`actor_id uuid`, `owner_key_version bigint null`, `action text`,
`resource_kind text`, `resource_id uuid`, `before_version bigint null`,
`after_version bigint null`, `occurred_at timestamptz`, `details jsonb`.

Primary key `id`; workspace FK. Actor kind is `operator`, `owner`, `recipient`
or `conversion_ingest`; IDs identify the trusted operator execution,
workspace, grant or credential respectively, validated inside the responsible
function. Actions/resource kinds are closed allowlists. Details contain bounded
IDs, reason codes and counts only, at most 4 KiB. No secrets, verification
hashes, full destinations, raw requests or recipient identities enter the log.
Events are append-only and commit with the corresponding change. Index
`(workspace_id,occurred_at,id)` supports bounded owner audit reads.

## ACL and connection contract

`linky_runtime` is a dedicated native PostgreSQL login with `NOSUPERUSER`,
`NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, `NOBYPASSRLS` and no inherited role
memberships. It is not a member of `anon`, `authenticated`, `service_role`, any
existing app role or a new function-owner role. It cannot provision workspaces,
create schema objects, change roles, read credential hashes or perform direct
table DML. Its password/connection string stays server-side; TLS certificate
validation cannot be disabled to make a connection work.

Only database connection, `USAGE` on `linky_private` and `EXECUTE` on an explicit
reviewed set of Linky functions are granted. A separate `NOLOGIN` function-owner
role owns only Linky objects; security-definer functions use an empty fixed
search path and fully qualified identifiers. Each entry point authenticates its
specific capability purpose and derives scope from stored records, never a
client-selected owner boolean. Runtime statements use bound parameters; callers
cannot supply SQL or SQL identifiers. There is no generic SQL/action dispatcher.

Revoke `PUBLIC` access/default function execution on the **new Linky objects**;
do not revoke or rewrite existing `public`, `private` or `still_private` ACLs.
No existing Supabase role receives Linky grants. Enable RLS on every Linky table
as defense against accidental direct exposure; runtime receives no broad
`USING (true)` policy or direct-table grant. Table-owner bypass and privileged
function behavior must be explicit in the reviewed migration: RLS alone does
not authenticate a capability or prove a security-definer function is safe.

Before any live application, inspect effective memberships, inherited `PUBLIC`
privileges, schema/table/function access and connection behavior. Unexpected
access to Still/Kickoff private objects blocks rollout. Do not repair that by
altering either app's grants, revoking shared privileges globally or using a
project-wide service-role credential. The exact isolated connection/ACL proof
needs its own approved fixtures and execution scope.

## Authorization, locking and atomic outcomes

All runtime operations first hold a shared workspace-row lock and recheck its
active state. Owner rotation/closure takes the exclusive workspace lock; it
cannot race an unchecked write. Within that lifetime, acquire link locks in
sorted UUID order, then the relevant grant, then the redemption receipt. This
preserves **link → grant → receipt** ordering. A batch never locks links in
CSV order. Creation uses stable IDs/unique constraints; a concurrent identity
conflict cannot leave partial resources or a fabricated receipt.

For redemption, hold the link and grant write locks, then obtain current database
wall time. Verify link active, exact recipient-key purpose/scope, pinned revision,
grant unrevoked and expiry strictly later than that time **before disclosing a
target or replaying a receipt**. GET/HEAD serve an inert page, disclose no private
target data and never consume uses. Explicit authorized POST inspection can show
bounded labels/hostname and denial state, never the usable destination as a
shortcut around the redemption transaction.

After those checks, look up `(grant_id,redemption_key)`. A matching committed
receipt may replay while the grant remains authorized, even when all uses have
been consumed. Changed input conflicts. With no receipt, require available uses,
increment once, insert receipt/event/audit and commit, then return the pinned
destination. A failed transaction returns no destination. An expired/revoked
grant, paused/blocked link or closed workspace cannot redisclose through an old
receipt. Concurrent final-use requests, revocation and destination changes share
the same link/grant locks. Redirection cannot revoke a target already learned.

Conversion ingestion holds the shared workspace and link locks, then locks its
credential before reading the referenced receipt. Revocation takes the same
link-before-credential order. Recheck current credential purpose, expiry,
revocation and stored scope using post-lock wall time; the receipt's workspace,
link and pinned revision must match exactly. Ingest cannot choose another
campaign or receive any destination/recipient data. A historical grant's expiry
does not itself invalidate a declaration about a committed redemption; current
ingest authorization is independently required. Replays likewise require a
currently valid same-scope credential. Same workspace/event key plus identical
semantic payload returns the existing acknowledgment; changed payload conflicts.
Store one declaration and audit event atomically, never a retry-inflated sale.

Owner state changes, grant revocation, credential revocation and their receipts
are transactional. Reports aggregate committed records only, with explicit
redemption/declaration denominators and separate currencies. They cannot infer
unique humans, destination arrival or verified commercial transactions.

## Retained gates and unfinished scope

This proposal does not authorize applying objects to Still, creating a login,
provisioning a workspace, handling actual credentials, installing dependencies,
changing Vercel settings or running checks. The later review must pin exact SQL,
role/function ownership, driver/connection configuration, retention/quotas,
rollback and isolated acceptance/cleanup artifacts before live changes.

A Linky-only role/schema shares Still's database infrastructure, capacity,
backups and failure domain; it is not a dedicated Supabase project or an assured
free allowance. Existing applications keep their Auth and permissions unchanged.
Protected-origin integration, full persistent runtime, link-safety acceptance
and hosted/browser proof remain unfinished under the [complete brief](spec.md).
