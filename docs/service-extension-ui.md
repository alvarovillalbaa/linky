# Persistent CSV and conversion workspace

5 November 2026. Source implementation under the standing all-work approval.
No execution result is claimed here. The [HTTP](service-extension-http.md) and
[database](service-extension-database.md) contracts own authorization and DTOs;
the [original UI](http-contract.md) recipient inspection/redemption remains.

## Reviewed persistent CSV

The existing chooser/paste review retains its 500-row/1-MiB UTF-8 bounds,
source row/line numbers, invalid inputs and destination findings. Recognized
`lyo_`, `lyr_` and `lyi_` capability strings are refused as ordinary metadata.
No destination website is fetched. Review alone sends no write.

`#bulk-save-reviewed` opens explicit confirmation (`Save valid rows`). Before
the first request, every valid row receives its mutation/link/revision UUIDs
and slug. Greedy batches satisfy both 50 rows and the actual UTF-8 JSON 32-KiB
limit, including workspace/envelope bytes. Invalid rows stay unsubmitted.
The client transport independently checks the same request-byte ceiling.

Acknowledged outcomes map by source index and exact original IDs. The table
shows invalid, unattempted, awaiting/unconfirmed, committed, replayed, conflict
and refused states. A lost or malformed whole reply retains its exact body and
all IDs. `#bulk-retry` explicitly recovers that batch, then stops;
`#bulk-resume` separately continues remaining batches. Known refused/conflict
rows have individual retry buttons using only their original intents.
No write is automatically retried or regenerated.

`#bulk-stop` requests a stop after the current batch; closing the CSV dialog
also stops between batches. An in-flight transaction is not described as
cancelled. Successful earlier rows remain committed. Refresh the registry to
load current records. Clearing the review/disconnecting requires a warning;
reloading cannot recover discarded row identities from local browser storage.

Selectors: `#bulk-source`, `#bulk-form`, `#bulk-save-reviewed`,
`#bulk-progress`, `#bulk-stop`, `#bulk-resume`, `#bulk-retry`, and table
`tr[data-source-row] .bulk-row-status[data-row-status]`.

## Write-only integration credentials

The selected link can issue an explicitly expiring credential pinned to its
current immutable revision. The browser generates 32 random bytes as
`lyi_<64 lowercase hex>`, credential UUID and mutation UUID **before** sending.
Only a matching committed acknowledgment enables copying. An uncertain issue
retains the same intent/key for the ordinary explicit mutation retry.

The private key is shown only after the owner's issue action, in
`#conversion-key`, with `#copy-conversion-key`. It never enters a URL, query,
download, log, analytics call or persistent browser store. Public
`#conversion-credential-id` remains distinct from the secret. Clearing uses
`Clear private conversion key` → `Clear private key`; it does not revoke the
credential. The service cannot recover plaintext. Lists show purpose, expiry,
revision and revocation; `Revoke conversion <label>` requires confirmation and
preserves accepted historical declarations.

`#conversion-instructions` identifies the server-to-server endpoint, header,
actual credential scope and required fields. It sends no example event and
never embeds the key into the example. Use an actual committed receipt ID
(the recipient can explicitly choose `#copy-receipt`), stable event UUID and
canonical declared time. Leads require null amount/currency; sales use either
both null for unknown value or a safe nonnegative minor-unit integer and an
explicit three-letter currency. No receipt parameter is appended to a target.

Selectors: `#conversion-form`, `#conversion-label`, `#conversion-expiry`,
`#issue-conversion`, `#conversion-credentials`, `#conversion-key`,
`#copy-conversion-key`, `#conversion-credential-id`.

## Actual bounded attribution

`#load-attribution-report` loads the full server report. Before loading, no
redemption/declaration/monetary totals are fabricated. Redemption and accepted
declaration cohorts retain separate bounds, limits, record counts and
truncation. The declaration cohort uses accepted time, not declared time.
Campaign snapshots are shown separately; no person/arrival attribution is inferred.

`#attribution-redemptions`, `#attribution-leads`, `#attribution-sales` and
`#attribution-unknown-sales` show validated server counts. Currency totals use
validated decimal strings directly (`.currency-total[data-currency]
.minor-unit-total`), without Number conversion, floating-point summation,
currency conversion or an assumed two-decimal scale. Unknown-value sales are
separate; known zero remains included. Declared sales are not verified purchases.
The older `#load-report` remains a redemption-only report, not a feature flag.

Owner epochs, busy guards and pending-intent checks reject stale responses.
Disconnect/pagehide abort reads and clear private keys, CSV/recovery state and
visible private records. No aborted request is assumed rolled back. Neither a
configuration-presence response nor source/disposable checks establish live
pooler/TLS, hosted credentials, a workspace or production integration.
