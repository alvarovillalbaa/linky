# Linky

[Open the unconfigured review](https://linky-alvaro.vercel.app) ·
[Publication and proof limits](docs/results/2026/11-05/extension-publication.md).

Manage destinations, make recipient access deliberate, and count committed
redemptions without claiming they are people, visits or sales.

Reviewed CSV rows can be saved in bounded batches with explicit per-row outcomes
and recoverable identities. Separate write-only conversion keys accept declared
leads/sales against committed receipts. Reports keep currencies, unknown values
and independently bounded cohorts separate. See the
[extension HTTP](docs/service-extension-http.md),
[database](docs/service-extension-database.md) and [UI](docs/service-extension-ui.md)
contracts; dated results distinguish source, disposable checks and live binding.
The [extension's 55 focused cases](docs/results/2026/11-05/extension-checks.md)
passed, with 34 unchanged helper cases carried forward. Its
[additive schema is applied](docs/results/2026/11-05/extension-live-schema.md);
runtime credentials and hosted acceptance remain unbound.

The source includes a PostgreSQL-backed owner workspace and recipient flow:
create/revise destinations, issue finite expiring grants, inspect the hostname,
explicitly redeem, recover a committed receipt after an uncertain reply, and
pause/revoke. Existing grants retain their destination revision. An ordinary URL
already disclosed remains usable outside Linky's gate.

The interface starts empty and needs a privately provisioned owner credential.
There is no public signup, shared Auth session, demo catalogue or local-storage
fallback. Recipient secrets are captured from the original grant fragment,
removed from history and kept in tab memory. Inspection consumes no use and
reveals no usable URL. Opening the committed destination is a separate choice.

Source acceptance and live binding are recorded separately. Dedicated free
Supabase project `bfteqhtzyzrinzxmgiee` belongs to Clous; verified pooler/TLS and
independent runtime/operator credentials remain activation requirements.
Never deploy the operator connection or a project-wide service key.

Read the [full brief](docs/spec.md), [HTTP contract](docs/http-contract.md),
[database contract](docs/database-contract.md), [architecture](docs/architecture.md)
and [acceptance scope](docs/proposals/persistent-service-checks.md).
The earlier [70 V1 cases](docs/results/2026/11-05/service-checks.md) cover disposable
unit/HTTP, PostgreSQL and desktop/narrow browser environments. The
[original schema is applied](docs/results/2026/11-05/live-schema.md); this is
separate from the still-pending verified live connection and hosted acceptance.
The [generator receipt](docs/results/2026/11-05/source-prerequisites.md) records
the exact pg lock and CLI-generated migration scaffold.

Operator provisioning uses `node scripts/provision-workspace.mjs --name <name>
--recovery-file <private-file>` with a separate `LINKY_OPERATOR_DATABASE_URL`
and optional `LINKY_PG_CA`. The actual login must be `linky_operator`.
A mode-0600 owner recovery file is synced before the write. Retain it and retry
the same command after an uncertain acknowledgment; the key is never printed.
Bootstrap and migration are operator artifacts. Rollback is destructive and
requires an explicit reviewed export/approval for live data.

Vercel uses Node 24 and server-only `LINKY_DATABASE_URL`,
`LINKY_PUBLIC_ORIGIN`, optional `LINKY_PG_CA`. Runtime uses only its restricted
login, verified TLS, one pooled connection and unnamed parameterized queries.
Missing configuration leaves shared controls unavailable.
`GET /api/v1/status` reports configuration presence, not database health.

CSV review alone remains unsent; saving valid reviewed rows requires an explicit
owner action. Recover an uncertain batch with its same identities before
separately resuming remaining batches. Authenticated declarations are not
independently verified purchases. Identity/SSO, protected origins and external
malware/reputation providers remain open. Address checks fetch no site and do
not establish malware safety. Live activation and the full portfolio remain unfinished.

`node scripts/check.mjs` checks syntax/imports/assets/dependencies without
executing product modules. Database/browser checks belong to the guarded
disposable CI scope; Storage Guard blocks local installs/test databases.
