# Persistent-service source prerequisites

5 November 2026. The user's standing approval covers the scoped service policy,
driver, migration source, temporary CI and focused checks. This replaces the
29 October pending source-approval state; it does not establish live readiness.

[Job 127123650194](https://github.com/alvarovillalbaa/linky/actions/runs/41991216097/job/127123650194)
passed at source `9e8afe3703706f663c978648b4be8e2b25222752`, 08:00:31–08:00:49 UTC.
Node 24.21.0 resolved only the approved `pg@8.23.1` application dependency, with
scripts/audit disabled and no installed application `node_modules` directory.
The exact lock is 5,695 bytes, SHA-256
`b7e3f953ff3d176425cdc6add156564040ceabe2c69ca6c06f60fdf654884316`.

Pinned `supabase@2.122.0` version/help discovery and `migration new` generated
`supabase/migrations/20261105080045_linky_initial_service.sql`: initially zero
bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Both generated outputs were retrieved from the bounded public log export and
their exact bytes verified before retaining them. The scaffold is subsequently
populated with reviewed SQL; its initial digest is not the populated SQL digest.
The active workflow was removed in `928e865`; its inactive original remains in
the proposal. **Zero product tests and zero database connections** in this job.

Fresh Storage Guard measured 18.3 GiB available against 38 GiB required for a
backend environment. No local dependency install, app build or test database.

Fresh project listing reports Still inactive; its October active/capacity claim
is historical. Supabase quoted a new project at $0/month and returned dedicated
Linky `bfteqhtzyzrinzxmgiee`, Clous `jnmtatndgpzawemtiukl`, eu-central-1,
`ACTIVE_HEALTHY`. No Still/Kickoff Auth, tables, credentials or grants are reused.
The response's creation timestamp is recorded by the provider as
`2026-11-05T06:22:08.745238Z`; this is distinct from this session's 08:02 UTC
observation. Pooler/TLS/runtime credential binding and live acceptance are not
established by project metadata. No paid plan or enrollment was requested.

References read: [current connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres),
[pg TLS guidance](https://node-postgres.com/features/ssl), and the
[CLI v3 change](https://supabase.com/changelog/supabase-cli-v3).
The generator stays pinned to v2; it never links or applies to a hosted database.
