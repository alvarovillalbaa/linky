import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const expected = 'postgresql://postgres:authored-ci-only@127.0.0.1:5432/linky_extension_checks';
assert.equal(process.env.CI, 'true'); assert.equal(process.env.LINKY_DISPOSABLE_DATABASE, 'true');
assert.equal(process.env.LINKY_DISPOSABLE_DB, 'linky-pg17-extension-v2'); assert.equal(process.env.LINKY_TEST_DATABASE_URL, expected);
const { Client } = await import('pg');
const client = new Client({ connectionString: expected, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
try {
  await client.connect();
  const row = (await client.query("SELECT current_database() AS name,current_setting('server_version_num')::int AS version,pg_catalog.shobj_description(oid,'pg_database') AS marker,pg_catalog.to_regnamespace('linky_private') IS NOT NULL AS existing FROM pg_catalog.pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual({ name: row.name, major: Math.floor(row.version / 10000), marker: row.marker, existing: row.existing }, { name: 'linky_extension_checks', major: 17, marker: 'linky-extension-disposable-ci-v2', existing: false });
  const first = await readFile(new URL('../supabase/migrations/20261105080045_linky_initial_service.sql', import.meta.url));
  const second = await readFile(new URL('../supabase/migrations/20261105092311_linky_service_extension.sql', import.meta.url));
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha(first), '406957876504aeb4c99a42f6488f24c325aaf9c2e41b8dc501f5c227b08249be');
  assert.equal(sha(second), 'e8153d0486e7c997d4e85ca18b2b4a2ab9822908125c1cad44c5697b8738a092');
  await client.query(await readFile(new URL('../db/bootstrap.sql', import.meta.url), 'utf8'));
  await client.query(first.toString('utf8')); await client.query(second.toString('utf8'));
  console.log(JSON.stringify({ disposableExtensionPrepared: true, postgresMajor: 17, backendCasesRepeated: 0 }));
} finally { await client.end(); }
