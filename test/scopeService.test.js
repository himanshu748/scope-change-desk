import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopeService } from '../src/scope/service.js';

function input() {
  return {
    title: 'Synthetic website expansion',
    quote: { version: 1, id: 'website', currency: 'USD', minorUnitDigits: 2,
      items: [{ id: 'pages', description: 'Website pages', quantity: 3, unitRateMinor: 20000, rateApprovalRef: 'Synthetic quote, line 1' }] },
    request: { version: 1, id: 'expansion', quoteId: 'website', changes: [
      { action: 'set_quantity', itemId: 'pages', quantity: 5, sourceRef: 'Synthetic email, paragraph 1' },
      { action: 'add', itemId: 'checkout', description: 'Checkout', quantity: 1, unitRateMinor: null, pricingQuestion: 'What is the agreed checkout rate?', sourceRef: 'Synthetic email, paragraph 2' },
    ], deadlineQuestions: ['Does the deadline need review?'] },
    sources: { quoteSource: 'Synthetic original quote', changeSource: 'Synthetic expansion email' },
  };
}

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'scope-service-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  return { dataRoot, service: await createScopeService({ dataRoot }) };
}

test('preview computes exact known amounts and keeps missing prices unresolved without saving', async (t) => {
  const { service } = await fixture(t);
  const original = input();
  const before = structuredClone(original);
  const { revision, markdown } = await service.handle('preview', original);
  assert.equal(revision.originalTotalMinor, 60000);
  assert.equal(revision.knownSubtotalMinor, 100000);
  assert.equal(revision.knownDeltaMinor, 40000);
  assert.equal(revision.totalMinor, null);
  assert.equal(revision.deltaMinor, null);
  assert.equal(revision.revisedItems[1].amountMinor, null);
  assert.equal(revision.scheduleStatus, 'not_validated');
  assert.equal(revision.clientApproval, 'not_recorded');
  assert.match(markdown, /Full revised total \| Unresolved/);
  assert.match(markdown, /Synthetic expansion email/);
  assert.deepEqual(original, before);
  assert.deepEqual(await service.handle('list'), { records: [] });
});

test('explicit zero is a resolved rate only with a supplied reference', async (t) => {
  const { service } = await fixture(t);
  const payload = input();
  const checkout = payload.request.changes[1];
  checkout.unitRateMinor = 0;
  checkout.rateApprovalRef = 'Synthetic no-charge approval';
  delete checkout.pricingQuestion;
  const { revision } = await service.handle('preview', payload);
  assert.equal(revision.totalMinor, 100000);
  assert.equal(revision.pricingResolved, true);
  assert.equal(revision.revisedItems[1].amountMinor, 0);
  delete checkout.rateApprovalRef;
  await assert.rejects(service.handle('preview', payload), /approval reference/);
});

test('saved inputs, document, and history survive service restart', async (t) => {
  const { dataRoot, service } = await fixture(t);
  const payload = input();
  const saved = await service.handle('save', payload);
  const restarted = await createScopeService({ dataRoot });
  const detail = await restarted.handle('detail', { id: saved.id });
  assert.deepEqual(detail, saved);
  assert.deepEqual(detail.quote, payload.quote);
  assert.deepEqual(detail.request, payload.request);
  const { records } = await restarted.handle('list');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, saved.id);
  assert.equal(records[0].totalMinor, null);
  const directory = path.join(dataRoot, 'scope', saved.id);
  assert.equal(await readFile(path.join(directory, 'draft.md'), 'utf8'), saved.markdown);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'quote.json'), 'utf8')), payload.quote);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')), payload.request);
  assert.deepEqual((await readdir(directory)).sort(), ['draft.md', 'quote.json', 'record.json', 'request.json']);
});

test('each save recomputes from its current inputs and never mutates an earlier version', async (t) => {
  const { dataRoot, service } = await fixture(t);
  const payload = input();
  await service.handle('preview', payload);
  const first = await service.handle('save', payload);
  const firstFile = await readFile(path.join(dataRoot, 'scope', first.id, 'record.json'), 'utf8');
  payload.request.changes[0].quantity = 7;
  const second = await service.handle('save', payload);
  assert.notEqual(first.id, second.id);
  assert.equal(second.revision.knownSubtotalMinor, 140000);
  assert.equal((await service.handle('detail', { id: first.id })).revision.knownSubtotalMinor, 100000);
  assert.equal(await readFile(path.join(dataRoot, 'scope', first.id, 'record.json'), 'utf8'), firstFile);
});

test('fabricated revision totals and unsupported fields cannot become saved truth', async (t) => {
  const { service } = await fixture(t);
  for (const addition of [{ revision: { totalMinor: 1 } }, { totalMinor: 1 }, { outputPath: '../quote.json' }, { id: 'overwrite' }]) {
    await assert.rejects(service.handle('save', { ...input(), ...addition }), /Unsupported scope input field/);
  }
  const payload = input();
  payload.quote.items[0].amountMinor = 1;
  await assert.rejects(service.handle('save', payload), /Unsupported quote item field/);
  assert.deepEqual(await service.handle('list'), { records: [] });
});

test('detail recalculates even if persisted derived totals have been modified', async (t) => {
  const { dataRoot, service } = await fixture(t);
  const saved = await service.handle('save', input());
  saved.revision.totalMinor = 1;
  saved.revision.knownSubtotalMinor = 1;
  saved.markdown = 'fabricated';
  await writeFile(path.join(dataRoot, 'scope', saved.id, 'record.json'), JSON.stringify(saved));
  const detail = await service.handle('detail', { id: saved.id });
  assert.equal(detail.revision.totalMinor, null);
  assert.equal(detail.revision.knownSubtotalMinor, 100000);
  assert.notEqual(detail.markdown, 'fabricated');
});

test('malformed numbers, missing sources, unsupported adjustments and unsafe identifiers are refused', async (t) => {
  const { service } = await fixture(t);
  const cases = [
    (p) => { p.quote.items[0].unitRateMinor = 1.2; },
    (p) => { p.quote.items[0].unitRateMinor = Number.MAX_SAFE_INTEGER; },
    (p) => { p.quote.items[0].quantity = '3'; },
    (p) => { p.request.changes[0].quantity = 0; },
    (p) => { p.request.changes[0].sourceRef = ''; },
    (p) => { p.request.changes[1].pricingQuestion = ''; },
    (p) => { p.sources.quoteSource = ''; },
    (p) => { p.request.quoteId = 'unrelated'; },
    (p) => { p.quote.discount = 10; },
    (p) => { p.request.changes.push({ ...p.request.changes[0] }); },
  ];
  for (const mutate of cases) { const payload = input(); mutate(payload); await assert.rejects(service.handle('save', payload)); }
  for (const payload of [null, [], 'quote', { ...input(), sources: null }]) await assert.rejects(service.handle('preview', payload));
  for (const id of ['../outside', '/tmp/outside', 'not-an-id']) await assert.rejects(service.handle('detail', { id }), /valid saved draft ID/);
  await assert.rejects(service.handle('detail', { id: '95a92fbd-6858-4eb8-9312-df6b9f9fd45b' }), /not found/);
  await assert.rejects(service.handle('list', { path: '/tmp' }), /Unsupported/);
  await assert.rejects(service.handle('approve', input()), /Unknown scope action/);
  assert.deepEqual(await service.handle('list'), { records: [] });
});

test('parallel saves receive unique immutable directories and complete records', async (t) => {
  const { service } = await fixture(t);
  const saved = await Promise.all(Array.from({ length: 12 }, (_, i) => service.handle('save', { ...input(), title: `Draft ${i}` })));
  assert.equal(new Set(saved.map((record) => record.id)).size, 12);
  const { records } = await service.handle('list');
  assert.equal(records.length, 12);
  for (const record of saved) assert.deepEqual(await service.handle('detail', { id: record.id }), record);
});

test('expanded records that exceed the reader limit are rejected before creating a directory', async (t) => {
  const { dataRoot, service } = await fixture(t);
  const existing = await service.handle('save', input());
  const payload = input();
  payload.quote.items = Array.from({ length: 100 }, (_, index) => ({
    id: `item-${index}`, description: '<'.repeat(500), quantity: 1, unitRateMinor: 100,
    rateApprovalRef: '<'.repeat(4000),
  }));
  payload.request.changes = payload.quote.items.map(({ id }) => ({
    action: 'set_quantity', itemId: id, quantity: 2, sourceRef: '<'.repeat(4000),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024 * 1024, 'the structured input itself is within its allowed limit');
  const preview = await service.handle('preview', payload);
  assert.ok(Buffer.byteLength(JSON.stringify(preview, null, 2)) > 5 * 1024 * 1024, 'escaped source references expand the saved record past its read limit');
  await assert.rejects(service.handle('save', payload), /exceed the 5 MiB storage limit/);
  assert.deepEqual(await readdir(path.join(dataRoot, 'scope')), [existing.id], 'failed save leaves no record or incomplete directory');
  const restarted = await createScopeService({ dataRoot });
  assert.equal((await restarted.handle('list')).records.length, 1);
  assert.deepEqual(await restarted.handle('detail', { id: existing.id }), existing);
});

test('removing original items and adding explicitly priced work produces a complete revision', async (t) => {
  const { service } = await fixture(t);
  const payload = input();
  payload.request.changes = [
    { action: 'remove', itemId: 'pages', sourceRef: 'Synthetic cancellation' },
    { action: 'add', itemId: 'landing', description: 'Landing page', quantity: 1, unitRateMinor: 35000, rateApprovalRef: 'Synthetic supplied rate', sourceRef: 'Synthetic replacement request' },
  ];
  const { revision } = await service.handle('save', payload);
  assert.equal(revision.totalMinor, 35000);
  assert.equal(revision.deltaMinor, -25000);
  assert.equal(revision.revisedItems.length, 1);
  assert.equal(revision.revisedItems[0].id, 'landing');
});
