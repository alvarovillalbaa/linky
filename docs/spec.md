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

Use shared PostgreSQL, ready to host through Supabase/Vercel. Two current active
Supabase projects were verified read-only: Still (also serving Kickoff) and
Dearweek, in the existing Clous organization. No new free slot, paid plan,
paused-app replacement or permission to reuse a project is inferred.

The [persistent-service proposal](proposals/persistent-service.md) specifies a
Linky-only schema/login role in Still's existing project, independent owner and
recipient capabilities, and a pinned PostgreSQL driver. It needs explicit
approval before implementation of the security model/dependency, and a later
review of exact migration/check artifacts before any live database change.

The initial source prepares ungated domain/UI contracts and reviewable policy.
No live persistent service, migration, credential, Auth change, dependency
installation, backend/browser check or hosted acceptance is established by
this preparation. The full product and portfolio goal remain unfinished.
