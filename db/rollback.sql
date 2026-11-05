-- Destructive operator-only rollback. Inspect/export Linky's own records first.
-- Does not drop roles, credentials or any other application's objects/ACLs.
-- Requires an explicit psql variable: -v LINKY_CONFIRM_ROLLBACK=linky-private-only
\if :{?LINKY_CONFIRM_ROLLBACK}
SELECT :'LINKY_CONFIRM_ROLLBACK' = 'linky-private-only' AS linky_confirmed \gset
\else
\quit 2
\endif
\if :linky_confirmed
BEGIN;
DROP SCHEMA linky_private CASCADE;
COMMIT;
\else
\quit 2
\endif
