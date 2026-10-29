# Linky

Link management, access controls, attribution and destination review.

**Persistent-service preparation, not a working hosted platform.** The
[complete brief](docs/spec.md) needs a real shared control plane and resolver.
No database, sign-in, capability enforcement or hosted service is configured.

Current source provides an operator/recipient presentation, one unsent draft
with actual URL/UTM review, bounded CSV previews and supplied-event attribution
logic. It does not store a local substitute catalogue or show sample metrics.
Shared actions explicitly require backend setup and remain disabled.

- `public/`: presentation and dependency-free data helpers. Reputation remains
  unchecked; source address findings are not a malware verdict.
- `tests/unit/`: 34 authored destination/attribution cases, unexecuted.
- [Service proposal](docs/proposals/persistent-service.md): independent owner,
  recipient and ingest capabilities, PostgreSQL source and proposed driver/CI.
- [Schema contract](docs/schema-contract.md): ten proposed records, restricted
  private functions/roles and atomic redemption/idempotency invariants.
- [Source receipt](docs/results/2026/10-29/source-preparation.md): inspected
  intent/provider metadata, source verification and outstanding gates.

The first approval would permit implementing the new security model, authoring
the SQL artifact, pinning `pg@8.23.1` and one temporary source-prerequisite CI
job. It does **not** permit a live migration/role, sharing another app's Auth,
credentials, provider configuration, backend/browser tests or production rollout.
The prepared source-prerequisite workflow is inactive under `docs/proposals/`.

```sh
node scripts/check.mjs
git diff --check
```

These parse source and check relative imports/assets/documents without importing
product modules or executing tests. No dependency installation is needed for
this preparation. Node 22+; the proposed backend/CI targets Node 24 explicitly.

A link gate cannot revoke an ordinary target URL already learned. Protected
origin integration and genuine shared persistence remain open under the full
product goal. Attribution counts supplied/committed records, not unique people
or independently verified purchases. MIT licensed.
