# Dedicated project schema

5 November 2026, observations through 08:44:30 UTC. Standing all-work approval
covers the dedicated free project and reviewed migrations; the [18 actual PG
cases passed](service-attempt-1.md) before live application. The
[catalog receipt](live-schema.json) records the exact source hashes and metadata.

Read-only preflight found public ordinary tables zero, no Linky schema/roles,
installer `postgres`, server version `170011` (PostgreSQL 17.11). Applied only
the exact reviewed bootstrap and populated CLI scaffold to dedicated project
`bfteqhtzyzrinzxmgiee`, using Supabase migration tooling. Managed migration
versions are `20261105084324` and `20261105084331`; these provider history IDs
are distinct from the source scaffold's `20261105080045` timestamp.

Post-application catalog verification found three restricted roles, zero login
memberships, eight private RLS-enabled tables owned by the non-login function
owner, zero runtime/operator direct table grants, thirteen runtime and two
operator functions, zero PUBLIC function execution and zero effective runtime
table access in Auth/Storage/Vault. No other app was queried or changed.
This is catalog verification through the installer, not a restricted native
login/TLS connection test or a hosted product acceptance result.

Security advisors returned no errors/warnings and eight informational
[RLS-without-policy notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
That matches the explicit private-function design: runtime cannot use tables,
while security-definer functions authenticate capabilities and run as the
non-login table owner. Do not add broad policies to suppress these notices.

No role password, workspace, owner recovery credential or runtime hosting
binding was created. The exact transaction pooler host/port/user pattern remains
pending user input because the connector lacks it and Chrome tab selection
still fails with `Cannot read properties of undefined (reading 'timeoutMs')`.
No retry or alternative automation bypass was used. Verified TLS/native login
and actual hosted owner/recipient checks remain pending. No paid plan, shared
Auth/session, other-app key or privileged runtime fallback.
