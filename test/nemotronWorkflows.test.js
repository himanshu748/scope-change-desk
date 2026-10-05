import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createScopeService } from '../src/scope/service.js';
import { createInferenceRuntime } from '../src/integrations/runtime.js';

const inference = { provider: 'fixture-nebius', model: 'fixture-nemotron', responseModel: 'fixture-nemotron', responseId: 'fixture-response',
  startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:01.000Z', requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64), usage: {}, liveInferenceVerified: false, transport: 'fixture' };
function scopeInput() {
  return { consent: true, requestId: 'client-change', clientMessage: 'Please make this five pages and add checkout.',
    sources: { quoteSource: 'Private signed quote reference', changeSource: 'Owner-provided client email' },
    quote: { version: 1, id: 'website', currency: 'USD', minorUnitDigits: 2,
      items: [{ id: 'pages', description: 'Website pages', quantity: 3, unitRateMinor: 20000, rateApprovalRef: 'Private approval reference' }] } };
}
function scopeValue() {
  return { questions: [], changes: [
    { action: 'set_quantity', itemId: 'pages', description: null, quantity: 5, citation: 'make this five pages', pricingQuestion: null },
    { action: 'add', itemId: null, description: 'Checkout', quantity: 1, citation: 'add checkout', pricingQuestion: 'What rate should the owner agree for checkout?' },
  ] };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nemotron-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  return { root, dataRoot };
}

test('scope interprets cited changes, excludes financial references, and persists honest review provenance', async (t) => {
  const { dataRoot } = await fixture(t);
  const calls = [];
  const service = await createScopeService({ dataRoot, inferenceRuntime: { async generate(request) { calls.push(request); return { value: scopeValue(), inference }; } } });
  const input = scopeInput();
  const interpreted = await service.handle('interpret', input);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].input).sort(), ['baselineItems', 'clientMessage']);
  assert.deepEqual(calls[0].input.baselineItems, [{ id: 'pages', description: 'Website pages', quantity: 3 }]);
  assert.doesNotMatch(JSON.stringify(calls[0].input), /Private|20000|approval/i);
  assert.equal(interpreted.revision.knownSubtotalMinor, 100000);
  assert.equal(interpreted.revision.totalMinor, null);
  assert.equal(interpreted.suggestedRequest.changes[1].unitRateMinor, null);
  assert.equal(interpreted.inference.liveInferenceVerified, false);
  assert.equal(interpreted.citations[0].quote, input.clientMessage.slice(interpreted.citations[0].start, interpreted.citations[0].end));
  const saved = await service.handle('save', { title: 'Reviewed model suggestion', quote: input.quote, request: interpreted.suggestedRequest, sources: input.sources, interpretationId: interpreted.id });
  assert.equal(saved.revision.clientApproval, 'not_recorded');
  assert.equal(saved.revision.scheduleStatus, 'not_validated');
  assert.equal(saved.interpretation.editedSinceInterpretation, false);
  assert.match(saved.markdown, /model suggestion/);
  assert.match(saved.markdown, /Live inference was not verified/);
  assert.doesNotMatch(saved.markdown, /No model interpreted/);
  const restarted = await createScopeService({ dataRoot });
  assert.deepEqual(await restarted.handle('detail', { id: saved.id }), saved);
  assert.deepEqual(await restarted.handle('interpretation', { id: interpreted.id }), interpreted);
  const revised = structuredClone(interpreted.suggestedRequest);
  revised.changes[0].quantity = 6;
  const edited = await restarted.handle('save', { quote: input.quote, request: revised, sources: input.sources, interpretationId: interpreted.id });
  assert.equal(edited.interpretation.editedSinceInterpretation, true);
  assert.equal(edited.revision.knownSubtotalMinor, 120000);
});

test('scope requires consent and refuses invented rates, ungrounded citations, and ambiguous invalid changes', async (t) => {
  const { dataRoot } = await fixture(t);
  let response = scopeValue(); let calls = 0;
  const service = await createScopeService({ dataRoot, inferenceRuntime: { async generate() { calls++; return { value: response, inference }; } } });
  await assert.rejects(service.handle('interpret', { ...scopeInput(), consent: false }), /consent/);
  assert.equal(calls, 0);
  for (const mutate of [
    (value) => { value.changes[1].unitRateMinor = 0; },
    (value) => { value.changes[0].citation = 'invented client text'; },
    (value) => { value.changes[0].itemId = 'not-in-quote'; },
    (value) => { value.changes[0].quantity = null; },
    (value) => { value.clientApproval = true; },
  ]) { response = scopeValue(); mutate(response); await assert.rejects(service.handle('interpret', scopeInput())); }
  response = { changes: [], questions: ['How many pages should the revised quote contain?'] };
  const clarification = await service.handle('interpret', scopeInput());
  assert.equal(clarification.status, 'needs_clarification');
  assert.equal(clarification.suggestedRequest, null);
  assert.equal(clarification.revision, null);
  const local = await createScopeService({ dataRoot });
  await assert.rejects(local.handle('interpret', scopeInput()), /not configured/);
  assert.deepEqual((await local.handle('list')).records, []);
});
