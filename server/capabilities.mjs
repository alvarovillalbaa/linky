import { createHash, randomBytes } from 'node:crypto';
import { LinkyError } from './errors.mjs';

const prefixes = Object.freeze({ owner: 'lyo_', recipient: 'lyr_', ingest: 'lyi_' });
export function generateCapability(purpose) {
  if (!Object.hasOwn(prefixes, purpose)) throw new LinkyError('invalid_capability_purpose');
  return prefixes[purpose] + randomBytes(32).toString('hex');
}
export function hashCapability(token, purpose) {
  if (!Object.hasOwn(prefixes, purpose) || typeof token !== 'string'
    || !new RegExp(`^${prefixes[purpose]}[0-9a-f]{64}$`, 'u').test(token)) throw new LinkyError('invalid_credential', 401);
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function headerDigest(request, purpose) {
  const authorization = request.headers.get('authorization');
  if (!authorization) throw new LinkyError('credential_required', 401);
  if (!authorization.startsWith('Bearer ') || authorization.includes(',')) throw new LinkyError('invalid_credential', 401);
  return hashCapability(authorization.slice(7), purpose);
}
export const ownerDigest = request => headerDigest(request, 'owner');
