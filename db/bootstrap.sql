-- Operator artifact. Never run through the deployed runtime connection.
-- Passwords are deliberately absent; provision them privately after review.
BEGIN;
DO $bootstrap$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'linky_function_owner') THEN
    CREATE ROLE linky_function_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['linky_runtime', 'linky_operator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL', role_name);
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('linky_function_owner','linky_runtime','linky_operator')
      AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
        OR r.rolcanlogin <> (r.rolname <> 'linky_function_owner'))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE r.rolname IN ('linky_runtime','linky_operator')
  ) THEN RAISE EXCEPTION 'Linky role configuration requires operator review'; END IF;
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO linky_runtime, linky_operator', pg_catalog.current_database());
END
$bootstrap$;
-- The installing operator needs explicit SET, not inherited application access.
GRANT linky_function_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
CREATE SCHEMA IF NOT EXISTS linky_private AUTHORIZATION linky_function_owner;
DO $owner$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
                 WHERE n.nspname = 'linky_private' AND r.rolname = 'linky_function_owner') THEN
    RAISE EXCEPTION 'Linky schema ownership requires operator review';
  END IF;
END
$owner$;
REVOKE ALL ON SCHEMA linky_private FROM PUBLIC;
GRANT USAGE ON SCHEMA linky_private TO linky_runtime, linky_operator;
COMMIT;
