# Persistent-service acceptance scope

5 November 2026. Covered by the user's standing approval to complete the apps,
including scoped dependency/security work, focused checks and temporary CI.

One public Ubuntu GitHub job, capped at 20 minutes, owns one disposable PostgreSQL
17 service and a temporary Chromium environment. Application dependencies use
the generated lock (`pg@8.23.1`); browser tooling is CI-only Playwright 1.64.1.
No production connection, account, provider/model call or paid enrollment.

Run existing authored destination/attribution cases and new bounded HTTP tests;
then real PostgreSQL capability, concurrency, idempotency, expiry, immutable
revision, revocation, audit/receipt atomicity and restricted-role checks. Finally
exercise desktop and narrow-screen browser journeys against the actual API and
database: owner creates/revises a link, issues a finite recipient grant,
recipient inspects and explicitly redeems, owner pauses/revokes, denial/reload
and committed report counts. Workspace credentials and content are disposable
fixtures in that isolated service. They never seed the hosted product.

The controller retains exact pre/post tracked source seals, command exit/timeout
and process-group state, and bounded compressed raw streams. A failed stage
stops later stages. Browser cleanup records context/browser/server/pool closure;
job cleanup removes only its installed dependencies/tools/browser cache and the
service container. Failed evidence remains; a later pass cannot rewrite it.
No timeout, assertion or permission boundary is relaxed to obtain a pass.

After attempt 1, the 50 unit/HTTP and 18 real-PG cases are closed. The browser
retry validates their pinned receipt, raw-stream digests and all unchanged
application/backend inputs, prepares the same schema in a fresh owned database,
and repeats zero accepted backend cases. Its only journey change explicitly
navigates to Links after reloading Attribution. The first failure stays immutable.

The workflow remains an inactive proposal except on the task-owned QA branch.
Retire its active workflow after terminal execution. These checks establish
only the recorded disposable environments; live pooler/TLS, deployed secrets,
hosting and production acceptance require their own actual observations.
