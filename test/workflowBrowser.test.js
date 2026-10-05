import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nebius-sol-ui-'));
  let browser;
  const running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data') });
  t.after(async () => { await browser?.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, timeout: 15000,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return { page, url: running.url };
}

test('Scope mobile navigation preserves inputs and distinguishes editing, preview, and saved versions', { timeout: 45000 }, async (t) => {
  const { page, url } = await fixture(t);
  await page.goto(url + '/scope');
  t.diagnostic('Scope browser launched and workspace loaded.');
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await page.locator('#scope-input-state').getByText('Unsaved edits · preview needed', { exact: true }).waitFor();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => Number.parseFloat(document.querySelector('#scope-main').style.getPropertyValue('--scope-nav-height'))
      === Math.ceil(document.querySelector('.scope-workspace-bar').getBoundingClientRect().height));
    for (const [label, id] of [['Saved drafts', 'history-heading'], ['Review', 'preview-heading'], ['Edit quote', 'editor-heading']]) {
      await page.getByRole('link', { name: label, exact: true }).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
      assert.equal(await page.evaluate((id) => document.getElementById(id).getBoundingClientRect().top >= document.querySelector('.scope-workspace-bar').getBoundingClientRect().bottom, id), true,
        `${width}px: focused ${id} must remain below the sticky navigation`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  t.diagnostic('Scope navigation and heading visibility completed at 320, 390, and 1440 pixels.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.waitForFunction(() => Number.parseFloat(document.querySelector('#scope-main').style.getPropertyValue('--scope-nav-height'))
    === Math.ceil(document.querySelector('.scope-workspace-bar').getBoundingClientRect().height));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'preview-heading');
  await page.getByRole('link', { name: 'Edit quote', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'editor-heading');
  assert.equal(await page.getByLabel('Draft title').inputValue(), 'Synthetic website expansion');
  await page.getByRole('button', { name: 'Preview revision', exact: true }).click();
  await page.locator('#scope-input-state').getByText('Current preview · unsaved', { exact: true }).waitFor();
  t.diagnostic('Scope current-input preview completed.');
  await page.getByRole('button', { name: 'Save new draft', exact: true }).click();
  await page.locator('#scope-input-state').getByText(/Saved version · /).waitFor();
  t.diagnostic('Scope first new draft save completed.');
  const firstState = await page.locator('#scope-input-state').textContent();
  await page.getByRole('link', { name: 'Saved drafts', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'history-heading');
  await page.getByLabel('Draft title').fill('Second owner version');
  assert.equal(await page.locator('#scope-input-state').textContent(), 'Unsaved edits · preview needed');
  assert.equal(await page.getByRole('button', { name: 'Download JSON', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Save new draft', exact: true }).click();
  await page.locator('#scope-input-state').getByText(/Saved version · /).waitFor();
  t.diagnostic('Scope second new draft save completed.');
  assert.notEqual(await page.locator('#scope-input-state').textContent(), firstState);
  await page.waitForFunction(() => document.querySelectorAll('#scope-history button').length === 2);
  await page.getByRole('link', { name: 'Edit quote', exact: true }).click();
  await page.getByLabel('Draft title').fill('');
  await page.getByRole('button', { name: 'Preview revision', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'draft-title');
  assert.equal(await page.locator('#scope-input-state').textContent(), 'Unsaved edits · preview needed');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
