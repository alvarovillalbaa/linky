import { normalizeLinkDraft, buildDestination, analyzeDestination, parseBulkCsv } from './destinations.mjs';
import { el, replace, button, fieldError } from './ui.mjs';
import { requestService, ServiceError } from './server-client.mjs';

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
  bulkRevision++;
  cancelFileRead();
  bulk = null;
  $('bulk-message').hidden = true;
  replace($('bulk-result'));
}

$('bulk-source').addEventListener('input', bulkChanged);

function reviewBulk() {
  cancelFileRead();
  try {
    bulk = parseBulkCsv($('bulk-source').value);
    renderBulk();
    localMessage('bulk-message', `${bulk.rows.length} data rows reviewed: ${bulk.validCount} valid for destination review, ${bulk.invalidCount} needing correction. No records were imported.`);
  } catch {
    bulk = null; replace($('bulk-result'));
    localMessage('bulk-message', 'CSV could not be reviewed. Use the exact title,destination,source,medium,campaign header, valid CSV quoting, up to 500 rows and 1 MiB of UTF-8. Your source text was kept.', true);
  }
}

function renderBulk() {
  if (!bulk) { replace($('bulk-result')); return; }
  const expected = bulk;
  replace($('bulk-result'), el('div', { className: 'bulk-counts' },
    el('span', {}, el('strong', {}, bulk.validCount), 'valid for review'), el('span', {}, el('strong', {}, bulk.invalidCount), 'need correction')),
    el('div', { className: 'table-frame' }, el('div', { className: 'table-scroll', tabindex: 0, role: 'region', 'aria-label': 'CSV row review table' },
      el('table', { className: 'bulk-table' }, el('caption', { className: 'visually-hidden' }, 'Supplied CSV rows for review only. No links have been created.'),
        el('thead', {}, el('tr', {}, ['ROW / LINE', 'TITLE', 'DESTINATION / ISSUE', 'REVIEW'].map(label => el('th', { scope: 'col' }, label)))),
        el('tbody', {}, bulk.rows.map(row => el('tr', {},
          el('th', { scope: 'row' }, `${row.row} / ${row.line}`),
          el('td', {}, row.draft?.title || 'No accepted title'),
          el('td', {}, row.errors.length ? el('ul', { className: 'row-errors' }, row.errors.map(error => el('li', {}, error.message)))
            : el('p', { className: 'row-url' }, row.destination?.url ?? 'No accepted destination')),
          el('td', {}, row.destination && !row.errors.length ? button('Review as draft →', () => useBulkRow(expected, row)) : 'Correct source row'))))))));
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
  const expected = bulkRevision;
  if ($('bulk-source').value.length && !await confirmChange('Clear the CSV source and review?', 'This clears only the local CSV text and its review. Your unsent link draft is kept.', 'Clear CSV')) return;
  if (disposed || expected !== bulkRevision) { localMessage('bulk-message', 'The CSV changed. Nothing was cleared.'); return; }
  $('bulk-source').value = ''; bulkChanged();
  localMessage('bulk-message', 'CSV source and review cleared. No shared records were changed.'); $('bulk-source').focus();
});
$('open-bulk').addEventListener('click', () => { if (!$('bulk-dialog').open) $('bulk-dialog').showModal(); $('bulk-source').focus(); });
$('close-bulk').addEventListener('click', () => $('bulk-dialog').close());
$('bulk-dialog').addEventListener('close', cancelFileRead);

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
  if (hasDraft() || $('bulk-source').value.length || pendingChange || grantRecovery) { event.preventDefault(); event.returnValue = ''; }
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
  replace($('view-access'), el('div', { className: 'section-topline' }, el('div', {}, el('p', { className: 'eyebrow' }, 'CONTROL DISCLOSURE'),
    el('h2', {}, 'Make the handoff deliberate.'), el('p', { className: 'muted' }, 'Select a saved link to revise it, issue a finite grant, pause access or revoke a grant.'))),
    el('section', { id: 'link-detail', className: 'panel' }),
    el('p', { className: 'boundary-note' }, 'An ordinary URL already learned remains usable outside Linky. Stronger protection requires enforcement at the destination.'));
  replace($('view-attribution'), el('div', { className: 'section-topline' }, el('div', {}, el('p', { className: 'eyebrow' }, 'EVIDENCE, NOT ASSUMPTIONS'),
    el('h2', {}, 'Follow committed records.'), el('p', { className: 'muted' }, 'Conversion ingestion and bulk persistence are not enabled in this release.')),
    el('button', { id: 'load-report', className: 'button button-secondary', type: 'button', onClick: loadReport }, 'Load redemption report')),
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
  renderRegistry(); renderSelected(); updateControls();
}

function updateControls() {
  if (!$('owner-connect')) return;
  const ready = configured && workspace && ownerKey;
  $('owner-connect').disabled = !configured || ownerBusy || Boolean(workspace);
  $('owner-disconnect').disabled = !ownerKey && !workspace;
  $('owner-key').disabled = ownerBusy || Boolean(workspace);
  $('refresh-workspace').disabled = !ready || ownerBusy || Boolean(pendingChange);
  $('next-links').disabled = !ready || ownerBusy || Boolean(pendingChange) || !nextCursor;
  $('load-report').disabled = !ready || ownerBusy || Boolean(pendingChange);
  $('create-shared').disabled = !ready || ownerBusy || Boolean(pendingChange) || !reviewed?.destination || reviewed.revision !== draftRevision;
  $('create-disabled-reason').textContent = ready ? 'Only the current reviewed draft is saved. No destination website is fetched.' : 'Connect the shared service and review the current draft before saving.';
  $('mutation-recovery').hidden = !pendingChange;
  if (pendingChange) $('mutation-recovery-message').textContent = `${pendingChange.label}: ${pendingChange.message ?? 'Awaiting a committed acknowledgment.'} Retry keeps the exact same request and identifiers.`;
  $('mutation-retry').disabled = ownerBusy || !ready;
  for (const control of $('link-detail').querySelectorAll('button,input')) control.disabled = !ready || ownerBusy || Boolean(pendingChange);
  if ($('grant-share')) $('grant-share').disabled = false;
  if ($('copy-grant')) $('copy-grant').disabled = ownerBusy || !grantRecovery?.confirmed;
  if ($('save-revision')) $('save-revision').disabled = !ready || ownerBusy || Boolean(pendingChange) || !$('save-revision').dataset.reviewed;
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
  ownerKey = ''; recipientKey = ''; workspace = null; links = []; selected = null; grants = [];
  nextCursor = null; grantNext = null; pendingChange = null; grantRecovery = null; inspected = null; redemptionKey = null; ownerBusy = false;
  $('owner-key').value = ''; replace($('recipient-result')); $('recipient-result').hidden = true;
  $('owner-state').textContent = 'Disconnected. Reopen the original credential to connect again.';
  $('workspace-label').textContent = 'Connect your owner workspace'; $('sidebar-status').textContent = 'No owner workspace connected';
  replace($('report-content'), el('div', { className: 'empty-inline' }, el('h3', {}, 'No report requested.')));
  $('recipient-status').textContent = 'Credential cleared'; $('recipient-message').textContent = 'Reopen the original grant link to continue.';
  for (const id of ['recipient-host', 'recipient-expiry', 'recipient-usage']) $(id).textContent = 'Not checked';
  renderRegistry(); renderSelected(); renderShareRecovery(); updateControls();
}

async function disconnect() {
  if ((pendingChange || grantRecovery) && !await confirmChange('Disconnect and clear private recovery?', 'The recipient secret and any unconfirmed change exist only in this tab. Disconnecting cannot undo a committed service action.', 'Disconnect')) return;
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
  if (!workspace || ownerBusy || pendingChange) return;
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
}

async function selectLink(row) {
  if (!workspace || ownerBusy || pendingChange) return;
  if (grantRecovery && selected?.id !== row.id && !await confirmChange('Leave this private share?', 'Copy the private grant first. Its secret cannot be recovered from the server.', 'Leave share')) return;
  const epoch = ownerEpoch; selected = row; grants = []; grantRecovery = null; ownerBusy = true;
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
}

function createLink() {
  if (!workspace || ownerBusy || pendingChange || !reviewed?.destination || reviewed.revision !== draftRevision) return;
  const linkId = crypto.randomUUID();
  queueChange('Create shared link', '/links/create', { workspaceId: workspace.id, mutationKey: crypto.randomUUID(), linkId,
    revisionId: crypto.randomUUID(), slug: 'ly-' + linkId, draft: { ...reviewed.destination.draft } });
}

function queueChange(label, path, body) {
  if (!workspace || ownerBusy || pendingChange) return;
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
      || (held.body.revisionId && acknowledgment.revisionId !== held.body.revisionId)) throw new ServiceError('response_invalid', { uncertain: true });
    if (grantRecovery && held.path === '/grants/issue') grantRecovery.confirmed = true;
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
    if (!label || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000000 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expiresAt)
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
  renderShareRecovery(); updateControls();
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
    el('p', {}, 'These are committed receipts, not unique people, arrival or sales. Conversion ingestion is unavailable; no conversion count is asserted.')),
    el('div', { className: 'report-rows' }, ...result.campaigns.map(row => el('article', { className: 'grant-row campaign-row' },
      el('div', {}, el('strong', {}, row.campaign.campaign || 'No campaign'), el('p', {}, `Source: ${row.campaign.source || 'unspecified'} · medium: ${row.campaign.medium || 'unspecified'}`)),
      el('strong', {}, String(row.redemptions))))));
}
