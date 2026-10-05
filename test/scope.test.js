import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createRevision, formatMoney, renderRevision } from '../src/scope/core.js';
import { writeScopeRevision } from '../src/scope/files.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/scope/cli.js', import.meta.url));

function quote() {
  return { version: 1, id: 'website-01', currency: 'USD', minorUnitDigits: 2,
    items: [{ id: 'pages', description: 'Website pages', quantity: 3, unitRateMinor: 20000, rateApprovalRef: 'Synthetic agreed quote, line 1' }],
    agreedDeadline: { text: 'September 30, 2026', sourceRef: 'Synthetic agreed quote, deadline paragraph' } };
}

function request() {
  return { version: 1, id: 'change-01', quoteId: 'website-01',
    changes: [{ action: 'set_quantity', itemId: 'pages', quantity: 5, sourceRef: 'Synthetic client email: please make this five pages' }],
    deadlineQuestions: ['Can the expanded scope meet the original deadline?'] };
}

function checkout() {
  return { action: 'add', itemId: 'checkout', description: 'Checkout feature', quantity: 1, unitRateMinor: null,
    pricingQuestion: 'What unit rate has been approved for checkout?', sourceRef: 'Synthetic client email: add checkout' };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scope-desk-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quotePath = path.join(root, 'quote.json');
  const changesPath = path.join(root, 'changes.json');
  await writeFile(quotePath, JSON.stringify(quote()));
  await writeFile(changesPath, JSON.stringify(request()));
  return { root, quotePath, changesPath, outputPath: path.join(root, 'revision.md') };
}

test('page quantities use supplied rates and exact known delta', () => {
  const revision = createRevision(quote(), request());
  assert.equal(revision.originalTotalMinor, 60000);
  assert.equal(revision.knownSubtotalMinor, 100000);
  assert.equal(revision.knownDeltaMinor, 40000);
  assert.equal(revision.totalMinor, 100000);
  assert.equal(revision.deltaMinor, 40000);
  assert.equal(revision.revisedItems[0].quantity, 5);
  assert.equal(revision.revisedItems[0].unitRateMinor, 20000);
  assert.equal(revision.scheduleStatus, 'not_validated');
  assert.equal(revision.clientApproval, 'not_recorded');
});

test('unpriced checkout leaves full total unresolved while preserving known page delta', () => {
  const changes = request();
  changes.changes.push(checkout());
  const revision = createRevision(quote(), changes);
  assert.equal(revision.knownDeltaMinor, 40000);
  assert.equal(revision.knownSubtotalMinor, 100000);
  assert.equal(revision.totalMinor, null);
  assert.equal(revision.deltaMinor, null);
  assert.equal(revision.pricingResolved, false);
  assert.deepEqual(revision.pricingQuestions, [{ itemId: 'checkout', question: 'What unit rate has been approved for checkout?' }]);
  assert.equal(revision.revisedItems[1].unitRateMinor, null);
  assert.equal(revision.revisedItems[1].amountMinor, null);
  const artifact = renderRevision(revision, { quoteSource: 'quote.json', changeSource: 'changes.json' });
  assert.match(artifact, /Full revised total \| Unresolved/);
  assert.match(artifact, /unknown rate is never treated as zero/);
  assert.match(artifact, /Synthetic client email: add checkout/);
  assert.match(artifact, /Can the expanded scope meet the original deadline/);
  assert.match(artifact, /Client approval has not been recorded/);
});

test('omitted added rate stays unpriced and cannot guess a rate or question', () => {
  const changes = request();
  const line = checkout();
  delete line.unitRateMinor;
  changes.changes.push(line);
  assert.equal(createRevision(quote(), changes).totalMinor, null);
  delete line.pricingQuestion;
  assert.throws(() => createRevision(quote(), changes), /Unresolved pricing question/);
});

test('add and remove operations reconcile scope using explicit rates', () => {
  const changes = request();
  changes.changes = [{ action: 'remove', itemId: 'pages', sourceRef: 'Synthetic request: remove pages' },
    { action: 'add', itemId: 'landing', description: 'Single landing page', quantity: 1, unitRateMinor: 30000, rateApprovalRef: 'Synthetic rate approval', sourceRef: 'Synthetic request: use landing page' }];
  const revision = createRevision(quote(), changes);
  assert.equal(revision.totalMinor, 30000);
  assert.equal(revision.deltaMinor, -30000);
  assert.deepEqual(revision.revisedItems.map((item) => item.id), ['landing']);
  assert.equal(revision.changes[0].after, null);
});

test('explicitly approved zero-rate additions are distinct from missing pricing', () => {
  const changes = request();
  changes.changes.push({ action: 'add', itemId: 'review', description: 'Courtesy review', quantity: 1, unitRateMinor: 0, rateApprovalRef: 'Synthetic explicit no-charge approval', sourceRef: 'Synthetic request' });
  assert.equal(createRevision(quote(), changes).pricingResolved, true);
  delete changes.changes[1].rateApprovalRef;
  assert.throws(() => createRevision(quote(), changes), /approval reference/);
});

test('input objects remain untouched and retain the original agreed quantities', () => {
  const original = quote();
  const changes = request();
  const savedQuote = JSON.stringify(original);
  const savedChanges = JSON.stringify(changes);
  const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(original);
  freeze(changes);
  const revision = createRevision(original, changes);
  assert.equal(JSON.stringify(original), savedQuote);
  assert.equal(JSON.stringify(changes), savedChanges);
  assert.equal(revision.originalItems[0].quantity, 3);
  assert.equal(revision.revisedItems[0].quantity, 5);
});

test('negative, fractional, unsafe, string, and nonfinite numeric values are refused', () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '5', null]) {
    const changes = request();
    changes.changes[0].quantity = invalid;
    assert.throws(() => createRevision(quote(), changes), /safe integer/);
    const original = quote();
    original.items[0].unitRateMinor = invalid;
    assert.throws(() => createRevision(original, request()), /safe integer/);
  }
});

test('line multiplication and accumulated total overflow are refused', () => {
  const original = quote();
  original.items[0].unitRateMinor = Number.MAX_SAFE_INTEGER;
  assert.throws(() => createRevision(original, request()), /safe integer limits/);
  original.items[0].quantity = 1;
  original.items.push({ id: 'extra', description: 'Extra item', quantity: 1, unitRateMinor: 1, rateApprovalRef: 'Synthetic approval' });
  assert.throws(() => createRevision(original, request()), /safe integer limits/);
  const changed = request();
  changed.changes[0].quantity = Number.MAX_SAFE_INTEGER;
  assert.throws(() => createRevision(quote(), changed), /safe integer limits/);
});

test('money formatting preserves exact minor units near the safe-integer boundary', () => {
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER, 'USD', 2), 'USD 90071992547409.91');
  assert.equal(formatMoney(-30000, 'USD', 2), '-USD 300.00');
  assert.equal(formatMoney(123, 'JPY', 0), 'JPY 123');
});

test('missing source references, ambiguous duplicate changes, and unsupported totals are refused', () => {
  const changes = request();
  delete changes.changes[0].sourceRef;
  assert.throws(() => createRevision(quote(), changes), /source reference/);
  changes.changes = [...request().changes, ...request().changes];
  assert.throws(() => createRevision(quote(), changes), /Only one change per item/);
  const original = quote();
  original.taxPercent = 10;
  assert.throws(() => createRevision(original, request()), /Unsupported quote field/);
  const invalidChange = request();
  invalidChange.changes[0].unitRateMinor = 1;
  assert.throws(() => createRevision(quote(), invalidChange), /Unsupported set_quantity change field/);
});

test('unknown item and wrong quote references cannot silently change another scope', () => {
  const changes = request();
  changes.quoteId = 'another-quote';
  assert.throws(() => createRevision(quote(), changes), /different quote/);
  changes.quoteId = 'website-01';
  changes.changes[0].itemId = 'unknown';
  assert.throws(() => createRevision(quote(), changes), /missing item/);
});

test('file workflow preserves both source documents and refuses existing outputs', async (t) => {
  const files = await fixture(t);
  const quoteBytes = await readFile(files.quotePath);
  const changesBytes = await readFile(files.changesPath);
  const receipt = await writeScopeRevision(files);
  assert.equal(receipt.status, 'draft_created');
  const artifact = await readFile(files.outputPath);
  assert.match(artifact.toString(), /Known price delta \| USD 400\.00/);
  await assert.rejects(writeScopeRevision(files), /Refusing to overwrite/);
  await assert.rejects(writeScopeRevision({ ...files, outputPath: files.quotePath }), /Refusing to overwrite/);
  assert.deepEqual(await readFile(files.quotePath), quoteBytes);
  assert.deepEqual(await readFile(files.changesPath), changesBytes);
  assert.deepEqual(await readFile(files.outputPath), artifact);
});

test('CLI creates a real reviewable draft and reports unresolved totals', async (t) => {
  const files = await fixture(t);
  const changes = request();
  changes.changes.push(checkout());
  await writeFile(files.changesPath, JSON.stringify(changes));
  const result = await run(process.execPath, [cli, 'revise', '--quote', files.quotePath, '--changes', files.changesPath, '--out', files.outputPath]);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.totalMinor, null);
  assert.equal(receipt.unresolvedPricingCount, 1);
  assert.equal(receipt.clientApproval, 'not_recorded');
  assert.match(await readFile(files.outputPath, 'utf8'), /Checkout feature/);
  assert.match((await run(process.execPath, [cli, '--help'])).stdout, /MANUALLY STRUCTURED/);
});
