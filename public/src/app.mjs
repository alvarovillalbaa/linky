import { normalizeLinkDraft, buildDestination, analyzeDestination, parseBulkCsv } from './destinations.mjs';
import { el, replace, button, fieldError } from './ui.mjs';

const $ = id => document.getElementById(id);
// Initial presentation state only; no service probe, session or catalogue exists.
const serviceStatus = 'configuration_required';
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
  history.replaceState(null, '', '#' + view);
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
for (const id of ['recipient-view', 'access-recipient']) $(id).addEventListener('click', () => navigate('recipient'));
$('operator-view').addEventListener('click', () => navigate('links'));
$('dismiss-notice').addEventListener('click', () => { $('app-notice').hidden = true; });
$('open-about').addEventListener('click', () => $('about-dialog').showModal());

for (const tab of document.querySelectorAll('[data-filter]')) tab.addEventListener('click', () => {
  for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === tab));
  $('registry-status').textContent = `${tab.dataset.filter === 'all' ? 'All links' : tab.textContent.trim()} filter selected · registry data unavailable`;
  $('registry-empty-description').textContent = 'The shared service is not configured. This filter has not queried records and no matching count is asserted. Draft review is still available.';
});
$('registry-search').addEventListener('input', () => {
  $('registry-status').textContent = $('registry-search').value ? 'Search entered · no service query sent and no result count asserted' : 'Registry unavailable · no record count asserted';
});

window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
window.addEventListener('beforeunload', event => {
  if (hasDraft() || $('bulk-source').value.length) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', event => {
  cancelFileRead();
  if (!event.persisted) { disposed = true; confirmation?.(false); confirmation = null; }
});

$('service-notice').dataset.status = serviceStatus;
renderPreview(); renderSafety();
const initialView = location.hash.slice(1);
navigate(Object.hasOwn(views, initialView) || initialView === 'recipient' ? initialView : 'links', false);
