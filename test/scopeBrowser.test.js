import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('scope browser edits, recalculates, preserves versions, and downloads the saved draft', { timeout: 60000 }, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'scope-browser-'));
  const running = await startDeskServer({ port: 0, workspaceRoot, dataRoot: path.join(workspaceRoot, 'data') });
  let browser;
  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const notice = page.locator('#scope-notice');
  const preview = page.locator('#scope-preview');
  async function assertPreviewRevealed() {
    assert.equal(await page.evaluate(() => document.activeElement.id), 'preview-heading');
    const heading = await page.locator('#preview-heading').boundingBox();
    assert.ok(heading.y >= 0 && heading.y + heading.height <= 844, 'Mobile result heading must be in view after success');
  }
  await page.goto(running.url + '/scope');
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await page.getByRole('button', { name: 'Preview revision' }).click();
  await notice.getByText('Preview recalculated from your structured inputs.', { exact: true }).waitFor();
  await assertPreviewRevealed();
  assert.match(await preview.textContent(), /Original quoteUSD 600\.00/);
  assert.match(await preview.textContent(), /Known revised subtotalUSD 1000\.00/);
  assert.match(await preview.textContent(), /Full revised totalUnresolved/);
  assert.equal(await page.getByRole('button', { name: 'Download JSON' }).isDisabled(), true);

  const changes = page.locator('#scope-changes > fieldset');
  await changes.nth(1).getByLabel('Pricing', { exact: true }).selectOption('priced');
  assert.equal(await notice.isVisible(), false, 'Editing must clear the previous calculation status');
  await changes.nth(1).getByLabel('Unit price', { exact: true }).fill('350.00');
  await changes.nth(1).getByLabel('Provided rate approval reference').fill('Synthetic checkout rate supplied by owner');
  await page.getByRole('button', { name: 'Preview revision' }).click();
  await preview.getByRole('row').filter({ hasText: 'Full revised total' }).getByRole('cell', { name: 'USD 1350.00', exact: true }).waitFor();
  await notice.getByText('Preview recalculated from your structured inputs.', { exact: true }).waitFor();
  assert.match(await preview.textContent(), /Full revised totalUSD 1350\.00/);
  assert.match(await preview.textContent(), /Full price deltaUSD 750\.00/);

  const injected = '<img src=x onerror="window.scopeInjected=true">';
  const quoteDescription = page.locator('#baseline-items').getByLabel('Description', { exact: true });
  await quoteDescription.fill(injected);
  await page.getByRole('button', { name: 'Preview revision' }).click();
  await preview.getByRole('cell', { name: injected, exact: true }).waitFor();
  await notice.getByText('Preview recalculated from your structured inputs.', { exact: true }).waitFor();
  assert.ok((await preview.textContent()).includes(injected));
  assert.equal(await preview.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.scopeInjected), undefined);
  await quoteDescription.fill('Website pages');
  await changes.nth(1).getByLabel('Unit price', { exact: true }).fill('350.001');
  await page.getByRole('button', { name: 'Preview revision' }).click();
  await notice.getByText('Unit prices must be nonnegative amounts with at most 2 decimal places.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'preview-scope', 'Validation errors must not move focus to stale results');
  assert.equal(await changes.nth(1).getByLabel('Unit price', { exact: true }).inputValue(), '350.001');
  assert.doesNotMatch(await preview.textContent(), /USD 1350\.00/);
  await changes.nth(1).getByLabel('Unit price', { exact: true }).fill('350.00');
  await page.getByRole('button', { name: 'Save new draft' }).click();
  await notice.getByText('New local draft saved. The quote and requested changes are preserved with it.', { exact: true }).waitFor();
  await assertPreviewRevealed();
  if (process.env.CAPTURE_REDESIGN === '1') {
    const out = path.resolve(process.env.CAPTURE_REVIEW_DIR ?? '.impeccable/review/redesign');
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'scope-app-mobile-result.png') });
  }
  await page.reload();
  await page.getByRole('button', { name: /Open draft Synthetic website expansion/ }).click();
  await notice.getByText('Saved draft opened.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Draft title').inputValue(), 'Synthetic website expansion');
  assert.match(await preview.textContent(), /Full revised totalUSD 1350\.00/);

  const jsonPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const jsonDownload = await jsonPromise;
  const record = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  assert.equal(record.revision.totalMinor, 135000);
  assert.equal(record.quote.items[0].quantity, 3);
  assert.equal(record.request.changes[0].quantity, 5);
  assert.equal(record.revision.clientApproval, 'not_recorded');
  const markdownPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown' }).click();
  const markdownDownload = await markdownPromise;
  assert.equal(await readFile(await markdownDownload.path(), 'utf8'), record.markdown);

  const review = path.resolve('.impeccable/review/2026-09-29');
  await mkdir(review, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop body should not overflow');
  await page.screenshot({ path: path.join(review, 'scope-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile body should not overflow');
  await page.screenshot({ path: path.join(review, 'scope-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('delayed draft loads preserve newer edits, examples, and draft selections', { timeout: 60000 }, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'scope-browser-race-'));
  const running = await startDeskServer({ port: 0, workspaceRoot, dataRoot: path.join(workspaceRoot, 'data') });
  let browser;
  const gates = [];
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    await browser?.close();
    await running.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { token } = await (await page.request.get(running.url + '/api/session')).json();
  async function seed(title, quantity) {
    const response = await page.request.post(running.url + '/api/scope/save', {
      headers: { 'X-Session-Token': token },
      data: {
        title,
        quote: { version: 1, id: 'website', currency: 'USD', minorUnitDigits: 2,
          items: [{ id: 'pages', description: 'Website pages', quantity: 3, unitRateMinor: 20000, rateApprovalRef: 'Synthetic quote' }] },
        request: { version: 1, id: 'change', quoteId: 'website',
          changes: [{ action: 'set_quantity', itemId: 'pages', quantity, sourceRef: 'Synthetic request' }] },
        sources: { quoteSource: 'Synthetic quote', changeSource: 'Synthetic email' },
      },
    });
    assert.equal(response.status(), 200);
    return response.json();
  }
  const earlier = await seed('Earlier saved draft', 4);
  const newer = await seed('Newer saved draft', 7);
  let nextDelay = null;
  await page.route('**/api/scope/detail', async (route) => {
    const planned = nextDelay?.id === route.request().postDataJSON().id ? nextDelay : null;
    if (planned) nextDelay = null;
    const response = await route.fetch();
    if (planned) { planned.entered.resolve(); await planned.release.promise; }
    await route.fulfill({ response });
  });
  function delayNext(id) {
    const gate = { id, entered: deferred(), release: deferred() };
    gates.push(gate); nextDelay = gate; return gate;
  }
  async function waitForLoadToSettle(button) {
    const label = await button.getAttribute('aria-label');
    await page.waitForFunction((label) => [...document.querySelectorAll('#scope-history button')]
      .some((button) => button.getAttribute('aria-label') === label && !button.disabled), label);
  }
  await page.goto(running.url + '/scope');
  const earlierButton = page.getByRole('button', { name: `Open draft Earlier saved draft, ${earlier.id.slice(0, 8)}`, exact: true });
  const newerButton = page.getByRole('button', { name: `Open draft Newer saved draft, ${newer.id.slice(0, 8)}`, exact: true });
  const title = page.getByLabel('Draft title');

  const edited = delayNext(earlier.id);
  await earlierButton.click();
  await edited.entered.promise;
  await title.fill('Unsaved new work');
  edited.release.resolve();
  await waitForLoadToSettle(earlierButton);
  assert.equal(await title.inputValue(), 'Unsaved new work');
  assert.equal(await page.getByRole('button', { name: 'Download JSON' }).isDisabled(), true);

  const example = delayNext(earlier.id);
  await earlierButton.click();
  await example.entered.promise;
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  example.release.resolve();
  await waitForLoadToSettle(earlierButton);
  assert.equal(await title.inputValue(), 'Synthetic website expansion');
  assert.equal(await page.locator('#scope-changes > fieldset').count(), 2);
  assert.match(await page.locator('#example-note').textContent(), /Synthetic example loaded/);

  const superseded = delayNext(earlier.id);
  await earlierButton.click();
  await superseded.entered.promise;
  const latest = delayNext(newer.id);
  await newerButton.click();
  await latest.entered.promise;
  superseded.release.resolve();
  await waitForLoadToSettle(earlierButton);
  assert.equal(await title.inputValue(), 'Synthetic website expansion', 'an older response must not apply while the latest selection is still loading');
  latest.release.resolve();
  await page.locator('#scope-notice').getByText('Saved draft opened.', { exact: true }).waitFor();
  assert.equal(await title.inputValue(), 'Newer saved draft');
  assert.match(await page.locator('#scope-preview').textContent(), /Full revised totalUSD 1400\.00/);

  // A late calculation must neither replace newer inputs nor steal editing focus.
  await page.setViewportSize({ width: 390, height: 844 });
  const calculation = { entered: deferred(), release: deferred() };
  gates.push(calculation);
  await page.route('**/api/scope/preview', async (route) => {
    const response = await route.fetch();
    calculation.entered.resolve();
    await calculation.release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Preview revision' }).click();
  await calculation.entered.promise;
  await title.click();
  await title.fill('Newer edits during calculation');
  const beforeReply = await title.boundingBox();
  assert.ok(beforeReply.y >= 0 && beforeReply.y + beforeReply.height <= 844, 'The edited field must be in view before the delayed response');
  calculation.release.resolve();
  await page.locator('#scope-notice').getByText('Inputs changed during calculation. Preview again to calculate your newer edits.', { exact: true }).waitFor();
  assert.equal(await title.inputValue(), 'Newer edits during calculation');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'draft-title');
  const editingPosition = await title.boundingBox();
  assert.ok(editingPosition.y >= 0 && editingPosition.y + editingPosition.height <= 844, 'A stale calculation must leave the mobile editor in view');
  assert.match(await page.locator('#scope-preview').textContent(), /Inputs changed/);
  assert.deepEqual(errors, []);
});
