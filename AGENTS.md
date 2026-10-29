# Linky

- The full four-part brief is preserved in docs/spec.md: link management,
  access controls via links at scale, marketing/sales attribution and link safety.
  A local editor alone does not satisfy that product.
- Source creation/publication to personal GitHub is authorized by the portfolio
  goal. No backend/security policy, dependency, schema or live shared-project
  change has yet been approved for Linky. The prior Still/Kickoff consolidation
  does not authorize Linky reuse.
- Before implementing authentication/capability enforcement, adding pg or
  creating migrations, obtain the exact scoped approval in
  docs/proposals/persistent-service.md. Do not apply a schema, create a role,
  change provider config or provision credentials under a source-only approval.
- Never share other apps' Auth users, private data or privileged project keys.
  The proposed isolated database role/schema still shares infrastructure/quota;
  it is not a dedicated Supabase project. Unexpected inherited private access
  blocks rollout; do not alter other apps' permissions to make a check pass.
- Owner, recipient and conversion-ingest capabilities must have separate
  purposes. Do not implement that policy before its approval. No secret enters
  a committed fixture, public record, query string, log or analytics event.
- GET/HEAD must never consume a use. Proposed redemption/revocation serialize
  under database locks, use database wall time after locking, and commit a
  stable idempotent receipt before returning a destination. No memory counter.
- Redirect gating cannot revoke access to a destination already learned.
  Origin-enforced resource access is separate unfinished scope; do not claim
  the link gate protects arbitrary downstream files or pages.
- Attribution reports observed committed redemptions and authenticated declared
  conversion events separately, never unique people, arrival or verified sales.
  Address checks are not a malware/reputation guarantee.
- Use apply_patch and preserve work. Node syntax/import/static/document checks
  and git diff --check are safe. Backend/domain tests, browser/server checks,
  installations and CI need their separately prepared execution approval.
- Persist evidence in owning docs. No fake database/session/campaign data or
  browser-local substitute for the intended shared PostgreSQL service.
