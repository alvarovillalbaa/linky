# Additive schema applied to dedicated Linky

5 November 2026. The exact reviewed extension SHA
`e8153d0486e7c997d4e85ca18b2b4a2ab9822908125c1cad44c5697b8738a092`
passed all 23 real PostgreSQL cases in [attempt 1](extension-attempt-1.md) before
live application. Browser acceptance is a separate scope; its two recorded
failures do not become passes because SQL is applied.

Fresh preflight found zero workspaces/links/grants/receipts and no extension
table in dedicated project `bfteqhtzyzrinzxmgiee`. Supabase applied the additive
migration as managed version **20261105100649**, distinct from source scaffold
timestamp **20261105092311**. Migration one remains immutable. No other app,
Auth session, role password or actual owner/workspace was changed/provisioned.

The [catalog receipt](extension-live-schema.json), through 10:07:43 UTC, records
ten private RLS-enabled tables owned by `linky_function_owner`, zero direct
runtime/operator table grants, nineteen runtime functions, two operator
functions, zero login memberships and zero PUBLIC execution. No credential or
declaration exists in the live database. These are installer catalog reads,
not a restricted native connection or TLS/product acceptance test.

Security advisors returned ten informational
[RLS-without-policy notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
and no error/warning. That matches the reviewed private-function design; do not
add public policies to silence it. Table-owner bypass is intentional and every
entry point authenticates its purpose-bound capability.

No runtime DSN, private role/owner key or hosted workspace has been created.
Verified pooler/TLS and hosted owner/recipient/integration acceptance remain
pending the already requested non-secret connection detail. No model call,
paid plan, new account, live fixture or other-app permission change.
