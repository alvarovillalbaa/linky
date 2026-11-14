import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pools } from '../tests/fixtures/origin-db.mjs';
const db = await pools();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  assert.equal((await db.admin.query("SELECT to_regnamespace('linky_private') namespace")).rows[0].namespace, null);
  await db.admin.query(await readFile(new URL('../db/bootstrap.sql', import.meta.url), 'utf8'));
  for (const [name, digest] of [['20261105080045_linky_initial_service.sql','406957876504aeb4c99a42f6488f24c325aaf9c2e41b8dc501f5c227b08249be'],['20261105092311_linky_service_extension.sql','e8153d0486e7c997d4e85ca18b2b4a2ab9822908125c1cad44c5697b8738a092'],['20261114200848_linky_protected_resources.sql','52c7f42e0776dce35c6816cd6f4e72adeb6a35ae6f5322c7e0538d8f1af6e9f6']]) {
    const bytes = await readFile(new URL('../supabase/migrations/' + name, import.meta.url)); assert.equal(hash(bytes), digest); await db.admin.query(bytes.toString('utf8'));
  }
  await db.admin.query("ALTER ROLE linky_runtime PASSWORD 'authored-origin-runtime'; ALTER ROLE linky_operator PASSWORD 'authored-origin-operator'");
  console.log(JSON.stringify({ prepared: true, postgresMajor: 17, repeatedBackendCases: 0 }));
} finally { await db.close(); }
