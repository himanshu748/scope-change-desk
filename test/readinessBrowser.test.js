import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';

async function browserFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nebius-readiness-'));
  let running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data'), ...options });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  t.after(async () => { await browser.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  return { root, page, url: running.url, restart: async () => {
    const port = Number(new URL(running.url).port);
    await running.close();
    running = await startDeskServer({ port, workspaceRoot: root, dataRoot: path.join(root, 'data'), ...options });
  } };
}

test('Scope invalidates send consent after quote, message, or example changes', { timeout: 45000 }, async (t) => {
  let calls = 0;
  const { page, url } = await browserFixture(t, { inferenceRuntime: {
    status: () => ({ configured: true, provider: 'test-fixture', endpoint: 'local fixture', model: 'nvidia/fixture' }),
    handle: async () => ({ configured: true, provider: 'test-fixture', endpoint: 'local fixture', model: 'nvidia/fixture' }),
    generate: async () => { calls++; assert.fail('Consent invalidation must prevent inference.'); },
  } });
  await page.goto(url + '/scope');
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await page.getByLabel('Client change message').fill('Please add checkout.');
  await page.waitForFunction(() => document.querySelector('#scope-provider').textContent.includes('Destination'));
  for (const edit of [
    () => page.getByLabel('Draft title').fill('Changed owner title'),
    () => page.getByLabel('Client change message').fill('A different message with private data'),
    () => page.locator('#baseline-items').getByLabel('Description', { exact: true }).fill('New baseline description'),
    () => page.getByRole('button', { name: 'Load synthetic example' }).click(),
  ]) {
    await page.locator('#scope-inference-consent').check();
    assert.equal(await page.locator('#interpret-scope').isEnabled(), true);
    await edit();
    assert.equal(await page.locator('#scope-inference-consent').isChecked(), false);
    assert.equal(await page.locator('#interpret-scope').isDisabled(), true);
  }
  assert.equal(calls, 0);
});

test('server restart preserves editor inputs, renews the next session, and never retries a write automatically', { timeout: 45000 }, async (t) => {
  const { page, url, restart } = await browserFixture(t);
  await page.goto(url + '/scope');
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await page.getByRole('button', { name: 'Preview revision' }).click();
  await page.locator('#scope-notice').getByText('Preview recalculated from your structured inputs.', { exact: true }).waitFor();
  await page.getByLabel('Draft title').fill('Keep my unsaved revision');
  await restart();
  let saves = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/scope/save')) saves++; });
  await page.getByRole('button', { name: 'Save new draft' }).click();
  await page.locator('#scope-notice').getByText(/session.*changed/i).waitFor();
  assert.equal(await page.getByLabel('Draft title').inputValue(), 'Keep my unsaved revision');
  assert.equal(saves, 1, 'A refused save must not be automatically repeated');
  await page.getByRole('button', { name: 'Refresh history' }).click();
  await page.locator('#scope-history').getByText(/No drafts saved yet/).waitFor();
  await page.getByRole('button', { name: 'Save new draft' }).click();
  await page.locator('#scope-notice').getByText('New local draft saved. The quote and requested changes are preserved with it.', { exact: true }).waitFor();
  assert.equal(saves, 2);
  // The save notice precedes the asynchronous history refresh.
  await page.locator('#scope-history').getByRole('button', { name: /^Open draft / }).waitFor();
  assert.equal(await page.locator('#scope-history button').count(), 1);
});

test('Scope reopening a saved draft invalidates approval of the previously displayed quote', { timeout: 60000 }, async (t) => {
  let calls = 0;
  const status = { configured: true, provider: 'test-fixture', model: 'nvidia/fixture' };
  const { page, url } = await browserFixture(t, { inferenceRuntime: {
    status: () => status, handle: async () => status,
    generate: async () => { calls++; assert.fail('Loading a draft must not inherit inference approval.'); },
  } });
  await page.goto(url + '/scope');
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await page.getByRole('button', { name: 'Save new draft' }).click();
  await page.locator('#scope-notice').getByText('New local draft saved. The quote and requested changes are preserved with it.', { exact: true }).waitFor();
  await page.getByLabel('Client change message').fill('Please add checkout.');
  const description = page.locator('#baseline-items').getByLabel('Description', { exact: true });
  await description.fill('A different quote that I reviewed');
  await page.waitForFunction(() => document.querySelector('#scope-provider').textContent.includes('Destination'));
  await page.locator('#scope-inference-consent').check();
  assert.equal(await page.locator('#interpret-scope').isEnabled(), true);
  await page.getByRole('button', { name: /Open draft Synthetic website expansion/ }).click();
  await page.locator('#scope-notice').getByText('Saved draft opened.', { exact: true }).waitFor();
  assert.equal(await description.inputValue(), 'Website pages');
  assert.equal(await page.locator('#scope-inference-consent').isChecked(), false);
  assert.equal(await page.locator('#interpret-scope').isDisabled(), true);
  assert.equal(calls, 0);
});
