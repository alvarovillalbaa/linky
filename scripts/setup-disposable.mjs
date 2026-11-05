import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Setup only: do not repeat the already accepted backend cases on fresh CI.
const expected = 'postgresql://postgres:authored-ci-only@127.0.0.1:5432/linky_checks';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.LINKY_DISPOSABLE_DATABASE, 'true');
assert.equal(process.env.LINKY_DISPOSABLE_DB, 'linky-pg17-ci-v1');
assert.equal(process.env.LINKY_TEST_DATABASE_URL, expected);
const { Client } = await import('pg');
const client = new Client({ connectionString: expected, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
try {
  await client.connect();
  const { rows } = await client.query("SELECT current_database() AS name, current_setting('server_version_num')::int AS version, pg_catalog.shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname = current_database()");
  assert.deepEqual({ name: rows[0].name, major: Math.floor(rows[0].version / 10000), marker: rows[0].marker }, { name: 'linky_checks', major: 17, marker: 'linky-disposable-ci-v1' });
  await client.query(await readFile(new URL('../db/bootstrap.sql', import.meta.url), 'utf8'));
  await client.query(await readFile(new URL('../supabase/migrations/20261105080045_linky_initial_service.sql', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ disposableSchemaPrepared: true, postgresMajor: 17, backendCasesRepeated: 0 }));
} finally { await client.end(); }
