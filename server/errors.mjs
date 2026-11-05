export class LinkyError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'LinkyError'; this.code = code; this.status = status; }
}

const databaseErrors = Object.freeze({
  linky_invalid: ['invalid_request', 400], linky_denied: ['access_denied', 403],
  linky_closed: ['workspace_closed', 410], linky_conflict: ['conflict', 409],
  linky_scope: ['scope_denied', 403], linky_expired: ['grant_expired', 410],
  linky_revoked: ['grant_revoked', 410], linky_exhausted: ['uses_exhausted', 409],
  linky_inactive: ['link_inactive', 409], linky_immutable: ['immutable', 409],
});
export function publicError(error) {
  if (error instanceof LinkyError) return error;
  const known = error?.code === 'P0001' && Object.hasOwn(databaseErrors, error.message) && databaseErrors[error.message];
  return known ? new LinkyError(...known) : new LinkyError('service_unavailable', 503);
}
