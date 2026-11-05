# Linky product contract

29 October 2026. [Owning Notion brief](https://app.notion.com/p/408a1ee8bd06805f8520c76bfb0e7c74),
read in full from the unverified snapshot dated 07:40:38 UTC, last edited
07:40:12 UTC. Its complete requirements are:

1. Link management.
2. At-scale access controls via links.
3. Marketing and sales attribution.
4. Link safety.

No provider, account model, destination integration or paid service was selected
by that short brief. The concrete workflows below are implementation proposals,
not additional requirements purportedly copied from Notion.

## Intended application

A durable operator workspace manages links, immutable destination revisions,
campaigns and separately scoped recipient grants. Operators can inspect,
search, create/edit, pause/revoke and preview bounded bulk operations. No
browser-local catalogue substitutes for server state. Actual private access,
empty/loading/error/conflict and recipient-denial states must be implemented.

Recipients inspect an explicitly shared grant, then explicitly redeem it. Page
loads/prefetching do not consume uses. Expiry, revocation and finite-use limits
are enforced transactionally by the server. An idempotent successful response
is recoverable after an uncertain network acknowledgement, while an expired or
revoked grant cannot redisclose the destination through an old receipt.

The gate controls Linky disclosure/redemption. An already disclosed ordinary
destination URL remains usable outside Linky. Strong resource-level revocation
requires origin-enforced grants or a separately approved protected-resource
integration; this remains open and must not be claimed as completed by redirects.

Attribution records committed redemptions and separately authenticated declared
lead/sale events, with campaign provenance and explicit denominators. Retries
do not double count; currency totals stay separate. An accepted declaration is
not independent proof of a purchase, a unique human or destination arrival.

Destination syntax/address checks, visible destination review, revision history
and pause/block controls support safety. Unchecked reputation stays unchecked.
Server fetching/proxying, malware providers and automated scanning require
separate concrete integration decisions; none is silently enabled.

## Persistence and operating scope

Use PostgreSQL through Supabase/Vercel. October's Still/Dearweek active-capacity
observation is historical. On 5 November Still reported inactive; Supabase
quoted $0/month and returned dedicated Linky `bfteqhtzyzrinzxmgiee` in Clous.
No other app's Auth, private objects or privileged credentials are reused.
See the [dated receipt](results/2026/11-05/source-prerequisites.md).

Standing user approval covers the purpose-bound owner/recipient service,
PostgreSQL source, pinned driver, focused checks and temporary CI. Current
[database](database-contract.md) and [HTTP](http-contract.md) contracts replace
the initial source-only preparation. A verified pooler/TLS/runtime credential
binding and hosted acceptance remain actual activation requirements.

The first service slice implements durable links/revisions, finite grants,
explicit inspection/redemption, pause/revoke and committed redemption reports.
The additive [service extension](service-extension-database.md) implements
persisted CSV batches and authenticated declared lead/sale ingestion, including
current authorization after key rotation, receipt-bound campaigns, exact
currency totals and independent report coverage. Source, disposable checks
and applied SQL remain separate evidence boundaries. Identity/SSO, protected
origins and reputation integrations remain unfinished; no source or narrow
check completes the full portfolio goal.
