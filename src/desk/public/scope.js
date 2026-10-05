import { api, notice, downloadText } from '/common.js';
import { animateChange, cancelMotion } from '/motion.js';

const $ = (id) => document.getElementById(id);
const form = $('scope-form');
const review = document.querySelector('.scope-review');
const baselineRows = [];
const changeRows = [];
let serial = 0;
let savedRecord = null;
let busy = false;
let inputVersion = 0;
let openRequest = 0;
let inferenceConfigured = false;
let pendingInterpretation = null;
let activeInterpretationId = null;
let interpretationBaseline = null;
const workspaceBar = document.querySelector('.scope-workspace-bar');
function measureWorkspaceBar() {
  $('scope-main').style.setProperty('--scope-nav-height', `${Math.ceil(workspaceBar.getBoundingClientRect().height)}px`);
}
measureWorkspaceBar();
const barObserver = new ResizeObserver(measureWorkspaceBar);
barObserver.observe(workspaceBar);
window.addEventListener('pagehide', () => barObserver.disconnect());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { measureWorkspaceBar(); barObserver.observe(workspaceBar); }
});

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function field(label, value = '', { type = 'text', options, required = true, maxLength = 4000 } = {}) {
  const wrap = node('div', undefined, 'field');
  const input = document.createElement(options ? 'select' : 'input');
  input.id = `scope-field-${++serial}`;
  input.required = required;
  if (options) {
    for (const [key, text] of options) {
      const option = node('option', text);
      option.value = key;
      input.append(option);
    }
  } else {
    input.type = type;
    input.maxLength = maxLength;
    if (type === 'number') { input.min = '1'; input.step = '1'; }
  }
  input.value = value;
  const caption = node('label', label);
  caption.htmlFor = input.id;
  wrap.append(caption, input);
  return { wrap, input };
}

function moneyText(value, digits = Number(form.elements.digits.value)) {
  if (value === null) return 'Unresolved';
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(digits);
  return `${amount < 0n ? '-' : ''}${absolute / scale}${digits ? `.${String(absolute % scale).padStart(digits, '0')}` : ''}`;
}

function minorUnits(value) {
  const digits = Number(form.elements.digits.value);
  const input = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match || (match[2]?.length ?? 0) > digits) throw new Error(`Unit prices must be nonnegative amounts with at most ${digits} decimal places.`);
  const amount = BigInt(match[1]) * (10n ** BigInt(digits)) + BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unit price is too large to calculate safely.');
  return Number(amount);
}

function markDirty() {
  // Consent belongs to the reviewed input, never to a later edit or example.
  $('scope-inference-consent').checked = false;
  syncInferenceControls();
  inputVersion += 1;
  cancelLedgerMotion();
  review.dataset.revisionState = 'editing';
  $('scope-input-state').textContent = 'Unsaved edits · preview needed';
  notice($('scope-notice'), '');
  $('apply-interpretation').disabled = true;
  savedRecord = null;
  $('download-markdown').disabled = true;
  $('download-json').disabled = true;
  $('scope-download-note').textContent = 'Save a new draft to download your current inputs and revision.';
  $('scope-preview').replaceChildren(node('p', 'Inputs changed. Preview the revision to recalculate the amounts.', 'muted'));
}

function cancelLedgerMotion() {
  for (const element of $('scope-preview').querySelectorAll('[data-ledger-motion]')) cancelMotion(element);
}

function highlightLedger() {
  const preview = $('scope-preview');
  for (const cell of preview.querySelectorAll('.scope-known-subtotal td')) {
    animateChange(cell, [{ backgroundColor: '#dce6ff' }, { backgroundColor: '#f0f4ff' }], { duration: 380 });
  }
  animateChange(preview.querySelector('.scope-ledger-rule'), [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 380 });
  animateChange(preview.querySelector('.status'), [{ backgroundColor: '#d7e4ff' }, { backgroundColor: '#edf2ff' }], { duration: 300 });
}

function updateItemChoices() {
  $('existing-item-ids').replaceChildren(...baselineRows.map(({ fields }) => {
    const option = node('option'); option.value = fields.id.input.value; return option;
  }));
}

function removeButton(label, row, collection, container) {
  const button = node('button', label, 'button secondary');
  button.type = 'button';
  button.addEventListener('click', () => {
    collection.splice(collection.indexOf(row), 1);
    container.remove();
    updateItemChoices();
    markDirty();
  });
  return button;
}

function addBaseline(value = {}) {
  if (baselineRows.length >= 100) return notice($('scope-notice'), 'A quote supports up to 100 items.', true);
  const group = node('fieldset', undefined, 'stack');
  group.append(node('legend', 'Quote item'));
  const fields = {
    id: field('Item ID', value.id ?? '', { maxLength: 80 }),
    description: field('Description', value.description ?? '', { maxLength: 500 }),
    quantity: field('Quantity', value.quantity ?? 1, { type: 'number' }),
    rate: field('Unit price', value.unitRateMinor === undefined ? '' : moneyText(value.unitRateMinor), { maxLength: 24 }),
    rateRef: field('Provided rate approval reference', value.rateApprovalRef ?? ''),
  };
  fields.rate.input.inputMode = 'decimal';
  const grid = node('div', undefined, 'form-grid');
  grid.append(...Object.values(fields).map(({ wrap }) => wrap));
  const row = { fields };
  baselineRows.push(row);
  group.append(grid, removeButton('Remove quote item', row, baselineRows, group));
  $('baseline-items').append(group);
  updateItemChoices();
}

function toggleGroup(group, show) {
  group.hidden = !show;
  for (const input of group.querySelectorAll('input,select')) input.disabled = !show;
}

function addChange(value = {}) {
  if (changeRows.length >= 100) return notice($('scope-notice'), 'A revision supports up to 100 changes.', true);
  const group = node('fieldset', undefined, 'stack');
  group.append(node('legend', 'Requested change'));
  const fields = {
    action: field('Change type', value.action ?? 'set_quantity', { options: [['set_quantity', 'Set quantity'], ['add', 'Add item'], ['remove', 'Remove item']] }),
    itemId: field('Item ID', value.itemId ?? '', { maxLength: 80 }),
    quantity: field('New quantity', value.quantity ?? 1, { type: 'number' }),
    description: field('New item description', value.description ?? '', { maxLength: 500 }),
    pricing: field('Pricing', value.unitRateMinor === null || value.unitRateMinor === undefined ? 'unknown' : 'priced', { options: [['unknown', 'Unresolved price'], ['priced', 'Explicit price (including zero)']] }),
    rate: field('Unit price', value.unitRateMinor === null || value.unitRateMinor === undefined ? '' : moneyText(value.unitRateMinor), { maxLength: 24 }),
    rateRef: field('Provided rate approval reference', value.rateApprovalRef ?? ''),
    question: field('Pricing question', value.pricingQuestion ?? ''),
    sourceRef: field('Source for this change', value.sourceRef ?? ''),
  };
  fields.itemId.input.setAttribute('list', 'existing-item-ids');
  fields.rate.input.inputMode = 'decimal';
  const basics = node('div', undefined, 'form-grid');
  basics.append(fields.action.wrap, fields.itemId.wrap, fields.quantity.wrap);
  const additions = node('div', undefined, 'stack');
  additions.append(fields.description.wrap, fields.pricing.wrap);
  const priced = node('div', undefined, 'form-grid');
  priced.append(fields.rate.wrap, fields.rateRef.wrap);
  additions.append(priced, fields.question.wrap);
  const update = () => {
    const adding = fields.action.input.value === 'add';
    toggleGroup(fields.quantity.wrap, fields.action.input.value !== 'remove');
    toggleGroup(additions, adding);
    toggleGroup(priced, adding && fields.pricing.input.value === 'priced');
    toggleGroup(fields.question.wrap, adding && fields.pricing.input.value === 'unknown');
  };
  fields.action.input.addEventListener('change', update);
  fields.pricing.input.addEventListener('change', update);
  const row = { fields };
  changeRows.push(row);
  group.append(basics, additions, fields.sourceRef.wrap, removeButton('Remove requested change', row, changeRows, group));
  $('scope-changes').append(group);
  update();
}

function quoteInput() {
  const value = (name) => form.elements[name].value.trim();
  const quote = { version: 1, id: value('quoteId'), currency: value('currency'), minorUnitDigits: Number(value('digits')),
    items: baselineRows.map(({ fields: f }) => ({ id: f.id.input.value.trim(), description: f.description.input.value.trim(),
      quantity: Number(f.quantity.input.value), unitRateMinor: minorUnits(f.rate.input.value), rateApprovalRef: f.rateRef.input.value.trim() })) };
  if (value('deadline') || value('deadlineSource')) quote.agreedDeadline = { text: value('deadline'), sourceRef: value('deadlineSource') };
  return quote;
}

function inputValue() {
  const value = (name) => form.elements[name].value.trim();
  const quote = quoteInput();
  const changes = changeRows.map(({ fields: f }) => {
    const change = { action: f.action.input.value, itemId: f.itemId.input.value.trim(), sourceRef: f.sourceRef.input.value.trim() };
    if (change.action !== 'remove') change.quantity = Number(f.quantity.input.value);
    if (change.action === 'add') {
      change.description = f.description.input.value.trim();
      if (f.pricing.input.value === 'unknown') { change.unitRateMinor = null; change.pricingQuestion = f.question.input.value.trim(); }
      else { change.unitRateMinor = minorUnits(f.rate.input.value); change.rateApprovalRef = f.rateRef.input.value.trim(); }
    }
    return change;
  });
  return { title: value('title'), quote,
    request: { version: 1, id: value('requestId'), quoteId: quote.id, changes, deadlineQuestions: value('deadlineQuestions').split('\n').map((line) => line.trim()).filter(Boolean) },
    sources: { quoteSource: value('quoteSource'), changeSource: value('changeSource') },
    ...(activeInterpretationId && JSON.stringify(quote) === interpretationBaseline ? { interpretationId: activeInterpretationId } : {}) };
}

function fill(record) {
  // Loading a record changes the disclosed payload without native input events.
  $('scope-inference-consent').checked = false;
  const { quote, request, sources } = record;
  const values = { title: record.title, quoteId: quote.id, currency: quote.currency, digits: quote.minorUnitDigits,
    quoteSource: sources.quoteSource, requestId: request.id, changeSource: sources.changeSource,
    deadline: quote.agreedDeadline?.text ?? '', deadlineSource: quote.agreedDeadline?.sourceRef ?? '',
    deadlineQuestions: (request.deadlineQuestions ?? []).join('\n') };
  for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
  baselineRows.length = 0; changeRows.length = 0;
  $('baseline-items').replaceChildren(); $('scope-changes').replaceChildren();
  quote.items.forEach(addBaseline); request.changes.forEach(addChange);
  activeInterpretationId = record.interpretationId ?? null;
  interpretationBaseline = activeInterpretationId ? JSON.stringify(quote) : null;
  pendingInterpretation = null;
  $('scope-interpretation').hidden = true;
  $('apply-interpretation').disabled = true;
  syncInferenceControls();
}

function table(headers, rows) {
  const wrapper = node('div', undefined, 'table-wrap');
  const result = node('table', undefined, 'data-table');
  const head = node('thead'); const tr = node('tr');
  for (const title of headers) { const th = node('th', title); th.scope = 'col'; tr.append(th); }
  head.append(tr);
  const body = node('tbody');
  for (const values of rows) { const row = node('tr'); values.forEach((value) => row.append(node('td', String(value)))); body.append(row); }
  result.append(head, body); wrapper.append(result); return wrapper;
}

function render(record) {
  const r = record.revision;
  const money = (amount) => amount === null ? 'Unresolved' : `${r.currency} ${moneyText(amount, r.minorUnitDigits)}`;
  const preview = $('scope-preview');
  cancelLedgerMotion();
  review.dataset.revisionState = record.id ? 'saved' : 'preview';
  $('scope-input-state').textContent = record.id ? `Saved version · ${record.id.slice(0, 8)}` : 'Current preview · unsaved';
  const status = node('p', record.id ? `Saved draft · ${new Date(record.createdAt).toLocaleString()}` : 'Unsaved preview · draft for owner review', 'status');
  status.dataset.ledgerMotion = '';
  preview.replaceChildren(status, node('h3', record.title, 'scope-preview-title'));
  const amounts = [r.originalTotalMinor, r.knownSubtotalMinor, r.knownDeltaMinor, r.totalMinor, r.deltaMinor];
  const ledger = table(['Amount', 'Value'], [
    ['Original quote', money(r.originalTotalMinor)], ['Known revised subtotal', money(r.knownSubtotalMinor)],
    ['Known price delta', money(r.knownDeltaMinor)], ['Full revised total', money(r.totalMinor)], ['Full price delta', money(r.deltaMinor)],
  ]);
  ledger.classList.add('scope-result-ledger');
  for (const [index, row] of [...ledger.querySelectorAll('tbody tr')].entries()) {
    const value = row.lastElementChild;
    value.dataset.unresolved = String(amounts[index] === null);
    if (index === 1) {
      row.classList.add('scope-known-subtotal');
      for (const cell of row.children) cell.dataset.ledgerMotion = '';
      const rule = node('span', undefined, 'scope-ledger-rule');
      rule.setAttribute('aria-hidden', 'true');
      rule.dataset.ledgerMotion = '';
      value.append(rule);
    }
    if (index === 3) row.classList.add('scope-full-result');
  }
  preview.append(ledger);
  preview.append(node('p', r.pricingResolved ? 'All lines have explicit rates. Client approval and schedule still require review.' : 'Unpriced lines are excluded from the known amounts. The full total and full delta remain unresolved.', 'muted'));
  if (record.interpretation) preview.append(node('p', `Suggested with ${record.interpretation.inference.provider} / ${record.interpretation.inference.model}. ${record.interpretation.inference.liveInferenceVerified ? 'Live response recorded.' : 'Live inference not verified.'} ${record.interpretation.editedSinceInterpretation ? 'Edited after interpretation.' : 'Matches the stored suggestion.'}`, 'muted'));
  preview.append(node('h3', 'Proposed line items'));
  if (r.revisedItems.length) {
    const items = table(['Item', 'Qty', 'Unit price', 'Amount'], r.revisedItems.map((item) => [item.description, item.quantity, money(item.unitRateMinor), money(item.amountMinor)]));
    items.classList.add('scope-result-items');
    for (const [index, row] of [...items.querySelectorAll('tbody tr')].entries()) {
      row.children[2].dataset.unresolved = String(r.revisedItems[index].unitRateMinor === null);
      row.children[3].dataset.unresolved = String(r.revisedItems[index].amountMinor === null);
    }
    preview.append(items);
  }
  else preview.append(node('p', 'All original items are proposed for removal.'));
  preview.append(node('h3', 'Changes and provided references'));
  for (const change of r.changes) {
    const group = node('div', undefined, 'stack');
    group.append(node('p', `${change.itemId}: ${change.action === 'set_quantity' ? 'set quantity' : change.action}. Quantity ${change.before?.quantity ?? 0} → ${change.after?.quantity ?? 0}.`),
      node('p', `Change source: ${change.sourceRef}`, 'muted'),
      node('p', `Rate reference: ${change.after?.rateApprovalRef ?? change.before?.rateApprovalRef ?? 'No rate supplied.'}`, 'muted'));
    preview.append(group);
  }
  if (r.pricingQuestions.length) {
    preview.append(node('h3', 'Pricing to resolve'));
    const list = node('ul'); r.pricingQuestions.forEach(({ itemId, question }) => list.append(node('li', `${itemId}: ${question}`))); preview.append(list);
  }
  preview.append(node('h3', 'Deadline review'), node('p', r.agreedDeadline ? `Original deadline: ${r.agreedDeadline.text}. Source: ${r.agreedDeadline.sourceRef}` : 'No original deadline supplied.'));
  if (r.deadlineQuestions.length) { const list = node('ul'); r.deadlineQuestions.forEach((question) => list.append(node('li', question))); preview.append(list); }
  preview.append(node('p', 'Schedule not validated. Client approval not recorded.', 'muted'));
  const artifact = node('details', undefined, 'artifact');
  artifact.append(node('summary', 'Read draft document'), node('pre', record.markdown)); preview.append(artifact);
  savedRecord = record.id ? record : null;
  $('download-markdown').disabled = !savedRecord;
  $('download-json').disabled = !savedRecord;
  $('scope-download-note').textContent = savedRecord ? 'Download this saved draft and its preserved structured inputs.' : 'Downloads become available after saving a draft.';
}

async function refreshHistory() {
  const { records } = await api('scope', 'list');
  const history = $('scope-history');
  if (!records.length) { history.replaceChildren(node('p', 'No drafts saved yet. Save a revision to keep its inputs and review document here.', 'muted')); return; }
  history.replaceChildren();
  for (const record of records) {
    const group = node('div', undefined, 'history-row');
    const text = node('div');
    text.append(node('strong', record.title), node('p', `${new Date(record.createdAt).toLocaleString()} · ${record.id.slice(0, 8)} · ${record.unresolvedPricingCount ? `${record.unresolvedPricingCount} unpriced item(s)` : 'All rates supplied'}`, 'muted'));
    const button = node('button', 'Open draft', 'button secondary');
    button.type = 'button'; button.setAttribute('aria-label', `Open draft ${record.title}, ${record.id.slice(0, 8)}`);
    button.addEventListener('click', async () => {
      if (busy) return;
      const requestedVersion = inputVersion;
      const request = ++openRequest;
      button.disabled = true;
      try {
        const detail = await api('scope', 'detail', { id: record.id });
        if (requestedVersion !== inputVersion || request !== openRequest) return;
        inputVersion += 1;
        fill(detail); render(detail); highlightLedger();
        $('example-note').textContent = 'Saved inputs loaded. Any edits can be saved as a new draft.';
        notice($('scope-notice'), 'Saved draft opened.');
      } catch (error) {
        if (requestedVersion === inputVersion && request === openRequest) notice($('scope-notice'), error.message, true);
      }
      finally { button.disabled = false; }
    });
    group.append(text, button); history.append(group);
  }
}

form.addEventListener('input', () => { markDirty(); updateItemChoices(); });
form.addEventListener('change', markDirty);
document.querySelector('.scope-section-nav').addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const heading = $(link.hash.slice(1));
  if (!heading) return;
  event.preventDefault();
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start', behavior: 'auto' });
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  openRequest += 1;
  const action = event.submitter?.value === 'save' ? 'save' : 'preview';
  const submit = event.submitter ?? $('preview-scope');
  const label = submit.textContent;
  try {
    const input = inputValue();
    const requestedVersion = inputVersion;
    busy = true;
    syncInferenceControls();
    $('preview-scope').disabled = true; $('save-scope').disabled = true;
    submit.textContent = action === 'save' ? 'Saving…' : 'Calculating…';
    notice($('scope-notice'), action === 'save' ? 'Saving draft…' : 'Calculating revision…');
    const record = await api('scope', action, input);
    if (requestedVersion === inputVersion) {
      render(record);
      notice($('scope-notice'), action === 'save' ? 'New local draft saved. The quote and requested changes are preserved with it.' : 'Preview recalculated from your structured inputs.');
      if (!document.hidden) {
        $('preview-heading').focus({ preventScroll: true });
        $('preview-heading').scrollIntoView({ block: 'start', behavior: 'auto' });
      }
      highlightLedger();
    } else {
      notice($('scope-notice'), action === 'save' ? 'Earlier inputs were saved as a draft. Preview again to calculate your newer edits.' : 'Inputs changed during calculation. Preview again to calculate your newer edits.');
    }
    if (action === 'save') {
      try { await refreshHistory(); }
      catch (error) { notice($('scope-notice'), `Draft saved, but history could not refresh: ${error.message}`, true); }
    }
  } catch (error) { notice($('scope-notice'), error.message, true); }
  finally {
    busy = false;
    submit.textContent = label;
    $('preview-scope').disabled = false; $('save-scope').disabled = false;
    syncInferenceControls();
  }
});

$('add-baseline').addEventListener('click', () => { addBaseline(); markDirty(); });
$('add-change').addEventListener('click', () => { addChange(); markDirty(); });
$('refresh-scope').addEventListener('click', async () => {
  $('refresh-scope').disabled = true;
  try { await refreshHistory(); } catch (error) { notice($('scope-notice'), error.message, true); }
  finally { $('refresh-scope').disabled = false; }
});
$('download-markdown').addEventListener('click', () => { if (savedRecord) downloadText(`scope-${savedRecord.id}.md`, savedRecord.markdown, 'text/markdown'); });
$('download-json').addEventListener('click', () => { if (savedRecord) downloadText(`scope-${savedRecord.id}.json`, JSON.stringify(savedRecord, null, 2), 'application/json'); });
$('scope-example').addEventListener('click', () => {
  fill({ title: 'Synthetic website expansion',
    quote: { version: 1, id: 'synthetic-website', currency: 'USD', minorUnitDigits: 2,
      items: [{ id: 'pages', description: 'Website pages', quantity: 3, unitRateMinor: 20000, rateApprovalRef: 'Synthetic agreed quote, page rate' }],
      agreedDeadline: { text: 'Two weeks after content handoff', sourceRef: 'Synthetic quote, timeline paragraph' } },
    request: { version: 1, id: 'synthetic-change', quoteId: 'synthetic-website', changes: [
      { action: 'set_quantity', itemId: 'pages', quantity: 5, sourceRef: 'Synthetic client email: please make this five pages' },
      { action: 'add', itemId: 'checkout', description: 'Checkout feature', quantity: 1, unitRateMinor: null, pricingQuestion: 'What rate should be agreed for checkout?', sourceRef: 'Synthetic client email: add checkout' },
    ], deadlineQuestions: ['Does the expanded scope require a new deadline?'] },
    sources: { quoteSource: 'Synthetic website quote — invented example', changeSource: 'Synthetic change email — invented example' },
  });
  markDirty();
  $('example-note').textContent = 'Synthetic example loaded: all quote values, references, and requests are invented.';
  notice($('scope-notice'), 'Example loaded. Preview to calculate five pages and the unpriced checkout.');
});

addBaseline(); addChange();
refreshHistory().catch((error) => notice($('scope-notice'), `Could not load draft history: ${error.message}`, true));

function syncInferenceControls() {
  $('interpret-scope').disabled = busy || !inferenceConfigured || !$('scope-inference-consent').checked;
}
$('scope-inference-consent').addEventListener('change', syncInferenceControls);
$('client-message').addEventListener('input', markDirty);
$('interpret-scope').addEventListener('click', async () => {
  if (busy || !inferenceConfigured || !$('scope-inference-consent').checked) return;
  const version = inputVersion;
  openRequest += 1;
  try {
    const quote = quoteInput();
    busy = true; syncInferenceControls();
    $('preview-scope').disabled = true; $('save-scope').disabled = true; $('apply-interpretation').disabled = true;
    notice($('scope-notice'), 'Interpreting the selected quote fields and client message…');
    const result = await api('scope', 'interpret', { quote, requestId: form.elements.requestId.value.trim(),
      clientMessage: $('client-message').value, sources: { quoteSource: form.elements.quoteSource.value.trim(), changeSource: form.elements.changeSource.value.trim() }, consent: true });
    if (version !== inputVersion) { notice($('scope-notice'), 'Inputs changed during interpretation. Your edits were kept; interpret again to use them.'); return; }
    pendingInterpretation = { result, quote, version };
    const panel = $('scope-interpretation'); panel.hidden = false;
    panel.replaceChildren(node('p', `${result.inference.provider} / ${result.inference.model} · ${result.inference.liveInferenceVerified ? 'Live response recorded' : 'Live inference not verified; fixture or unverified transport'}`, 'status'));
    panel.append(node('p', 'Review every suggestion and its literal message citation. Citation matching does not verify the interpretation.', 'muted'));
    for (const [index, change] of result.proposedChanges.entries()) panel.append(node('p', `${change.action}: ${change.description ?? change.itemId}${change.quantity ? ` · quantity ${change.quantity}` : ''}${change.action === 'add' ? ' · price unresolved' : ''}`), node('blockquote', result.citations[index].quote));
    for (const question of result.questions) panel.append(node('p', `Clarify: ${question}`));
    $('apply-interpretation').disabled = !result.suggestedRequest;
    notice($('scope-notice'), result.suggestedRequest ? 'Suggestion ready for your review. Use it to populate the structured editor, then preview and save.' : 'Clarification is needed. Update the message before interpreting again.');
  } catch (error) { if (version === inputVersion) notice($('scope-notice'), error.message, true); }
  finally {
    busy = false; $('scope-inference-consent').checked = false;
    $('preview-scope').disabled = false; $('save-scope').disabled = false; syncInferenceControls();
  }
});
$('apply-interpretation').addEventListener('click', () => {
  if (!pendingInterpretation || pendingInterpretation.version !== inputVersion || !pendingInterpretation.result.suggestedRequest) return;
  const { result, quote } = pendingInterpretation;
  changeRows.length = 0; $('scope-changes').replaceChildren(); result.suggestedRequest.changes.forEach(addChange);
  form.elements.requestId.value = result.suggestedRequest.id;
  if (!form.elements.title.value.trim()) form.elements.title.value = `${quote.id} revision`;
  markDirty();
  activeInterpretationId = result.id; interpretationBaseline = JSON.stringify(quote);
  notice($('scope-notice'), 'Reviewed suggestions loaded. Added items remain unpriced; review the fields, then preview or save.');
});
api('inference', 'status').then((status) => {
  inferenceConfigured = status.configured;
  $('scope-provider').textContent = status.configured ? `Destination: ${status.provider} · ${status.endpoint}. Model: ${status.model ?? 'NVIDIA Nemotron, selected when you request inference'}.` : 'Nemotron inference is not configured. You can continue using the manual editor.';
  syncInferenceControls();
}).catch(() => { $('scope-provider').textContent = 'Inference destination is unavailable. Reload before sending any content.'; });
