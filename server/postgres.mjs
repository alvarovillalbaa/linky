import { LinkyError } from './errors.mjs';

export function parseConnectionConfig({ connectionString, ca, allowInsecureLoopback = false } = {}) {
  let url;
  try { url = new URL(connectionString); } catch { throw new LinkyError('backend_unconfigured', 503); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash
    || url.search) throw new LinkyError('backend_unconfigured', 503);
  const local = url.hostname === '127.0.0.1';
  if (allowInsecureLoopback && !(process.env.CI === 'true' && local)) throw new LinkyError('backend_unconfigured', 503);
  if (local && !allowInsecureLoopback) throw new LinkyError('backend_unconfigured', 503);
  if (ca !== undefined && (typeof ca !== 'string' || !ca.trim() || ca.length > 64 * 1024)) throw new LinkyError('backend_unconfigured', 503);
  return { connectionString, ssl: allowInsecureLoopback ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, allowExitOnIdle: true,
    statement_timeout: 5000, query_timeout: 6000, application_name: 'linky-runtime' };
}

// This closed source-owned list is not an SQL dispatcher exposed to callers.
const statements = Object.freeze({
  ownerConnect: 'SELECT linky_private.owner_connect($1::text,$2::jsonb) AS result',
  ownerRotate: 'SELECT linky_private.owner_rotate($1::text,$2::jsonb) AS result',
  ownerClose: 'SELECT linky_private.owner_close($1::text,$2::jsonb) AS result',
  ownerListLinks: 'SELECT linky_private.owner_list_links($1::text,$2::jsonb) AS result',
  ownerCreateLink: 'SELECT linky_private.owner_create_link($1::text,$2::jsonb) AS result',
  ownerReviseLink: 'SELECT linky_private.owner_revise_link($1::text,$2::jsonb) AS result',
  ownerSetLinkState: 'SELECT linky_private.owner_set_link_state($1::text,$2::jsonb) AS result',
  ownerIssueGrant: 'SELECT linky_private.owner_issue_grant($1::text,$2::jsonb) AS result',
  ownerListGrants: 'SELECT linky_private.owner_list_grants($1::text,$2::jsonb) AS result',
  ownerRevokeGrant: 'SELECT linky_private.owner_revoke_grant($1::text,$2::jsonb) AS result',
  recipientInspect: 'SELECT linky_private.recipient_inspect($1::text,$2::jsonb) AS result',
  recipientRedeem: 'SELECT linky_private.recipient_redeem($1::text,$2::jsonb) AS result',
  ownerReport: 'SELECT linky_private.owner_report($1::text,$2::jsonb) AS result',
});

export async function createPostgresRepository(options) {
  const configuration = parseConnectionConfig(options);
  let username;
  try { username = decodeURIComponent(new URL(configuration.connectionString).username); } catch { throw new LinkyError('backend_unconfigured', 503); }
  if (!/^linky_runtime(?:\.[a-z0-9]{20})?$/u.test(username)) throw new LinkyError('backend_unconfigured', 503);
  const { Pool } = await import('pg');
  const pool = new Pool(configuration);
  // An idle connection failure never prints a credential-bearing driver error.
  pool.on('error', () => {});
  const repository = { close: () => pool.end() };
  for (const [method, text] of Object.entries(statements)) repository[method] = async (digest, payload) => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const role = await client.query('SELECT current_user AS role');
      if (role.rows.length !== 1 || role.rows[0].role !== 'linky_runtime') throw new LinkyError('backend_unconfigured', 503);
      const result = await client.query({ text, values: [digest, JSON.stringify(payload)] });
      if (result.rows.length !== 1 || !Object.hasOwn(result.rows[0], 'result')) throw new LinkyError('service_unavailable', 503);
      await client.query('COMMIT');
      return result.rows[0].result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  };
  return Object.freeze(repository);
}
