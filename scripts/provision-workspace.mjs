import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generateCapability, hashCapability } from '../server/capabilities.mjs';
import { parseConnectionConfig } from '../server/postgres.mjs';

// Operator connection is deliberately independent of the deployed runtime.
export async function provisionWorkspace({ name, recoveryFile, connectionString, ca, allowInsecureLoopback = false }) {
  if (!connectionString || connectionString === process.env.LINKY_DATABASE_URL) throw new Error('Explicit separate operator connection required.');
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\u0000-\u001f]/u.test(name)) throw new Error('A bounded workspace name is required.');
  if (!recoveryFile) throw new Error('Explicit private recovery-file destination required.');
  const { Client } = await import('pg');
  const client = new Client(parseConnectionConfig({ connectionString, ca, allowInsecureLoopback }));
  let file;
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT current_user = 'linky_operator' AND session_user = 'linky_operator'
      AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid)
      AND pg_catalog.has_function_privilege(current_user, 'linky_private.operator_provision(uuid,jsonb)', 'EXECUTE') AS allowed
      FROM pg_catalog.pg_roles r WHERE rolname = current_user`);
    if (rows.length !== 1 || rows[0].allowed !== true) throw new Error('Operator context unavailable.');
    let recovery;
    try {
      file = await open(recoveryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      recovery = { schemaVersion: 1, workspaceId: randomUUID(), operatorId: randomUUID(), mutationKey: randomUUID(), name: name.trim(), ownerKey: generateCapability('owner') };
      await file.writeFile(JSON.stringify(recovery, null, 2) + '\n');
      await file.sync();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      file = await open(recoveryFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('Unsafe recovery file.');
      recovery = JSON.parse(await file.readFile('utf8'));
      if (recovery.schemaVersion !== 1 || recovery.name !== name.trim()
        || Object.keys(recovery).sort().join(',') !== 'mutationKey,name,operatorId,ownerKey,schemaVersion,workspaceId'
        || ![recovery.workspaceId, recovery.operatorId, recovery.mutationKey].every(x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(x))) throw new Error('Recovery file does not match this operation.');
    }
    const payload = { workspaceId: recovery.workspaceId, mutationKey: recovery.mutationKey, name: recovery.name, ownerHash: hashCapability(recovery.ownerKey, 'owner') };
    const result = await client.query('SELECT linky_private.operator_provision($1::uuid, $2::jsonb) AS result', [recovery.operatorId, JSON.stringify(payload)]);
    return result.rows[0].result;
  } finally {
    const outcomes = await Promise.allSettled([file?.close(), client.end()]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const { values } = parseArgs({ options: { name: { type: 'string' }, 'recovery-file': { type: 'string' } }, strict: true });
    const result = await provisionWorkspace({ name: values.name, recoveryFile: values['recovery-file'], connectionString: process.env.LINKY_OPERATOR_DATABASE_URL, ca: process.env.LINKY_PG_CA });
    console.log(JSON.stringify({ workspaceId: result.workspaceId, acknowledged: true, replayed: result.replayed }));
  } catch {
    console.error('Provisioning was not acknowledged. Keep the private recovery file and retry the same operation; verify the separate operator connection.');
    process.exitCode = 1;
  }
}
