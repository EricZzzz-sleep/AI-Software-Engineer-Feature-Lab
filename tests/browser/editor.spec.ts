import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, chromium, type Page } from '@playwright/test';
async function login(page: Page, actor = 'maya') {
  await page.goto('/');
  await page.getByLabel('Test session').selectOption(actor);
  await expect(page.locator('#editor')).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixtures', { data: { scenario: 'default' } });
});

test('explicit save, dirty explanations and failed save preserve text', async ({ page }) => {
  await login(page);
  await expect(page.locator('#generate-reason')).toHaveText('Generation is not configured');
  await page.getByLabel('Draft text').fill('Local draft to preserve');
  await expect(page.locator('#generate-reason')).toHaveText('Save your changes before generating');
  await page.route('**/api/campaigns/launch', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary save failure. Your text has been kept.' }) }) : route.continue());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Save failed');
  await expect(page.getByLabel('Draft text')).toHaveValue('Local draft to preserve');
  await page.unroute('**/api/campaigns/launch');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#saved')).toHaveText('Saved v2');
  await page.reload();
  await expect(page.getByLabel('Draft text')).toHaveValue('Local draft to preserve');
});

test('publisher reviews and publishes, dialog keyboard focus returns, edits invalidate review', async ({ page }) => {
  await login(page, 'ren');
  const review = page.getByRole('button', { name: 'Review', exact: true });
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(review).toBeFocused();
  await review.click();
  await page.getByRole('button', { name: 'Confirm review' }).click();
  await expect(page.locator('#status')).toHaveText('Version 1 reviewed.');
  await expect(review).toBeFocused();
  await page.locator('#publish').click();
  await page.locator('#dialog-confirm').click();
  await expect(page.locator('#status')).toHaveText('Version 1 published.');
  await page.getByRole('button', { name: 'View published v1' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#dialog-content')).toContainText('Bring your team together');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'View published v1' })).toBeFocused();
  await page.getByLabel('Draft text').fill('Revised copy');
  await expect(page.locator('#review')).toBeDisabled();
  await expect(page.locator('#publish')).toBeDisabled();
  await page.locator('#save').click();
  await expect(page.locator('#saved')).toHaveText('Saved v2');
  await expect(page.locator('#publish')).toBeDisabled();
});

test('viewer is read-only, Priya sees only B, switching asks before discarding', async ({ page }) => {
  await login(page);
  await page.getByLabel('Draft text').fill('Do not discard');
  await page.getByLabel('Test session').selectOption('evan');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Draft text')).toHaveValue('Do not discard');
  await expect(page.getByLabel('Test session')).toHaveValue('maya');
  await page.getByLabel('Test session').selectOption('evan');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByLabel('Draft text')).toHaveAttribute('readonly', '');
  for (const id of ['save', 'generate', 'review', 'publish']) await expect(page.locator('#' + id)).toBeDisabled();
  await page.getByLabel('Test session').selectOption('priya');
  await expect(page.locator('#title')).toContainText('Workspace B campaign');
  await expect(page.locator('#title')).not.toContainText('Team scheduling launch');
});

test('conflicts preserve text and explicit reload requires confirmation', async ({ page, request }) => {
  await login(page);
  await page.getByLabel('Draft text').fill('My unsaved text');
  const session = await (await request.post('/__test/session', { data: { actorId: 'ren' } })).json();
  await request.put('/api/campaigns/launch', { headers: { Authorization: `Bearer ${session.token}` }, data: { expectedVersion: 1, goal: 'Changed elsewhere', facts: '', tone: '', draft: 'Server version' } });
  await page.locator('#save').click();
  await expect(page.locator('#status')).toContainText('changed on the server');
  await expect(page.getByLabel('Draft text')).toHaveValue('My unsaved text');
  await page.locator('#reload').click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Draft text')).toHaveValue('My unsaved text');
  await page.locator('#reload').click();
  await page.locator('#dialog-confirm').click();
  await expect(page.getByLabel('Draft text')).toHaveValue('Server version');
});

test('session renewal preserves dirty text', async ({ page }) => {
  await login(page);
  await page.getByLabel('Draft text').fill('Keep after expiry');
  await page.route('**/api/campaigns/launch', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired. Sign in again; your text has been kept.' }) }) : route.continue());
  await page.locator('#save').click();
  await expect(page.locator('#status')).toContainText('Session expired');
  await page.unroute('**/api/campaigns/launch');
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page.locator('#status')).toContainText('Your local text has been kept');
  await expect(page.getByLabel('Draft text')).toHaveValue('Keep after expiry');
  await page.locator('#save').click();
  await expect(page.locator('#saved')).toHaveText('Saved v2');
});

for (const width of [1440, 960, 959, 390, 720]) {
  test(`responsive layout and usable controls at ${width}px`, async ({ page }) => {
    // 720 CSS px is the effective viewport of a 1440px browser at 200% zoom.
    await page.setViewportSize({ width, height: 1000 });
    await login(page, 'ren');
    const brief = await page.locator('.panes > section').nth(0).boundingBox();
    const draft = await page.locator('.panes > section').nth(1).boundingBox();
    expect(brief).not.toBeNull(); expect(draft).not.toBeNull();
    if (width >= 960) { expect(brief!.y).toBe(draft!.y); expect(Math.abs(brief!.width - draft!.width)).toBeLessThan(1); }
    else expect(draft!.y).toBeGreaterThan(brief!.y + brief!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const id of ['save', 'generate', 'review', 'publish', 'goal', 'facts', 'tone', 'draft']) {
      expect((await page.locator('#' + id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    if (width === 1440 || width === 390) await page.screenshot({ path: `test-results/editor-${width}.png`, fullPage: true });
  });
}

test('keyboard order, focus visibility and live status', async ({ page }) => {
  await login(page, 'ren');
  await page.getByLabel('Goal + audience').focus();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('Source facts')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('Tone', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('Draft text')).toBeFocused();
  const outline = await page.getByLabel('Draft text').evaluate(el => getComputedStyle(el).outlineWidth);
  expect(outline).toBe('3px');
  await expect(page.locator('#status')).toHaveAttribute('aria-live', 'polite');
});


test('actual 200% browser zoom reflows the editor without overflow', async () => {
  const extension = mkdtempSync(join(tmpdir(), 'campaign-zoom-'));
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Local zoom verification', version: '1.0',
    permissions: ['tabs'], background: { service_worker: 'worker.js' },
  }));
  writeFileSync(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1440,1000'],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3199');
    await page.getByLabel('Test session').selectOption('ren');
    await expect(page.locator('#editor')).toBeVisible();
    const zoom = await worker.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => t.url.startsWith('http://127.0.0.1:3199'));
      await chrome.tabs.setZoom(tab.id, 2);
      return await chrome.tabs.getZoom(tab.id);
    })()`);
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(720);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const panels = page.locator('.panes > section');
    expect((await panels.nth(1).boundingBox())!.y).toBeGreaterThan((await panels.nth(0).boundingBox())!.y);
    await page.locator('#review').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm review' }).click();
    await expect(page.locator('#status')).toContainText('reviewed');
    await page.screenshot({ path: 'test-results/editor-zoom-200.png' });
  } finally { await context.close(); rmSync(extension, { recursive: true, force: true }); }
});
