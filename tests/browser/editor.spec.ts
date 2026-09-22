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
  await expect(page.locator('#generate-reason')).toContainText('Generate from the saved brief');
  await page.getByLabel('Draft text').fill('Local draft to preserve');
  await expect(page.locator('#generate-reason')).toContainText('Generate from the saved brief');
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
  await page.keyboard.press('Tab'); await expect(page.locator('#save')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#generate')).toBeFocused();
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

const briefFields = ['goal', 'facts', 'tone', 'draft'];
async function fillBrief(page: Page, suffix: string) {
  for (const key of briefFields) await page.locator('#' + key).fill(`${key} ${suffix}`);
}
async function expectBrief(page: Page, suffix: string) {
  for (const key of briefFields) await expect(page.locator('#' + key)).toHaveValue(`${key} ${suffix}`);
}

test('Ren selects and reviews historical versions while preserving unsaved editor input', async ({ page, request }) => {
  const session = await (await request.post('/__test/session', { data: { actorId: 'maya' } })).json();
  for (let version = 2; version <= 7; version++) await request.put('/api/campaigns/launch', {
    headers: { Authorization: `Bearer ${session.token}` },
    data: { expectedVersion: version - 1, goal: 'Goal', facts: 'Facts', tone: 'Friendly', draft: `Campaign draft revision ${version}.` },
  });
  await login(page, 'ren');
  await fillBrief(page, 'local input');
  await page.getByRole('tab', { name: 'Review versions' }).click();
  await expect(page.getByLabel('Version to review').locator('option')).toHaveCount(7);
  await expect(page.locator('#version-preview')).toContainText('Campaign draft revision 7.');
  await page.getByLabel('Version to review').selectOption('3');
  await expect(page.locator('#version-preview')).toContainText('Campaign draft revision 3.');
  await page.getByRole('button', { name: 'Review selected version' }).click();
  await expect(page.locator('#dialog-title')).toHaveText('Review saved v3');
  await page.getByRole('button', { name: 'Confirm review' }).click();
  await expect(page.locator('#versions-status')).toHaveText('Version 3 reviewed.');
  await expect(page.getByRole('button', { name: 'Review selected version' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Edit campaign' }).click();
  await expectBrief(page, 'local input');
  await expect(page.locator('#saved')).toHaveText('Unsaved · v7');
  await page.locator('#reload').click(); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#publish')).toBeDisabled();
  await page.getByRole('tab', { name: 'Review versions' }).click();
  await page.getByLabel('Version to review').selectOption('3');
  await expect(page.locator('#version-meta')).toContainText('Reviewed');
  await page.getByLabel('Version to review').selectOption('7');
  await expect(page.locator('#version-meta')).toContainText('Not reviewed');
  await page.locator('#review-version').click(); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#versions-status')).toHaveText('Version 7 reviewed.');
  await page.getByRole('tab', { name: 'Edit campaign' }).click();
  await expect(page.locator('#publish')).toBeEnabled();
  await page.getByLabel('Test session').selectOption('maya');
  await expect(page.locator('#editor-tabs')).toBeHidden();
});

test('version review tabs support keyboard selection and failed loads cannot approve stale content', async ({ page }) => {
  await login(page, 'ren');
  await page.getByRole('tab', { name: 'Edit campaign' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Review versions' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#review-version')).toBeEnabled();
  await page.getByRole('tab', { name: 'Review versions' }).focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Edit campaign' })).toHaveAttribute('aria-selected', 'true');
  await page.route('**/versions/1', route => route.fulfill({ status: 500, json: { error: 'Unable to load version' } }));
  await page.getByRole('tab', { name: 'Review versions' }).click();
  await expect(page.locator('#versions-status')).toHaveText('Unable to load version');
  await expect(page.locator('#review-version')).toBeDisabled();
  await expect(page.locator('#version-preview')).toBeEmpty();
});

async function scenario(page: Page, value: string) {
  await page.getByLabel('Test generation scenario').selectOption(value);
  await expect(page.locator('#fake-status')).toHaveText('Scenario saved for the next new job.');
}

test('durable job survives refresh and navigation, then automatically restores its saved result', async ({ page }) => {
  await login(page);
  await scenario(page, 'delayed_success');
  await page.locator('#generate').click();
  await expect(page.locator('#job-id')).toContainText('Job ');
  const id = await page.locator('#job-id').textContent();
  await page.goto('/health');
  await page.goto('/');
  await expect(page.locator('#job-id')).toHaveText(id!);
  await page.reload();
  await expect(page.locator('#job-id')).toHaveText(id!);
  await expect(page.locator('#generate')).toBeDisabled();
  await page.locator('#release-job').click();
  await expect(page.locator('#generation-status')).toContainText('Draft saved');
  await expect(page.locator('#saved')).toHaveText('Saved v2');
  await expect(page.getByLabel('Draft text')).toHaveValue(/Shared availability/);
  await page.reload();
  await expect(page.locator('#job-id')).toHaveText(id!);
  await expect(page.locator('#generation-status')).toContainText('Draft saved');
});

test('saving a newer brief makes paused output obsolete and offers regeneration', async ({ page }) => {
  await login(page);
  const original = await page.getByLabel('Draft text').inputValue();
  await scenario(page, 'delayed_success');
  await page.locator('#generate').click();
  await expect(page.locator('#job-id')).toContainText('Job ');
  await page.getByLabel('Goal + audience').fill('Updated saved brief');
  await page.locator('#save').click();
  await expect(page.locator('#saved')).toHaveText('Saved v2');
  await page.locator('#release-job').click();
  await expect(page.locator('#generation-status')).toContainText('Generation out of date');
  await expect(page.getByLabel('Draft text')).toHaveValue(original);
  await expect(page.locator('#draft-status')).toContainText('Out of date');
  await expect(page.getByRole('button', { name: 'Regenerate', exact: true })).toBeEnabled();
  await scenario(page, 'success');
  await page.locator('#generate').click();
  await expect(page.locator('#saved')).toHaveText('Saved v3');
  await expect(page.getByLabel('Draft text')).toHaveValue(/Updated saved brief/);
});

test('successful background generation preserves unsaved input and stale save conflicts', async ({ page }) => {
  await login(page);
  await scenario(page, 'delayed_success');
  await page.locator('#generate').click();
  await expect(page.locator('#job-id')).toContainText('Job ');
  await page.getByLabel('Draft text').fill('My unsaved draft');
  await page.locator('#release-job').click();
  await expect(page.locator('#generation-status')).toContainText('Your local edits are kept');
  await expect(page.getByLabel('Draft text')).toHaveValue('My unsaved draft');
  await expect(page.locator('#saved')).toHaveText('Unsaved · v1');
  await page.locator('#save').click();
  await expect(page.locator('#status')).toContainText('changed on the server');
  await page.locator('#reload').click(); await page.locator('#dialog-cancel').click();
  await expect(page.getByLabel('Draft text')).toHaveValue('My unsaved draft');
  await page.locator('#reload').click(); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#saved')).toHaveText('Saved v2');
});

test('malformed failure is durable and a new retry key can recover without losing the draft', async ({ page }) => {
  await login(page);
  const original = await page.getByLabel('Draft text').inputValue();
  await scenario(page, 'malformed');
  const sent: string[] = [];
  page.on('request', req => { if (req.url().endsWith('/generate')) sent.push(req.postDataJSON().key); });
  await page.locator('#generate').click();
  await expect(page.locator('#generation-status')).toContainText('Generation failed');
  const oldJob = await page.locator('#job-id').textContent();
  await page.reload();
  await expect(page.locator('#job-id')).toHaveText(oldJob!);
  await expect(page.getByLabel('Draft text')).toHaveValue(original);
  await scenario(page, 'transient_then_ok');
  await page.getByRole('button', { name: 'Retry generation' }).click();
  await expect(page.locator('#generation-status')).toContainText('Draft saved · Attempt 2/2');
  expect(sent).toHaveLength(2); expect(sent[0]).not.toBe(sent[1]);
});

test('lost submission response reuses its stored key after refresh and returns the same job', async ({ page }) => {
  await login(page);
  await scenario(page, 'delayed_success');
  const keys: string[] = [];
  let jobId = '';
  await page.route('**/generate', async route => {
    keys.push(route.request().postDataJSON().key);
    const response = await route.fetch();
    jobId = (await response.json()).id;
    await route.abort('failed');
  });
  await page.locator('#generate').click();
  await expect(page.locator('#generation-status')).toContainText('Submission outcome unknown');
  await page.unroute('**/generate');
  page.on('request', req => { if (req.url().endsWith('/generate')) keys.push(req.postDataJSON().key); });
  await page.reload();
  await expect(page.locator('#job-id')).toHaveText(`Job ${jobId}`);
  await page.locator('#generate').click();
  await expect(page.locator('#generate')).toBeDisabled();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await page.locator('#release-job').click();
  await expect(page.locator('#generation-status')).toContainText('Draft saved');
  await expect(page.locator('#saved')).toHaveText('Saved v2');
});

test('timeout exhausts exactly two attempts and preserves saved draft', async ({ page }) => {
  await login(page);
  const original = await page.getByLabel('Draft text').inputValue();
  await scenario(page, 'timeout');
  await page.locator('#generate').click();
  await expect(page.locator('#generation-status')).toContainText('Generation failed · Attempt 2/2', { timeout: 10000 });
  await expect(page.getByLabel('Draft text')).toHaveValue(original);
  await expect(page.locator('#saved')).toHaveText('Saved v1');
});
