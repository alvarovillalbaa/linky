import { normalizeLinkDraft, buildDestination, analyzeDestination, parseBulkCsv } from './destinations.mjs';
import { el, replace, button, fieldError } from './ui.mjs';
import { requestService, ServiceError, bodyByteLength, SERVICE_BODY_LIMIT } from './server-client.mjs';

const $ = id => document.getElementById(id);
// Capture the bearer fragment before any asynchronous service work.
const recipientPath = location.pathname.startsWith('/r/');
const recipientMatch = /^\/r\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(location.pathname);
const recipientGrantId = recipientMatch?.[1].toLowerCase() ?? null;
let recipientKey = recipientGrantId && /^#lyr_[0-9a-f]{64}$/.test(location.hash) ? location.hash.slice(1) : '';
if (recipientPath) history.replaceState(null, '', location.pathname);
let configured = false, ownerKey = '', workspace = null, links = [], nextCursor = null;
let selected = null, grants = [], grantNext = null, ownerBusy = false, ownerEpoch = 0;
let pendingChange = null, grantRecovery = null, recipientBusy = false, inspected = null, redemptionKey = null;
let conversionCredentials = null, conversionNext = null, conversionRecovery = null;
let bulkJob = null, bulkSending = false, bulkStopRequested = false;
let filter = 'all';
const requests = new Set();
const fields = ['title', 'destination', 'source', 'medium', 'campaign'];
const blankDraft = () => ({ title: '', destination: '', source: '', medium: '', campaign: '' });
let draft = blankDraft(), reviewed = null, draftRevision = 0;
let bulk = null, bulkRevision = 0, fileGeneration = 0, pendingFile = null;
let confirmation = null, disposed = false;
const views = {
  links: ['Links', 'YOUR LINKS, WITH CONTEXT', ['Every link,', 'accounted for.'], 'One place to manage destinations, access and the evidence behind each interaction.'],
  access: ['Access controls', 'A DELIBERATE HANDOFF', ['Control the handoff.', 'Know the boundary.'], 'Recipient access needs authoritative decisions, explicit limits and recoverable outcomes.'],
  attribution: ['Attribution', 'FOLLOW ACTUAL EVIDENCE', ['A clear link', 'to what happened.'], 'Keep recorded redemptions separate from declared leads and sales.'],
  safety: ['Link safety', 'LOOK BEFORE YOU SHARE', ['The destination,', 'in plain sight.'], 'Review an address without confusing local checks with reputation or site safety.'],
};

function notice(text, error = false) {
  $('app-notice').hidden = false;
  $('app-notice').classList.toggle('error', error);
  $('notice-text').setAttribute('role', error ? 'alert' : 'status');
  $('notice-text').textContent = text;
}

function localMessage(id, text, error = false) {
  const node = $(id);
  node.hidden = false;
  node.className = error ? 'field-error' : 'field-help';
  node.setAttribute('role', error ? 'alert' : 'status');
  node.setAttribute('aria-live', error ? 'assertive' : 'polite');
  node.textContent = text;
}

function navigate(view, focus = true) {
  if (!Object.hasOwn(views, view) && view !== 'recipient') return;
  const recipient = view === 'recipient';
  document.body.classList.toggle('recipient-mode', recipient);
  for (const key of [...Object.keys(views), 'recipient']) $('view-' + key).hidden = key !== view;
  $('operator-heading').hidden = recipient;
  $('recipient-view').hidden = recipient;
  $('operator-view').hidden = !recipient;
  $('breadcrumb-section').textContent = recipient ? 'Recipient access' : views[view][0];
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (!recipient) {
    const [, eyebrow, lines, intro] = views[view];
    $('page-eyebrow').textContent = eyebrow;
    replace($('page-title'), document.createTextNode(lines[0]), el('br'), document.createTextNode(lines[1]));
    $('page-intro').textContent = intro;
  }
  if (!recipientPath) history.replaceState(null, '', '#' + view);
  if (focus) $('main').focus({ preventScroll: false });
}

function confirmChange(title, description, label) {
  const dialog = $('confirm-dialog');
  if (confirmation || dialog.open || disposed) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-action').textContent = label;
  dialog.returnValue = '';
  return new Promise(resolve => { confirmation = resolve; dialog.showModal(); });
}
$('confirm-dialog').addEventListener('close', () => {
  const resolve = confirmation;
  confirmation = null;
  resolve?.($('confirm-dialog').returnValue === 'confirm');
});

function hasDraft() { return fields.some(key => draft[key].length > 0); }
const hasCapability = value => typeof value === 'string' && /ly[ori]_[0-9a-f]{64}/u.test(value);
const uncertainBulk = () => Boolean(bulkJob?.pendingBatch);
const utcExpiry = value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) > Date.now();

function openComposer() {
  if (!$('composer-dialog').open) $('composer-dialog').showModal();
  $('draft-title').focus();
}

function changedDraft() {
  draftRevision++;
  reviewed = null;
  $('draft-message').hidden = true;
  renderPreview(); renderSafety();
  updateControls();
}

for (const key of fields) $('draft-' + key).addEventListener('input', event => {
  draft[key] = event.currentTarget.value;
  changedDraft();
});

function findingsList(analysis) {
  return el('ul', { className: 'finding-list', 'aria-label': 'Local address findings' }, analysis.findings.map(finding =>
    el('li', {}, el('span', { className: `finding-level ${finding.severity}` }, finding.severity), el('span', {}, finding.message))));
}

function reputationNote() {
  return el('p', { className: 'reputation-note' }, el('strong', {}, 'Reputation: unchecked. '),
    'No site content, malware provider, ownership or future destination change was checked.');
}

function renderPreview() {
  if (!reviewed) {
    replace($('draft-preview'), el('p', { className: 'eyebrow' }, 'BEFORE YOU SHARE'),
      el('div', { className: 'preview-empty' }, el('span', { className: 'empty-symbol', 'aria-hidden': true }, '↗'),
        el('h3', {}, 'The destination,', el('br'), 'in plain sight.'),
        el('p', {}, 'Review the address and campaign parameters. Changes invalidate the previous review. Nothing is saved as a shared link.')));
    return;
  }
  const { analysis, destination, title } = reviewed;
  replace($('draft-preview'), el('p', { className: 'eyebrow' }, destination ? 'REVIEWED UNSENT DESTINATION' : 'ADDRESS NEEDS ATTENTION'),
    el('h3', { className: 'preview-title' }, title || 'Untitled unsent draft'),
    destination ? el('pre', { className: 'url-preview', id: 'reviewed-url', tabindex: 0, 'aria-label': 'Reviewed destination URL' }, destination.url) : null,
    destination ? button('Copy destination URL', () => copyDestination(reviewed), 'button button-secondary') : null,
    destination?.replacedParameters.length ? el('p', { className: 'collision-note' },
      `Existing owned campaign parameters replaced or removed: ${destination.replacedParameters.join(', ')}. Review the resulting URL before sharing.`) : null,
    reviewed.error ? fieldError(reviewed.error) : null,
    findingsList(analysis), reputationNote());
}

function renderSafety() {
  if (!reviewed) {
    replace($('safety-review'), el('div', { className: 'panel-heading' }, el('h3', {}, 'Current draft review'), el('span', { className: 'subtle-tag' }, 'No third-party scanning')),
      el('div', { className: 'empty-inline' }, el('span', { className: 'empty-symbol small', 'aria-hidden': true }, '⊙'),
        el('h3', {}, 'No current destination review.'), el('p', {}, 'Review the draft address locally. Every edit invalidates its previous review; no website is fetched or rendered.')));
    return;
  }
  replace($('safety-review'), el('div', { className: 'panel-heading' }, el('h3', {}, 'Current unsent draft'), el('span', { className: 'subtle-tag' }, 'Reputation unchecked')),
    el('div', { className: 'safety-content' }, el('h3', { className: 'preview-title' }, reviewed.title || 'Untitled draft'),
      el('p', { className: 'safety-host' }, reviewed.analysis.hostname || 'Address not accepted'),
      findingsList(reviewed.analysis), reputationNote(), button('Edit this unsent draft →', openComposer)));
}

function reviewDraft() {
  let normalized, analysis;
  try {
    normalized = normalizeLinkDraft(draft);
    if (Object.values(normalized).some(hasCapability)) throw new Error('credential_in_metadata');
    analysis = analyzeDestination(normalized.destination);
  } catch {
    localMessage('draft-message', 'Check the five draft fields: a title up to 200 characters, destination up to 2,048, and campaign values up to 100 each. Your text was kept.', true);
    return;
  }
  let destination = null, error = null;
  try { destination = buildDestination(normalized); }
  catch { error = 'A nonblank title and an accepted HTTP(S) destination are required. Resolve blocked address findings before continuing.'; }
  reviewed = { revision: draftRevision, title: normalized.title, analysis, destination, error };
  renderPreview(); renderSafety();
  updateControls();
  localMessage('draft-message', destination ? 'Destination reviewed locally. No shared link was created, no website was fetched and reputation remains unchecked.'
    : 'This draft needs attention. Your inputs remain editable; no destination URL can be copied from this review.', !destination);
}

$('draft-form').addEventListener('submit', event => { event.preventDefault(); reviewDraft(); });

async function copyDestination(expected) {
  if (disposed || reviewed !== expected || draftRevision !== expected.revision || !expected.destination) return;
  const url = expected.destination.url;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(url);
    if (!disposed && reviewed === expected && draftRevision === expected.revision) localMessage('draft-message', 'Reviewed destination URL copied. This is the destination itself, not a Linky access grant or managed link.');
  } catch {
    if (!disposed && reviewed === expected && draftRevision === expected.revision) localMessage('draft-message', 'The URL could not be copied. Select and copy the reviewed URL manually. Your draft was kept.', true);
  }
}

$('clear-draft').addEventListener('click', async () => {
  const expected = draftRevision;
  if (hasDraft() && !await confirmChange('Clear the unsent draft?', 'This clears its title, destination and campaign fields. No shared link exists to delete.', 'Clear draft')) return;
  if (disposed || draftRevision !== expected) { localMessage('draft-message', 'The draft changed. Nothing was cleared.'); return; }
  draft = blankDraft(); $('draft-form').reset(); changedDraft(); $('draft-title').focus();
  localMessage('draft-message', 'Unsent draft cleared. No shared record was changed.');
});

for (const id of ['open-composer', 'empty-draft', 'safety-draft']) $(id).addEventListener('click', openComposer);
$('close-composer').addEventListener('click', () => $('composer-dialog').close());

function cancelFileRead() {
  fileGeneration++;
  pendingFile = null;
  $('bulk-read-status').hidden = true;
}

function bulkChanged() {
  if (bulkJob) return;
  bulkRevision++;
  cancelFileRead();
  bulk = null;
  $('bulk-message').hidden = true;
  replace($('bulk-result'));
  renderBulkProgress(); updateControls();
}

$('bulk-source').addEventListener('input', bulkChanged);

function reviewBulk() {
  if (bulkJob) { localMessage('bulk-message', 'Keep the current batch recovery or explicitly clear this review before replacing it.', true); return; }
  cancelFileRead();
  try {
    const parsed = parseBulkCsv($('bulk-source').value);
    const rows = parsed.rows.map(row => row.draft && Object.values(row.draft).some(hasCapability)
      ? { ...row, destination: null, errors: [...row.errors, { code: 'credential_in_metadata', message: 'Linky credentials cannot be stored as ordinary link metadata.' }] } : row);
    const validCount = rows.filter(row => row.destination && !row.errors.length).length;
    bulk = { ...parsed, rows, validCount, invalidCount: rows.length - validCount };
    renderBulk();
    localMessage('bulk-message', `${bulk.rows.length} data rows reviewed: ${bulk.validCount} valid for destination review, ${bulk.invalidCount} needing correction. No records were imported.`);
    updateControls();
  } catch {
    bulk = null; replace($('bulk-result'));
    localMessage('bulk-message', 'CSV could not be reviewed. Use the exact title,destination,source,medium,campaign header, valid CSV quoting, up to 500 rows and 1 MiB of UTF-8. Your source text was kept.', true);
    updateControls();
  }
}

function renderBulk() {
  if (!bulk) { replace($('bulk-result')); return; }
  const expected = bulk;
  const rows = bulk.rows.map(row => el('tr', { 'data-source-row': row.row },
    el('th', { scope: 'row' }, `${row.row} / ${row.line}`), el('td', {}, row.draft?.title || 'No accepted title'),
    el('td', {}, row.errors.length ? el('ul', { className: 'row-errors' }, row.errors.map(error => el('li', {}, error.message)))
      : el('p', { className: 'row-url' }, row.destination?.url ?? 'No accepted destination')),
    el('td', {}, row.destination && !row.errors.length ? button('Review as draft →', () => useBulkRow(expected, row)) : 'Correct source row'),
    el('td', { className: 'bulk-row-status', 'data-row-status': bulkJob?.rows.find(item => item.sourceRow === row.row)?.status ?? (row.errors.length ? 'invalid' : 'unattempted') }, bulkRowOutcome(row.row))));
  const table = el('table', { className: 'bulk-table' },
    el('caption', { className: 'visually-hidden' }, bulkJob ? 'Reviewed CSV rows and acknowledged service outcomes.' : 'Supplied CSV rows for review only. No links have been created.'),
    el('thead', {}, el('tr', {}, ['ROW / LINE', 'TITLE', 'DESTINATION / ISSUE', 'REVIEW', 'SERVICE OUTCOME'].map(label => el('th', { scope: 'col' }, label)))),
    el('tbody', {}, ...rows));
  replace($('bulk-result'), el('div', { className: 'bulk-counts' },
    el('span', {}, el('strong', {}, bulk.validCount), 'valid for review'), el('span', {}, el('strong', {}, bulk.invalidCount), 'need correction')),
    el('div', { className: 'table-frame' }, el('div', { className: 'table-scroll', tabindex: 0, role: 'region', 'aria-label': 'CSV row review table' },
      table)));
}

async function useBulkRow(expected, row) {
  if (bulk !== expected || !row.draft || !row.destination || row.errors.length) return;
  const expectedDraft = draftRevision, expectedBulk = bulkRevision;
  if (hasDraft() && !await confirmChange('Replace the unsent draft?', 'This copies the selected CSV row into the single draft composer. It does not create or update a shared link.', 'Use this row')) return;
  if (disposed || bulk !== expected || draftRevision !== expectedDraft || bulkRevision !== expectedBulk) {
    localMessage('bulk-message', 'The draft or CSV changed. Nothing was replaced.'); return;
  }
  draft = { ...row.draft };
  for (const key of fields) $('draft-' + key).value = draft[key];
  changedDraft();
  $('bulk-dialog').close(); openComposer(); reviewDraft();
}

$('bulk-form').addEventListener('submit', event => { event.preventDefault(); reviewBulk(); });
$('choose-csv').addEventListener('click', () => { cancelFileRead(); $('csv-file').click(); });
$('csv-file').addEventListener('change', event => {
  const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
  if (!file) return;
  void importCsv(file);
});

async function importCsv(file) {
  if (bulkJob) return;
  cancelFileRead();
  const operation = { generation: fileGeneration, revision: bulkRevision };
  pendingFile = operation;
  const owns = () => !disposed && pendingFile === operation && operation.generation === fileGeneration && operation.revision === bulkRevision;
  if ($('bulk-source').value.length && !await confirmChange('Replace the current CSV source?', 'The current CSV text and its review will be replaced. Your separate unsent link draft is kept.', 'Read selected file')) {
    if (owns()) cancelFileRead();
    return;
  }
  if (!owns()) return;
  $('bulk-read-status').hidden = false; $('bulk-read-status').textContent = 'Reading the selected UTF-8 CSV file…';
  try {
    if (!/\.csv$/i.test(file.name) || file.size > 1024 * 1024) throw new Error('invalid_csv_file');
    const data = await file.arrayBuffer();
    if (!owns()) return;
    if (data.byteLength > 1024 * 1024) throw new Error('invalid_csv_file');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (!owns()) return;
    $('bulk-source').value = text; bulkRevision++; cancelFileRead(); reviewBulk();
  } catch {
    if (!owns()) return;
    cancelFileRead();
    localMessage('bulk-message', 'The file could not be read. Choose a locally available .csv file with valid UTF-8, up to 1 MiB. The previous CSV source and draft were kept.', true);
  }
}

$('clear-bulk').addEventListener('click', async () => {
  if (bulkSending) return;
  const expected = bulkRevision;
  if ($('bulk-source').value.length && !await confirmChange('Clear the CSV source and review?', bulkJob ? 'This clears all row recovery identities. Any committed links stay in the service; an unconfirmed reply may already have committed. Keep this tab open to recover it first.' : 'This clears only the local CSV text and its review. Your unsent link draft is kept.', 'Clear CSV')) return;
  if (disposed || expected !== bulkRevision) { localMessage('bulk-message', 'The CSV changed. Nothing was cleared.'); return; }
  bulkJob = null; $('bulk-source').value = ''; bulkChanged();
  localMessage('bulk-message', 'CSV source and recovery cleared. Any already committed links remain in the service.'); $('bulk-source').focus();
});
$('open-bulk').addEventListener('click', () => { if (!$('bulk-dialog').open) $('bulk-dialog').showModal(); $('bulk-source').focus(); });
$('close-bulk').addEventListener('click', () => $('bulk-dialog').close());
$('bulk-dialog').addEventListener('close', () => { cancelFileRead(); if (bulkSending) bulkStopRequested = true; });

for (const item of document.querySelectorAll('[data-view]')) item.addEventListener('click', () => navigate(item.dataset.view));
for (const id of ['recipient-view', 'access-recipient']) $(id)?.addEventListener('click', () => navigate('recipient'));
$('operator-view').addEventListener('click', () => { if (recipientPath) location.assign('/'); else navigate('links'); });
$('dismiss-notice').addEventListener('click', () => { $('app-notice').hidden = true; });
$('open-about').addEventListener('click', () => $('about-dialog').showModal());

for (const tab of document.querySelectorAll('[data-filter]')) tab.addEventListener('click', () => {
  if (ownerBusy || pendingChange) return;
  for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === tab));
  filter = tab.dataset.filter;
  if (workspace) void refreshLinks();
});
$('registry-search').addEventListener('input', () => {
  $('registry-status').textContent = 'Choose Refresh workspace to search service records.';
});

window.addEventListener('hashchange', () => { if (!recipientPath) navigate(location.hash.slice(1)); });
window.addEventListener('beforeunload', event => {
  if (hasDraft() || $('bulk-source').value.length || pendingChange || grantRecovery || conversionRecovery || bulkJob) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', event => {
  cancelFileRead();
  clearCredentials();
  if (!event.persisted) { disposed = true; confirmation?.(false); confirmation = null; }
});

installServiceUI();
renderPreview(); renderSafety();
const initialView = location.hash.slice(1);
navigate(recipientPath ? 'recipient' : Object.hasOwn(views, initialView) || initialView === 'recipient' ? initialView : 'links', false);
void probeService();

async function api(path, body, credential = ownerKey, method = 'POST') {
  const controller = new AbortController(); requests.add(controller);
  try { return await requestService('/api/v1' + path, { body, credential, method, signal: controller.signal }); }
  finally { requests.delete(controller); }
}

function messageFor(error) {
  const messages = {
    configuration_required: 'The shared service is not configured. No shared record was created.',
    unauthorized: 'The credential was not accepted for this action.',
    credential_invalid: 'The credential was not accepted for this action.',
    forbidden: 'This credential does not authorize that action.',
    conflict: 'The stored record changed. Refresh before preparing a new change.',
    version_conflict: 'The stored record changed. Refresh before preparing a new change.',
    grant_expired: 'This grant has expired.', grant_revoked: 'This grant was revoked.',
    grant_exhausted: 'No uses remain for this grant.', link_paused: 'This link is paused.',
    invalid_credential: 'The credential was not accepted for this action.', access_denied: 'Access was denied for this credential.',
    scope_denied: 'This credential does not authorize that record.', workspace_closed: 'This workspace is closed.',
    uses_exhausted: 'No uses remain for this grant.', link_inactive: 'This link is paused or blocked.',
    backend_unconfigured: 'The shared service is not configured. Shared actions are unavailable.',
    invalid_request: 'Check the reviewed fields and current record version. This request was refused.',
  };
  return messages[error?.code] ?? 'The service could not confirm this action. No result is assumed.';
}

function installServiceUI() {
  const connectForm = el('form', { id: 'owner-form' }, el('label', { for: 'owner-key' }, 'Owner credential'),
    el('input', { id: 'owner-key', type: 'password', maxlength: 68, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true }),
    el('div', { className: 'form-actions' }, el('button', { id: 'owner-connect', className: 'button', type: 'submit' }, 'Connect workspace'),
      button('Disconnect', disconnect, 'button button-secondary')));
  connectForm.querySelector('button[type="button"]').id = 'owner-disconnect';
  const panel = el('section', { id: 'owner-connection', className: 'panel owner-connection', 'aria-labelledby': 'owner-title' },
    el('div', {}, el('p', { className: 'eyebrow' }, 'YOUR WORKSPACE KEY'), el('h2', { id: 'owner-title' }, 'Pick up where you left off.'),
      el('p', { className: 'muted' }, 'Your owner credential stays in tab memory. Linky does not store it; reconnect after reload.')),
    connectForm, el('p', { id: 'owner-state', className: 'field-help', role: 'status' }, 'Use an operator-provisioned owner credential.'));
  $('service-notice').after(panel);
  connectForm.addEventListener('submit', connectOwner);
  $('service-title').textContent = 'Checking shared service';
  $('service-reason').textContent = 'No owner records or recipient destination have been loaded.';
  $('service-notice').querySelector('.code-tag').id = 'service-code';
  const blocked = document.querySelector('[data-filter="revoked"]'); blocked.dataset.filter = 'blocked'; blocked.textContent = 'Blocked';
  document.querySelector('.registry-table tbody').id = 'registry-body';
  replace(document.querySelector('.table-footer > div'),
    button('Refresh workspace', () => refreshLinks(), 'quiet'), button('Next page', () => refreshLinks(nextCursor), 'quiet'));
  document.querySelector('.table-footer button').id = 'refresh-workspace';
  document.querySelectorAll('.table-footer button')[1].id = 'next-links';
  const recovery = el('section', { id: 'mutation-recovery', className: 'panel mutation-recovery', hidden: true },
    el('h3', {}, 'Keep this tab open.'), el('p', { id: 'mutation-recovery-message' }),
    el('button', { id: 'mutation-retry', className: 'button', type: 'button', onClick: runPendingChange }, 'Retry the same change'));
  $('owner-connection').after(recovery);
  recovery.after(el('section', { id: 'grant-recovery', className: 'panel' }));
  $('grant-recovery').after(el('section', { id: 'conversion-recovery', className: 'panel' }));
  replace($('view-access'), el('div', { className: 'section-topline' }, el('div', {}, el('p', { className: 'eyebrow' }, 'CONTROL DISCLOSURE'),
    el('h2', {}, 'Make the handoff deliberate.'), el('p', { className: 'muted' }, 'Select a saved link to revise it, issue a finite grant, pause access or revoke a grant.'))),
    el('section', { id: 'link-detail', className: 'panel' }),
    el('p', { className: 'boundary-note' }, 'An ordinary URL already learned remains usable outside Linky. Stronger protection requires enforcement at the destination.'));
  replace($('view-attribution'), el('div', { className: 'section-topline' }, el('div', {}, el('p', { className: 'eyebrow' }, 'EVIDENCE, NOT ASSUMPTIONS'),
    el('h2', {}, 'Follow recorded evidence.'), el('p', { className: 'muted' }, 'Committed redemptions and authenticated lead/sale declarations have separate, bounded cohorts. Declarations are not verified purchases.')),
    el('div', { className: 'form-actions' }, el('button', { id: 'load-attribution-report', className: 'button', type: 'button', onClick: loadAttributionReport }, 'Load full attribution report'),
      el('button', { id: 'load-report', className: 'button button-secondary', type: 'button', onClick: loadReport }, 'Redemptions only'))),
    el('section', { id: 'report-content', className: 'panel' }, el('div', { className: 'empty-inline' }, el('h3', {}, 'No report requested.'), el('p', {}, 'No count is inferred before a service response.'))));
  const card = $('view-recipient').querySelector('.recipient-card');
  replace(card, el('img', { src: '/icon.svg', alt: '', width: 44, height: 44 }), el('p', { className: 'eyebrow' }, 'A DELIBERATE HANDOFF'),
    el('h1', {}, 'Look first.', el('br'), 'Open by choice.'), el('p', { className: 'recipient-intro' }, 'Loading this page does not spend a use or reveal the destination URL.'),
    el('div', { className: 'recipient-state' }, el('div', {}, el('h2', { id: 'recipient-status' }, 'Not inspected'),
      el('p', { id: 'recipient-message' }, recipientKey ? 'The grant credential is held only in this tab. Choose Inspect access.' : 'Reopen the original grant link. Reloading requires its original credential again.'))),
    el('div', { className: 'recipient-facts' }, ...[['Destination hostname', 'recipient-host'], ['Expiry (UTC)', 'recipient-expiry'], ['Remaining uses', 'recipient-usage']].map(([label, id]) =>
      el('div', {}, el('span', {}, label), el('strong', { id }, 'Not checked')))),
    el('div', { className: 'recipient-actions' }, el('button', { id: 'recipient-inspect', type: 'button', className: 'button button-secondary', onClick: inspectGrant }, 'Inspect access'),
      el('button', { id: 'recipient-redeem', type: 'button', className: 'button', onClick: redeemGrant }, 'Redeem access')),
    el('div', { id: 'recipient-result', hidden: true }), el('p', { className: 'field-help' }, 'Inspect first, then explicitly redeem. An uncertain reply is retried with the same redemption identity. Choose Open destination separately after confirmation.'));
  $('create-disabled-reason').nextElementSibling.id = 'create-shared';
  $('create-shared').addEventListener('click', createLink);
  const bulkSave = $('bulk-disabled-reason').nextElementSibling;
  bulkSave.id = 'bulk-save-reviewed'; bulkSave.textContent = 'Save valid reviewed rows'; bulkSave.addEventListener('click', prepareBulkSave);
  $('bulk-disabled-reason').textContent = 'Only valid reviewed rows are saved after confirmation. Invalid rows remain visible. Each request is bounded to 50 rows and 32 KiB.';
  $('bulk-result').before(el('section', { id: 'bulk-progress-panel', className: 'bulk-progress-panel', hidden: true },
    el('h3', {}, 'Persistent import progress'), el('p', { id: 'bulk-progress', role: 'status', 'aria-live': 'polite' }),
    el('div', { className: 'form-actions' }, el('button', { id: 'bulk-resume', className: 'button', type: 'button', onClick: () => runBulk() }, 'Resume remaining rows'),
      el('button', { id: 'bulk-retry', className: 'button', type: 'button', onClick: () => runBulk(true) }, 'Retry exact unconfirmed batch'),
      el('button', { id: 'bulk-stop', className: 'button button-secondary', type: 'button', onClick: () => { bulkStopRequested = true; renderBulkProgress(); } }, 'Stop after this batch'))));
  renderRegistry(); renderSelected(); updateControls();
}

function updateControls() {
  if (!$('owner-connect')) return;
  const ready = configured && workspace && ownerKey;
  const locked = ownerBusy || Boolean(pendingChange) || uncertainBulk();
  $('owner-connect').disabled = !configured || ownerBusy || Boolean(workspace);
  $('owner-disconnect').disabled = !ownerKey && !workspace;
  $('owner-key').disabled = ownerBusy || Boolean(workspace);
  $('refresh-workspace').disabled = !ready || locked;
  $('next-links').disabled = !ready || locked || !nextCursor;
  $('load-report').disabled = !ready || locked;
  $('load-attribution-report').disabled = !ready || locked;
  for (const control of $('registry-body').querySelectorAll('button')) control.disabled = !ready || locked;
  $('create-shared').disabled = !ready || locked || !reviewed?.destination || reviewed.revision !== draftRevision;
  $('create-disabled-reason').textContent = ready ? 'Only the current reviewed draft is saved. No destination website is fetched.' : 'Connect the shared service and review the current draft before saving.';
  $('mutation-recovery').hidden = !pendingChange;
  if (pendingChange) $('mutation-recovery-message').textContent = `${pendingChange.label}: ${pendingChange.message ?? 'Awaiting a committed acknowledgment.'} Retry keeps the exact same request and identifiers.`;
  $('mutation-retry').disabled = ownerBusy || !ready;
  for (const control of $('link-detail').querySelectorAll('button,input')) control.disabled = !ready || locked;
  if ($('grant-share')) $('grant-share').disabled = false;
  if ($('copy-grant')) $('copy-grant').disabled = ownerBusy || !grantRecovery?.confirmed;
  if ($('save-revision')) $('save-revision').disabled = !ready || locked || !$('save-revision').dataset.reviewed;
  if ($('copy-conversion-key')) $('copy-conversion-key').disabled = ownerBusy || !conversionRecovery?.confirmed;
  $('bulk-save-reviewed').disabled = !ready || locked || Boolean(bulkJob) || !bulk?.validCount;
  $('bulk-source').disabled = Boolean(bulkJob);
  $('choose-csv').disabled = Boolean(bulkJob);
  $('bulk-form').querySelector('button[type="submit"]').disabled = Boolean(bulkJob);
  $('clear-bulk').disabled = bulkSending;
  $('bulk-progress-panel').hidden = !bulkJob;
  $('bulk-stop').hidden = !bulkSending; $('bulk-stop').disabled = bulkStopRequested;
  $('bulk-retry').hidden = !bulkJob?.pendingBatch; $('bulk-retry').disabled = !ready || ownerBusy || Boolean(pendingChange);
  $('bulk-resume').hidden = !bulkJob || bulkJob.nextIndex >= bulkJob.batches.length || Boolean(bulkJob.pendingBatch);
  $('bulk-resume').disabled = !ready || ownerBusy || Boolean(pendingChange);
  $('recipient-inspect').disabled = !configured || !recipientKey || recipientBusy;
  $('recipient-redeem').disabled = !configured || !recipientKey || !inspected || recipientBusy;
  $('owner-connection').setAttribute('aria-busy', String(ownerBusy));
}

async function probeService() {
  try {
    const value = await api('/status', undefined, '', 'GET');
    if (disposed) return;
    configured = value?.service === 'linky' && value.configuration === 'present';
    $('service-title').textContent = configured ? 'Service configuration present' : 'Shared service unavailable';
    $('service-reason').textContent = configured ? 'Database access is checked by each action. Connect an owner credential or inspect an original recipient link.' : 'Shared actions are unavailable. Draft and CSV review remain local; no shared records are assumed.';
  } catch {
    if (disposed) return;
    configured = false; $('service-title').textContent = 'Shared service unavailable';
    $('service-reason').textContent = 'The service did not return its configuration status. No shared record or access decision is assumed.';
  }
  $('service-notice').dataset.status = configured ? 'configuration_present' : 'configuration_required';
  if (!configured && recipientPath) { $('recipient-status').textContent = 'Shared service unavailable'; $('recipient-message').textContent = $('service-reason').textContent; }
  $('service-code').textContent = configured ? 'configuration_present' : 'configuration_required'; updateControls();
}

function clearCredentials() {
  ownerEpoch++; for (const controller of requests) controller.abort();
  cancelFileRead();
  ownerKey = ''; recipientKey = ''; workspace = null; links = []; selected = null; grants = [];
  conversionCredentials = null; conversionNext = null; conversionRecovery = null;
  bulkJob = null; bulkSending = false; bulkStopRequested = false; bulk = null; bulkRevision++;
  $('bulk-source').value = ''; replace($('bulk-result')); renderBulkProgress();
  nextCursor = null; grantNext = null; pendingChange = null; grantRecovery = null; inspected = null; redemptionKey = null; ownerBusy = false;
  $('owner-key').value = ''; replace($('recipient-result')); $('recipient-result').hidden = true;
  $('owner-state').textContent = 'Disconnected. Reopen the original credential to connect again.';
  $('workspace-label').textContent = 'Connect your owner workspace'; $('sidebar-status').textContent = 'No owner workspace connected';
  replace($('report-content'), el('div', { className: 'empty-inline' }, el('h3', {}, 'No report requested.')));
  $('recipient-status').textContent = 'Credential cleared'; $('recipient-message').textContent = 'Reopen the original grant link to continue.';
  for (const id of ['recipient-host', 'recipient-expiry', 'recipient-usage']) $(id).textContent = 'Not checked';
  renderRegistry(); renderSelected(); renderShareRecovery(); renderConversionRecovery(); updateControls();
}

async function disconnect() {
  if ((pendingChange || grantRecovery || conversionRecovery || bulkJob || $('bulk-source').value) && !await confirmChange('Disconnect and clear private recovery?', 'Keys, CSV source and unconfirmed row identities exist only in this tab. Disconnecting clears them; it cannot undo a committed service action. Recover an uncertain reply first.', 'Disconnect')) return;
  clearCredentials();
}

async function connectOwner(event) {
  event.preventDefault(); if (!configured || ownerBusy || workspace) return;
  const key = $('owner-key').value.trim(); $('owner-key').value = '';
  if (!/^lyo_[0-9a-f]{64}$/.test(key)) { notice('Use the original owner credential provided by your operator.', true); return; }
  const epoch = ++ownerEpoch; ownerKey = key; ownerBusy = true; updateControls();
  try {
    const result = await api('/owner/connect', {});
    if (disposed || epoch !== ownerEpoch) return;
    if (!result?.workspace?.id || typeof result.workspace.name !== 'string') throw new ServiceError('response_invalid');
    workspace = result.workspace; $('owner-state').textContent = `Connected to ${workspace.name}. Credential stays in this tab.`;
    $('workspace-label').textContent = workspace.name; $('sidebar-status').textContent = 'Owner workspace connected';
    await loadLinks();
  } catch (error) {
    if (epoch === ownerEpoch && !disposed) {
      if (!workspace) ownerKey = '';
      notice(messageFor(error), true);
    }
  } finally { if (epoch === ownerEpoch) { ownerBusy = false; updateControls(); } }
}

async function loadLinks(after = null) {
  const epoch = ownerEpoch, heldWorkspace = workspace;
  const result = await api('/links/list', { workspaceId: workspace.id, limit: 50, after, state: filter, search: $('registry-search').value.trim() });
  if (disposed || epoch !== ownerEpoch || workspace !== heldWorkspace) return;
  if (!Array.isArray(result?.links) || result.links.length > 50) throw new ServiceError('response_invalid');
  links = result.links; nextCursor = result.nextCursor ?? null;
  if (selected) selected = links.find(row => row.id === selected.id) ?? null;
  renderRegistry();
}

async function refreshLinks(after = null) {
  if (!workspace || ownerBusy || pendingChange || uncertainBulk()) return;
  const epoch = ownerEpoch; ownerBusy = true; updateControls();
  try { await loadLinks(after); if (selected) await loadGrants(); renderSelected(); }
  catch (error) { if (epoch === ownerEpoch) notice(messageFor(error), true); }
  finally { if (epoch === ownerEpoch) { ownerBusy = false; updateControls(); } }
}

function renderRegistry() {
  const body = $('registry-body'); if (!body) return;
  if (!workspace || !links.length) {
    replace(body, el('tr', {}, el('td', { colspan: 5, className: 'registry-empty' }, el('h2', {}, workspace ? 'No links in this page.' : 'Connect your workspace.'),
      el('p', {}, workspace ? 'The service returned no matching records for this bounded page.' : 'No owner records are loaded before the service accepts your credential.'))));
  } else replace(body, ...links.map(row => el('tr', {}, el('td', {}, el('strong', {}, row.label), el('p', { className: 'row-url' }, row.destination)),
    el('td', {}, 'Finite grants'), el('td', {}, row.campaign?.campaign || '—'), el('td', {}, row.state),
    el('td', {}, button('Manage ' + row.label, () => selectLink(row), 'quiet')))));
  $('registry-status').textContent = workspace ? `${links.length} records in this service page${nextCursor ? ' · more available' : ''}` : 'No shared records loaded';
  updateControls();
}

async function selectLink(row) {
  if (!workspace || ownerBusy || pendingChange || uncertainBulk()) return;
  if ((grantRecovery || conversionRecovery) && selected?.id !== row.id && !await confirmChange('Leave private recovery?', 'Copy private keys first. They cannot be recovered from the server.', 'Leave share')) return;
  const epoch = ownerEpoch; selected = row; grants = []; grantRecovery = null; conversionCredentials = null; conversionRecovery = null; ownerBusy = true;
  renderShareRecovery(); renderConversionRecovery();
  navigate('access'); renderSelected(); updateControls();
  try { await loadGrants(); if (epoch === ownerEpoch) renderSelected(); }
  catch (error) { if (epoch === ownerEpoch) notice(messageFor(error), true); }
  finally { if (epoch === ownerEpoch) { ownerBusy = false; updateControls(); } }
}

async function loadGrants() {
  const held = selected, epoch = ownerEpoch;
  if (!held) return;
  const result = await api('/grants/list', { workspaceId: workspace.id, linkId: held.id, limit: 50, after: null });
  if (epoch !== ownerEpoch || selected !== held || disposed) return;
  if (!Array.isArray(result?.grants) || result.grants.length > 50) throw new ServiceError('response_invalid');
  grants = result.grants; grantNext = result.nextCursor ?? null;
  await loadConversionCredentials(held, epoch);
}

function createLink() {
  if (!workspace || ownerBusy || pendingChange || !reviewed?.destination || reviewed.revision !== draftRevision) return;
  const linkId = crypto.randomUUID();
  queueChange('Create shared link', '/links/create', { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId,
    revisionId: crypto.randomUUID(), slug: 'ly-' + linkId, draft: { ...reviewed.destination.draft } });
}

function queueChange(label, path, body) {
  if (!workspace || ownerBusy || pendingChange || uncertainBulk()) return;
  pendingChange = { label, path, body: structuredClone(body), epoch: ownerEpoch };
  void runPendingChange();
}

async function runPendingChange() {
  const held = pendingChange;
  if (!held || ownerBusy || !workspace || held.epoch !== ownerEpoch) return;
  const epoch = ownerEpoch; ownerBusy = true; updateControls();
  try {
    const acknowledgment = await api(held.path, held.body);
    if (disposed || epoch !== ownerEpoch || pendingChange !== held) return;
    if (!acknowledgment || acknowledgment.linkId !== held.body.linkId || acknowledgment.workspaceId !== held.body.workspaceId
      || acknowledgment.mutationKey !== held.body.mutationKey || !Number.isSafeInteger(acknowledgment.version) || acknowledgment.version < 1
      || typeof acknowledgment.replayed !== 'boolean' || (held.body.state && acknowledgment.state !== held.body.state)
      || (held.body.grantId && acknowledgment.grantId !== held.body.grantId)
      || (held.body.credentialId && acknowledgment.credentialId !== held.body.credentialId)
      || (held.body.revisionId && acknowledgment.revisionId !== held.body.revisionId)) throw new ServiceError('response_invalid', { uncertain: true });
    if (grantRecovery && held.path === '/grants/issue') grantRecovery.confirmed = true;
    if (conversionRecovery && held.path === '/conversion-credentials/issue') conversionRecovery.confirmed = true;
    renderShareRecovery(); renderConversionRecovery();
    pendingChange = null; notice(`${held.label} confirmed by the service.`);
    if ($('composer-dialog').open && held.path === '/links/create') $('composer-dialog').close();
    await loadLinks();
    if (!selected) selected = links.find(row => row.id === held.body.linkId) ?? null;
    if (selected) await loadGrants();
    renderSelected();
  } catch (error) {
    if (epoch === ownerEpoch && !disposed) {
      if (pendingChange === held) held.message = messageFor(error) + (error?.uncertain ? ' The reply is uncertain; keep this tab open.' : ' The identical request is retained.');
      notice(pendingChange === held ? messageFor(error) : 'The change was committed, but the refreshed list could not be loaded. Use Refresh workspace; do not create a replacement change.', true);
      renderShareRecovery();
      renderConversionRecovery();
    }
  } finally { if (epoch === ownerEpoch) { ownerBusy = false; updateControls(); } }
}

function renderSelected() {
  const node = $('link-detail'); if (!node) return;
  if (!selected || !workspace) { replace(node, el('div', { className: 'empty-inline' }, el('h3', {}, 'Select a saved link.'), el('p', {}, 'Choose Manage in the shared registry.'))); return; }
  const held = selected;
  const pause = button(held.state === 'active' ? 'Pause link' : 'Activate link', async () => {
    if (selected !== held || ownerBusy || pendingChange) return;
    if (!await confirmChange(held.state === 'active' ? 'Pause this link?' : 'Activate this link?', 'This changes future authorizations. A destination already disclosed cannot be recalled.', 'Confirm state')) return;
    if (selected !== held || ownerBusy || pendingChange) return;
    queueChange('Change link state', '/links/state', { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId: held.id, expectedVersion: held.version, state: held.state === 'active' ? 'paused' : 'active' });
  }, 'button button-secondary'); pause.id = 'link-state';
  const revision = el('form', { id: 'revision-form', className: 'service-form' }, el('h3', {}, 'New immutable destination revision'));
  const names = { title: 'Revision title', destination: 'Revision destination URL', source: 'Revision source', medium: 'Revision medium', campaign: 'Revision campaign' };
  for (const key of fields) {
    const input = el('input', { id: 'revision-' + key, maxlength: key === 'destination' ? 2048 : key === 'title' ? 200 : 100, required: ['title', 'destination'].includes(key) });
    input.value = key === 'title' ? held.label : key === 'destination' ? held.destination : held.campaign?.[key] ?? '';
    revision.append(el('label', { for: input.id }, names[key]), input);
  }
  revision.append(el('button', { className: 'button button-secondary', type: 'submit' }, 'Review revision'),
    el('p', { id: 'revision-review', className: 'field-help', role: 'status' }), el('button', { id: 'save-revision', className: 'button', type: 'button', disabled: true }, 'Save new revision'));
  let revisionDraft = null;
  revision.addEventListener('input', () => { revisionDraft = null; delete $('save-revision').dataset.reviewed; $('save-revision').disabled = true; $('revision-review').textContent = 'Changed. Review this revision again.'; });
  revision.addEventListener('submit', event => {
    event.preventDefault();
    try {
      revisionDraft = buildDestination(Object.fromEntries(fields.map(key => [key, $('revision-' + key).value]))).draft;
      if (Object.values(revisionDraft).some(hasCapability)) throw new Error('credential_in_metadata');
      $('revision-review').textContent = buildDestination(revisionDraft).url + ' · Reputation unchecked. Existing grants keep their previous revision.';
      $('save-revision').dataset.reviewed = 'true'; updateControls();
    } catch { revisionDraft = null; delete $('save-revision').dataset.reviewed; $('save-revision').disabled = true; $('revision-review').textContent = 'Use a title and an accepted HTTP(S) destination. Inputs were kept.'; }
  });
  revision.querySelector('#save-revision').addEventListener('click', () => {
    if (!revisionDraft || selected !== held) return;
    queueChange('Save destination revision', '/links/revise', { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId: held.id, revisionId: crypto.randomUUID(), expectedVersion: held.version, draft: { ...revisionDraft } });
  });
  const grantForm = el('form', { id: 'grant-form', className: 'service-form' }, el('h3', {}, 'Issue one finite recipient grant'),
    el('label', { for: 'grant-label' }, 'Grant label'), el('input', { id: 'grant-label', maxlength: 160, required: true }),
    el('label', { for: 'grant-uses' }, 'Maximum uses'), el('input', { id: 'grant-uses', type: 'number', min: 1, max: 1000000, step: 1, value: 1, required: true }),
    el('label', { for: 'grant-expiry' }, 'Expires at (UTC)'), el('input', { id: 'grant-expiry', type: 'text', maxlength: 24, required: true }),
    el('p', { className: 'field-help' }, 'An explicit UTC instant, for example YYYY-MM-DDTHH:mm:ss.sssZ. The service enforces expiry.'),
    el('button', { className: 'button', type: 'submit' }, 'Issue recipient grant'), el('p', { id: 'grant-message', className: 'field-help', role: 'status' }));
  grantForm.querySelector('#grant-expiry').value = new Date(Date.now() + 86_400_000).toISOString();
  grantForm.addEventListener('submit', event => {
    event.preventDefault(); if (selected !== held || ownerBusy || pendingChange) return;
    if (grantRecovery) { localMessage('grant-message', 'Keep or copy the current private share before choosing New grant.', true); return; }
    const label = $('grant-label').value.trim(), maxUses = Number($('grant-uses').value), expiresAt = $('grant-expiry').value.trim();
    if (!label || hasCapability(label) || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000000 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expiresAt)
      || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt || Date.parse(expiresAt) <= Date.now()) {
      localMessage('grant-message', 'Enter a label, a positive finite use limit and a future canonical UTC expiry.', true); return;
    }
    const random = crypto.getRandomValues(new Uint8Array(32));
    const secret = 'lyr_' + Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
    const body = { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId: held.id, revisionId: held.currentRevisionId,
      expectedVersion: held.version, grantId: crypto.randomUUID(), recipientKey: secret, label, maxUses, expiresAt };
    grantRecovery = { body, confirmed: false }; renderShareRecovery(); queueChange('Issue recipient grant', '/grants/issue', body);
  });
  replace(node, el('div', { className: 'panel-heading' }, el('div', {}, el('h3', {}, held.label), el('p', { className: 'muted' }, `${held.state} · version ${held.version}`)), pause),
    el('p', { className: 'saved-destination' }, held.destination), el('div', { className: 'service-columns' }, revision, grantForm),
    el('section', { className: 'grant-list', 'aria-label': 'Recipient grants' }, el('h3', {}, 'Recipient grants'),
      el('p', { className: 'field-help' }, `${grants.length} records in this bounded page${grantNext ? '; more records exist' : ''}. Keys are never returned by the service.`),
      ...grants.map(grant => el('article', { className: 'grant-row' }, el('div', {}, el('strong', {}, grant.label),
        el('p', {}, `${grant.usedCount}/${grant.maxUses} uses · expires ${grant.expiresAt} · ${grant.revokedAt ? 'revoked' : 'not revoked'}`), el('code', {}, grant.id)),
      grant.revokedAt ? null : button('Revoke ' + grant.label, async () => {
        if (selected !== held || ownerBusy || pendingChange || !await confirmChange('Revoke this recipient grant?', 'Further inspection and redemption will be denied, including replay of a receipt. A URL already learned cannot be recalled.', 'Revoke grant')) return;
        if (selected !== held || ownerBusy || pendingChange) return;
        queueChange('Revoke recipient grant', '/grants/revoke', { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId: held.id, grantId: grant.id, expectedVersion: held.version });
      }, 'button button-secondary')))));
  renderConversionTools(); renderShareRecovery(); renderConversionRecovery(); updateControls();
}

function renderShareRecovery() {
  const node = $('grant-recovery'); if (!node) return;
  if (!grantRecovery) { replace(node); return; }
  const held = grantRecovery; const url = new URL('/r/' + held.body.grantId, location.origin); url.hash = held.body.recipientKey;
  const input = el('textarea', { id: 'grant-share', readonly: true, rows: 3, spellcheck: 'false', 'aria-label': 'Private recipient share URL' }); input.value = url.href;
  const copy = button('Copy private share URL', async () => {
    if (!held.confirmed || grantRecovery !== held) return;
    try { await navigator.clipboard.writeText(input.value); if (grantRecovery === held) localMessage('grant-message', 'Private share copied. Anyone holding it can exercise this grant.'); }
    catch { if (grantRecovery === held) localMessage('grant-message', 'Select and copy the private URL manually.', true); }
  }, 'button button-secondary'); copy.id = 'copy-grant';
  replace(node, el('h3', {}, held.confirmed ? 'Private share ready' : 'Issue not yet confirmed'),
    el('p', {}, 'Keep this tab open. The secret is not recoverable from the service and is never saved locally or downloaded.'), input, copy,
    held.confirmed ? button('New grant', async () => {
      if (grantRecovery !== held || !await confirmChange('Clear this private share from the tab?', 'Copy it before continuing; the server cannot return its secret.', 'New grant')) return;
      if (grantRecovery === held) { grantRecovery = null; renderShareRecovery(); }
    }, 'quiet') : null);
  updateControls();
}

async function inspectGrant() {
  if (!configured || !recipientKey || recipientBusy || !recipientGrantId) return;
  recipientBusy = true; inspected = null; replace($('recipient-result')); $('recipient-result').hidden = true; updateControls();
  const key = recipientKey;
  try {
    const result = await api('/recipient/inspect', { grantId: recipientGrantId, recipientKey: key }, '');
    if (disposed || recipientKey !== key) return;
    if (result?.grantId !== recipientGrantId || typeof result.hostname !== 'string') throw new ServiceError('response_invalid');
    inspected = result; $('recipient-status').textContent = 'Access inspected';
    $('recipient-message').textContent = 'No use was consumed. Choose Redeem access only if you want this destination disclosed.';
    $('recipient-host').textContent = result.hostname; $('recipient-expiry').textContent = result.expiresAt; $('recipient-usage').textContent = String(result.remainingUses);
  } catch (error) { if (recipientKey === key && !disposed) { $('recipient-status').textContent = 'Access not confirmed'; $('recipient-message').textContent = messageFor(error); } }
  finally { recipientBusy = false; updateControls(); }
}

async function redeemGrant() {
  if (!configured || !recipientKey || recipientBusy || !inspected || !recipientGrantId) return;
  redemptionKey ??= crypto.randomUUID();
  const key = recipientKey; recipientBusy = true; replace($('recipient-result')); $('recipient-result').hidden = true; updateControls();
  try {
    const result = await api('/recipient/redeem', { grantId: recipientGrantId, recipientKey: key, redemptionKey }, '');
    if (disposed || recipientKey !== key) return;
    if (result?.grantId !== recipientGrantId || typeof result.destination !== 'string' || !result.receiptId) throw new ServiceError('response_invalid', { uncertain: true });
    const destination = new URL(result.destination);
    if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password) throw new ServiceError('response_invalid', { uncertain: true });
    $('recipient-status').textContent = result.replayed ? 'Committed receipt recovered' : 'Redemption committed';
    $('recipient-message').textContent = 'The service returned a committed receipt. Opening the destination is a separate choice; no navigation has occurred.';
    replace($('recipient-result'), el('p', {}, `Receipt ${result.receiptId} · use ${result.useNumber} · ${result.redeemedAt}`),
      el('button', { id: 'copy-receipt', type: 'button', className: 'button button-secondary', onClick: async () => {
        try { await navigator.clipboard.writeText(result.receiptId); if (recipientKey === key) $('recipient-message').textContent = 'Committed receipt ID copied. It is not a recipient credential or proof of a sale.'; }
        catch { if (recipientKey === key) $('recipient-message').textContent = 'Select the displayed receipt ID to copy it manually.'; }
      } }, 'Copy receipt ID'),
      el('a', { id: 'recipient-destination', className: 'button', href: destination.href, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' }, 'Open destination'));
    $('recipient-result').hidden = false; $('recipient-redeem').textContent = 'Recover same redemption';
  } catch (error) { if (recipientKey === key && !disposed) { $('recipient-status').textContent = 'Redemption not confirmed'; $('recipient-message').textContent = messageFor(error) + ' Retry retains the same redemption identity.'; $('recipient-redeem').textContent = 'Retry same redemption'; } }
  finally { recipientBusy = false; updateControls(); }
}

async function loadReport() {
  if (!workspace || ownerBusy || pendingChange) return;
  const epoch = ownerEpoch; ownerBusy = true; updateControls();
  try {
    const result = await api('/reports/redemptions', { workspaceId: workspace.id, from: null, to: null, limit: 50 });
    if (disposed || epoch !== ownerEpoch) return;
    renderReport(result);
  } catch (error) { if (epoch === ownerEpoch) notice(messageFor(error), true); }
  finally { if (epoch === ownerEpoch) { ownerBusy = false; updateControls(); } }
}

function renderReport(result) {
  const coverage = result?.coverage;
  if (!Number.isSafeInteger(result?.redemptions) || result.redemptions < 0 || !Array.isArray(result.campaigns) || result.campaigns.length > 50
    || coverage?.kind !== 'committed_redemptions' || coverage.recordCount !== result.redemptions || !Number.isSafeInteger(coverage.limit)
    || coverage.limit < 1 || coverage.limit > 50 || result.redemptions > coverage.limit || typeof coverage.from !== 'string' || typeof coverage.to !== 'string' || typeof coverage.truncated !== 'boolean'
    || result.conversionsAvailable !== false || result.campaigns.some(row => !row.campaign || !Number.isSafeInteger(row.redemptions) || row.redemptions < 0)) throw new ServiceError('response_invalid');
  replace($('report-content'), el('div', { className: 'report-summary' }, el('h3', {}, el('span', { id: 'report-count' }, String(result.redemptions)), ' committed redemptions in this bounded cohort'),
    el('p', { id: 'report-coverage' }, `UTC from ${coverage.from} (included) to ${coverage.to} (excluded). Limit ${coverage.limit}. ${coverage.truncated ? 'More records exist; this is not the complete period.' : 'The service reports this period was not truncated.'}`),
    el('p', {}, 'These are committed receipts, not unique people, arrival or sales. This redemption-only report excludes declarations. Load the full attribution report to see them.')),
    el('div', { className: 'report-rows' }, ...result.campaigns.map(row => el('article', { className: 'grant-row campaign-row' },
      el('div', {}, el('strong', {}, row.campaign.campaign || 'No campaign'), el('p', {}, `Source: ${row.campaign.source || 'unspecified'} · medium: ${row.campaign.medium || 'unspecified'}`)),
      el('strong', {}, String(row.redemptions))))));
}

function bulkRowOutcome(sourceRow) {
  const row = bulkJob?.rows.find(item => item.sourceRow === sourceRow);
  if (!row) return 'Not submitted';
  const labels = { invalid: 'Invalid · not submitted', unattempted: 'Unattempted', sending: 'Awaiting acknowledgment', uncertain: 'Unconfirmed · retain this tab', committed: 'Committed', replayed: 'Replayed · already committed', conflict: 'Conflict', rejected: 'Refused' };
  return el('div', {}, el('strong', {}, labels[row.status]), row.error ? el('p', { className: 'field-help' }, row.error) : null,
    ['conflict', 'rejected'].includes(row.status) ? button('Retry row ' + row.sourceRow, () => runBulk(true, row), 'quiet') : null);
}

async function prepareBulkSave() {
  if (!configured || !workspace || ownerBusy || pendingChange || bulkJob || !bulk?.validCount) return;
  const expected = bulk, revision = bulkRevision, epoch = ownerEpoch;
  const rows = bulk.rows.map(row => {
    const item = { sourceRow: row.row, line: row.line, status: row.errors.length ? 'invalid' : 'unattempted', error: null, intent: null };
    if (row.destination && !row.errors.length) {
      const linkId = crypto.randomUUID();
      item.intent = { mutationKey: crypto.randomUUID(), linkId, revisionId: crypto.randomUUID(), slug: 'ly-' + linkId, draft: { ...row.destination.draft } };
    }
    return item;
  });
  const batches = []; let batch = [];
  for (const row of rows.filter(item => item.intent)) {
    const proposed = [...batch, row];
    if (batch.length && (proposed.length > 50 || bodyByteLength({ workspaceId: workspace.id, rows: proposed.map(item => item.intent) }) > SERVICE_BODY_LIMIT)) {
      batches.push(batch); batch = [];
    }
    if (bodyByteLength({ workspaceId: workspace.id, rows: [row.intent] }) > SERVICE_BODY_LIMIT) {
      row.status = 'invalid'; row.error = 'This row exceeds the request byte limit; no write was attempted.';
    } else batch.push(row);
  }
  if (batch.length) batches.push(batch);
  const valid = rows.filter(row => row.intent && row.status === 'unattempted').length;
  if (!valid) { localMessage('bulk-message', 'No valid row fits the service limits. Nothing was sent.', true); return; }
  if (!await confirmChange('Save the valid reviewed rows?', `${valid} reviewed rows will be saved in ${batches.length} bounded requests. ${rows.length - valid} invalid rows will not be submitted. Each row has a stable identity; this tab is required to recover uncertain replies.`, 'Save valid rows')) return;
  if (disposed || ownerEpoch !== epoch || bulk !== expected || bulkRevision !== revision || ownerBusy || pendingChange || bulkJob) return;
  bulkJob = { epoch, workspaceId: workspace.id, sourceText: $('bulk-source').value, rows, batches, nextIndex: 0, pendingBatch: null };
  renderBulk(); renderBulkProgress(); await runBulk();
}

function renderBulkProgress() {
  if (!$('bulk-progress-panel')) return;
  if (!bulkJob) { $('bulk-progress-panel').hidden = true; return; }
  const counts = Object.fromEntries(['committed', 'replayed', 'invalid', 'conflict', 'rejected', 'unattempted', 'uncertain', 'sending'].map(status => [status, bulkJob.rows.filter(row => row.status === status).length]));
  $('bulk-progress').textContent = `${counts.committed} committed · ${counts.replayed} replayed · ${counts.invalid} invalid · ${counts.conflict} conflict · ${counts.rejected} refused · ${counts.unattempted} unattempted · ${counts.uncertain + counts.sending} awaiting confirmation. ${bulkJob.pendingBatch ? 'Recover the exact unconfirmed batch before other writes.' : bulkStopRequested ? 'Stopping after the current batch; remaining rows require Resume.' : 'Only committed/replayed rows are known saved.'}`;
  updateControls();
}

async function runBulk(oneOnly = false, retryRow = null) {
  const job = bulkJob;
  if (!job || ownerBusy || pendingChange || !workspace || ownerEpoch !== job.epoch || workspace.id !== job.workspaceId) return;
  if (retryRow && (job.pendingBatch || !job.rows.includes(retryRow) || !['conflict', 'rejected'].includes(retryRow.status))) return;
  if (retryRow) job.pendingBatch = { rows: [retryRow], body: { workspaceId: job.workspaceId, rows: [retryRow.intent] }, advanceTo: null };
  if (oneOnly && !job.pendingBatch) return;
  ownerBusy = true; bulkSending = true; bulkStopRequested = false; updateControls();
  try {
    for (;;) {
      if (job !== bulkJob || ownerEpoch !== job.epoch || disposed || bulkStopRequested) break;
      if (!job.pendingBatch) {
        if (job.nextIndex >= job.batches.length) break;
        const rows = job.batches[job.nextIndex];
        job.pendingBatch = { rows, body: { workspaceId: job.workspaceId, rows: rows.map(row => row.intent) }, advanceTo: job.nextIndex + 1 };
      }
      const pending = job.pendingBatch;
      for (const row of pending.rows) { row.status = 'sending'; row.error = null; }
      renderBulk(); renderBulkProgress();
      let result;
      try {
        result = await api('/links/bulk-create', pending.body);
        if (job !== bulkJob || ownerEpoch !== job.epoch || disposed) return;
        if (!Array.isArray(result?.outcomes) || result.outcomes.length !== pending.rows.length) throw new ServiceError('response_invalid', { uncertain: true });
        result.outcomes.forEach((outcome, index) => {
          const row = pending.rows[index];
          if (outcome.sourceIndex !== index || outcome.mutationKey !== row.intent.mutationKey || outcome.linkId !== row.intent.linkId || outcome.revisionId !== row.intent.revisionId
            || !['committed', 'replayed', 'error'].includes(outcome.status)
            || (outcome.status === 'error' ? outcome.version !== null || typeof outcome.error !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(outcome.error)
              : !Number.isSafeInteger(outcome.version) || outcome.version < 1 || outcome.error !== null)) throw new ServiceError('response_invalid', { uncertain: true });
        });
      } catch (error) {
        if (job !== bulkJob || ownerEpoch !== job.epoch || disposed) return;
        for (const row of pending.rows) { row.status = 'uncertain'; row.error = 'No committed acknowledgment received. Retry preserves the exact batch and row identities.'; }
        localMessage('bulk-message', 'Batch not confirmed. Keep this tab open and choose Retry exact unconfirmed batch; no automatic retry was sent.', true);
        break;
      }
      result.outcomes.forEach((outcome, index) => {
        const row = pending.rows[index];
        row.status = outcome.status === 'error' ? outcome.error === 'conflict' ? 'conflict' : 'rejected' : outcome.status;
        row.error = outcome.error; row.version = outcome.version;
      });
      if (pending.advanceTo !== null) job.nextIndex = pending.advanceTo;
      job.pendingBatch = null; renderBulk(); renderBulkProgress();
      if (oneOnly) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    if (job === bulkJob && ownerEpoch === job.epoch) {
      ownerBusy = false; bulkSending = false; renderBulk(); renderBulkProgress(); updateControls();
      if (!job.pendingBatch) localMessage('bulk-message', job.nextIndex < job.batches.length ? 'Import paused between batches. Choose Resume remaining rows when ready.' : 'All planned batches returned. Review each outcome, then Refresh workspace to load saved links. Refused/invalid rows are not reported as saved.');
    }
  }
}

async function loadConversionCredentials(held, epoch) {
  try {
    const value = await api('/conversion-credentials/list', { workspaceId: workspace.id, linkId: held.id, limit: 50, after: null });
    if (selected !== held || ownerEpoch !== epoch || disposed) return;
    if (!Array.isArray(value?.credentials) || value.credentials.length > 50 || value.credentials.some(row => row.purpose !== 'conversion_ingest' || row.linkId !== held.id)) throw new ServiceError('response_invalid');
    conversionCredentials = value.credentials; conversionNext = value.nextCursor ?? null;
  } catch {
    if (selected === held && ownerEpoch === epoch && !disposed) { conversionCredentials = null; conversionNext = null; }
  }
}

function renderConversionTools() {
  if (!selected || !workspace) return;
  const held = selected;
  const form = el('form', { id: 'conversion-form', className: 'service-form' }, el('h3', {}, 'Write-only conversion credential'),
    el('p', { className: 'field-help' }, 'Pinned to this link and its current destination revision. It can declare events for matching committed receipts; it cannot manage links or redeem access.'),
    el('label', { for: 'conversion-label' }, 'Conversion credential label'), el('input', { id: 'conversion-label', maxlength: 200, required: true }),
    el('label', { for: 'conversion-expiry' }, 'Conversion credential expires at (UTC)'), el('input', { id: 'conversion-expiry', maxlength: 24, required: true }),
    el('button', { id: 'issue-conversion', className: 'button', type: 'submit' }, 'Issue conversion credential'),
    el('p', { id: 'conversion-message', className: 'field-help', role: 'status' }));
  form.querySelector('#conversion-expiry').value = new Date(Date.now() + 86_400_000).toISOString();
  form.addEventListener('submit', event => {
    event.preventDefault(); if (selected !== held || ownerBusy || pendingChange || uncertainBulk()) return;
    if (conversionRecovery) { localMessage('conversion-message', 'Copy or explicitly clear the current private credential before issuing another.', true); return; }
    const label = $('conversion-label').value.trim(), expiresAt = $('conversion-expiry').value.trim();
    if (!label || hasCapability(label) || !utcExpiry(expiresAt)) { localMessage('conversion-message', 'Use a label without credentials and an explicit future canonical UTC expiry.', true); return; }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const ingestKey = 'lyi_' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    const body = { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId: held.id, revisionId: held.currentRevisionId, expectedVersion: held.version, credentialId: crypto.randomUUID(), ingestKey, label, expiresAt };
    conversionRecovery = { body, confirmed: false }; renderConversionRecovery();
    queueChange('Issue conversion credential', '/conversion-credentials/issue', body);
  });
  const listing = el('section', { id: 'conversion-credentials', className: 'conversion-credentials', 'aria-label': 'Conversion credentials' }, el('h3', {}, 'Conversion credentials'),
    el('p', { className: 'field-help' }, conversionCredentials === null ? 'Credential list unavailable or not loaded. No count is assumed.' : `${conversionCredentials.length} records in this bounded page${conversionNext ? '; more exist' : ''}. Secrets are never returned.`),
    ...(conversionCredentials ?? []).map(row => el('article', { className: 'credential-row grant-row' }, el('div', {}, el('strong', {}, row.label),
      el('p', {}, `Write-only declarations · expires ${row.expiresAt} · ${row.revokedAt ? 'revoked' : 'not revoked'}`), el('code', {}, row.id), el('p', {}, 'Pinned revision: ' + row.revisionId)),
    row.revokedAt ? null : button('Revoke conversion ' + row.label, async () => {
      if (selected !== held || ownerBusy || pendingChange || uncertainBulk() || !await confirmChange('Revoke this conversion credential?', 'New declarations and retries will require current authorization. Existing accepted declarations remain recorded.', 'Revoke conversion credential')) return;
      if (selected !== held || ownerBusy || pendingChange || uncertainBulk()) return;
      queueChange('Revoke conversion credential', '/conversion-credentials/revoke', { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId: held.id, credentialId: row.id, expectedVersion: held.version });
    }, 'button button-secondary'))));
  $('link-detail').append(el('section', { className: 'conversion-tools' }, form, listing));
}

function renderConversionRecovery() {
  const node = $('conversion-recovery'); if (!node) return;
  if (!conversionRecovery) { replace(node); return; }
  const held = conversionRecovery;
  const key = el('textarea', { id: 'conversion-key', readonly: true, rows: 2, spellcheck: 'false', 'aria-label': 'Private write-only conversion credential' }); key.value = held.body.ingestKey;
  const copy = button('Copy private conversion key', async () => {
    if (conversionRecovery !== held || !held.confirmed) return;
    try { await navigator.clipboard.writeText(key.value); if (conversionRecovery === held) notice('Private write-only key copied. Keep it on your trusted integration server.'); }
    catch { if (conversionRecovery === held) notice('Select and copy the key manually. It is not recoverable from the service.', true); }
  }, 'button button-secondary'); copy.id = 'copy-conversion-key';
  replace(node, el('h3', {}, held.confirmed ? 'Private conversion credential ready' : 'Conversion issue not yet confirmed'),
    el('p', {}, 'This key exists only in this tab. Copy it privately; never put it in a URL, browser analytics, download or public source.'), key, copy,
    held.confirmed ? button('Clear private conversion key', async () => {
      if (conversionRecovery !== held || !await confirmChange('Clear the private conversion key?', 'Keep your private integration copy first. The service cannot recover this secret; the issued credential is not revoked by clearing this tab.', 'Clear private key')) return;
      if (conversionRecovery === held) { conversionRecovery = null; renderConversionRecovery(); }
    }, 'quiet') : null,
    el('div', { id: 'conversion-instructions', className: 'integration-instructions' }, el('h4', {}, 'Connect your server, not browser analytics'),
      el('p', {}, 'Public credential ID: ', el('code', { id: 'conversion-credential-id' }, held.body.credentialId)),
      el('p', {}, `Send HTTPS POST requests to ${location.origin}/api/v1/conversions/ingest with Authorization: Bearer <your private key>. No example event is sent by this page.`),
      el('p', {}, `Credential ID: ${held.body.credentialId}. Scope: link ${held.body.linkId}, revision ${held.body.revisionId}. Use a matching committed receipt ID, copied explicitly after recipient redemption.`),
      el('p', {}, 'JSON fields: credentialId, receiptId, eventKey (a stable UUID), kind (lead_declared or sale_declared), amountMinor, currency and declaredAt (canonical UTC ISO). Leads use null amount/currency. Sales use both null when value is unknown, or a nonnegative safe integer in minor units and a three-letter currency code. Retry the same event identity and unchanged declaration to recover an acknowledgment. A declaration is not a verified purchase.')));
  updateControls();
}

async function loadAttributionReport() {
  if (!workspace || ownerBusy || pendingChange || uncertainBulk()) return;
  const epoch = ownerEpoch; ownerBusy = true; updateControls();
  try {
    const result = await api('/reports/attribution', { workspaceId: workspace.id, from: null, to: null, limit: 50 });
    if (!disposed && epoch === ownerEpoch) renderAttributionReport(result);
  } catch (error) { if (epoch === ownerEpoch) notice(messageFor(error), true); }
  finally { if (epoch === ownerEpoch) { ownerBusy = false; updateControls(); } }
}

function renderAttributionReport(value) {
  const r = value?.redemptions, d = value?.declarations;
  const count = x => Number.isSafeInteger(x) && x >= 0;
  const campaign = x => x && ['source', 'medium', 'campaign'].every(key => typeof x[key] === 'string' && x[key].length <= 100);
  const coverage = (x, kind, records) => x?.kind === kind && count(x.recordCount) && x.recordCount === records && Number.isSafeInteger(x.limit) && x.limit >= 1 && x.limit <= 50
    && records <= x.limit && typeof x.from === 'string' && typeof x.to === 'string' && typeof x.truncated === 'boolean';
  if (value?.conversionsAvailable !== true || !count(r?.count) || !count(d?.total) || !count(d.leads) || !count(d.sales) || !count(d.unknownValueSales)
    || d.leads + d.sales !== d.total || d.unknownValueSales > d.sales || !coverage(r.coverage, 'committed_redemptions', r.count)
    || !coverage(d.coverage, 'accepted_conversion_declarations', d.total) || !Array.isArray(r.campaigns) || r.campaigns.length > 50
    || r.campaigns.some(row => !campaign(row.campaign) || !count(row.count)) || !Array.isArray(d.campaigns) || d.campaigns.length > 50
    || d.campaigns.some(row => !campaign(row.campaign) || !count(row.leads) || !count(row.sales) || !count(row.unknownValueSales))
    || !Array.isArray(d.currencies) || d.currencies.length > 50 || d.currencies.some(row => typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency) || typeof row.amountMinor !== 'string'
      || !/^(0|[1-9][0-9]{0,31})$/.test(row.amountMinor) || !count(row.sales))) throw new ServiceError('response_invalid');
  const metrics = [['Committed redemptions', r.count, 'attribution-redemptions'], ['Declared leads', d.leads, 'attribution-leads'], ['Declared sales', d.sales, 'attribution-sales'], ['Sales with unknown value', d.unknownValueSales, 'attribution-unknown-sales']];
  const coverageText = (x, label) => `${label}: ${x.from} (included) to ${x.to} (excluded), limit ${x.limit}, ${x.recordCount} records. ${x.truncated ? 'Truncated; more records exist.' : 'Not truncated in this service response.'}`;
  replace($('report-content'), el('div', { className: 'report-summary' }, el('h3', {}, 'Recorded attribution, with separate cohorts'),
    el('p', {}, 'Redemptions use committed time. Declarations use accepted time, not merchant-declared time. Counts do not establish unique people, arrival or verified purchases.'),
    el('p', { id: 'redemption-coverage' }, coverageText(r.coverage, 'Redemption cohort')), el('p', { id: 'declaration-coverage' }, coverageText(d.coverage, 'Declaration cohort'))),
    el('div', { className: 'metric-grid attribution-metrics' }, ...metrics.map(([label, number, id]) => el('article', { className: 'metric' }, el('p', {}, label), el('strong', { id }, String(number))))),
    el('section', { className: 'report-rows', 'aria-label': 'Declared monetary totals' }, el('h3', {}, 'Declared amounts by currency'),
      el('p', { className: 'field-help' }, 'Exact minor-unit strings; currencies are not combined or assigned an assumed decimal scale. Unknown-value sales are excluded. Known zero-valued sales remain included.'),
      ...d.currencies.map(row => el('article', { className: 'grant-row currency-total', 'data-currency': row.currency }, el('strong', {}, row.currency),
        el('p', {}, el('span', { className: 'minor-unit-total' }, row.amountMinor), ` minor units · ${row.sales} declared sales`))),
      d.currencies.length ? null : el('p', {}, 'No known-value currency total in this returned cohort.')),
    el('section', { className: 'report-rows', 'aria-label': 'Redemptions by campaign' }, el('h3', {}, 'Redemptions by campaign'),
      ...r.campaigns.map(row => el('article', { className: 'grant-row' }, el('div', {}, el('strong', {}, row.campaign.campaign || 'No campaign'), el('p', {}, `${row.campaign.source || 'unspecified'} / ${row.campaign.medium || 'unspecified'}`)), el('span', {}, String(row.count))))),
    el('section', { className: 'report-rows', 'aria-label': 'Declarations by campaign' }, el('h3', {}, 'Declarations by campaign'),
      ...d.campaigns.map(row => el('article', { className: 'grant-row' }, el('div', {}, el('strong', {}, row.campaign.campaign || 'No campaign'), el('p', {}, `${row.campaign.source || 'unspecified'} / ${row.campaign.medium || 'unspecified'}`)),
        el('p', {}, `${row.leads} declared leads · ${row.sales} declared sales · ${row.unknownValueSales} unknown-value sales`)))));
}
