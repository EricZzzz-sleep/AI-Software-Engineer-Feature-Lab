import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mutate } from '../src/campaigns.js';
import { type DraftGenerator } from '../src/generation.js';
import { createApp } from '../src/app.js';
import { actors, openDatabase, seed } from '../src/db.js';

async function harness(env = 'test', generator: DraftGenerator | null = null) {
  const db = openDatabase(':memory:');
  seed(db, 'test');
  const server = createApp(db, env, generator);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', data?: unknown, token?: string, headers = {}) => fetch(url + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const session = async (actorId: string) => {
    const response = await request('/__test/session', 'POST', { actorId });
    assert.equal(response.status, 201);
    return (await response.json()).token as string;
  };
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  };
  return { db, request, session, close, url };
}
const content = { goal: 'A goal', facts: 'Verified facts', tone: 'Friendly', draft: 'Draft copy' };

test('actor matrix, isolation, forged fields, missing IDs and session expiry', async () => {
  const app = await harness();
  try {
    assert.equal((await app.request('/api/campaigns')).status, 401);
    for (const actor of actors) {
      const token = await app.session(actor.id);
      const list = await (await app.request('/api/campaigns', 'GET', undefined, token)).json();
      assert.deepEqual(list.map((c: { id: string }) => c.id), [actor.id === 'priya' ? 'workspace-b' : 'launch']);
      const expected = actor.id === 'priya' ? 404 : actor.id === 'evan' ? 403 : 200;
      const campaign = await (await app.request('/api/campaigns/launch', 'GET', undefined, await app.session('maya'))).json();
      assert.equal((await app.request('/api/campaigns/launch', 'PUT', { ...content, expectedVersion: campaign.version }, token)).status, expected);
      for (const action of ['review', 'publish']) {
        assert.equal((await app.request(`/api/campaigns/launch/${action}`, 'POST', { expectedVersion: campaign.version + (actor.id === 'maya' ? 1 : 0) }, token)).status,
          actor.id === 'priya' ? 404 : actor.id === 'ren' ? 200 : 403);
      }
      for (const suffix of ['', '/review', '/publish', '/publications/1']) {
        const method = suffix === '/review' || suffix === '/publish' ? 'POST' : 'GET';
        assert.equal((await app.request(`/api/campaigns/missing${suffix}`, method, method === 'POST' ? { expectedVersion: 1 } : undefined, token)).status, 404);
      }
    }
    const maya = await app.session('maya');
    assert.equal((await app.request('/api/campaigns/launch/publications/1', 'GET', undefined, maya)).status, 200);
    assert.equal((await app.request('/api/campaigns/launch/publications/1', 'GET', undefined, await app.session('priya'))).status, 404);
    assert.equal((await app.request('/api/campaigns/workspace-b', 'GET', undefined, maya)).status, 404);
    for (const field of ['role', 'workspace_id', 'actorId']) {
      assert.equal((await app.request('/api/campaigns/launch', 'PUT', { ...content, expectedVersion: 2, [field]: 'publisher' }, maya)).status, 400);
    }
    assert.equal((await app.request('/__test/session', 'POST', { actorId: 'maya', role: 'publisher' })).status, 400);
    app.db.exec('UPDATE sessions SET expires_at = 0');
    assert.equal((await app.request('/api/campaigns/launch', 'GET', undefined, maya)).status, 401);
  } finally { await app.close(); }
});

test('atomic saves, conflicts, version-specific review, idempotent immutable publication', async () => {
  const app = await harness();
  try {
    const token = await app.session('ren');
    const req = (suffix = '', method = 'GET', data?: unknown) => app.request('/api/campaigns/launch' + suffix, method, data, token);
    assert.equal((await req('/publish', 'POST', { expectedVersion: 1 })).status, 409);
    assert.equal((await req('', 'PUT', { ...content, expectedVersion: 1, draft: 42 })).status, 400);
    assert.equal((await (await req()).json()).version, 1);
    assert.equal((await req('', 'PUT', { ...content, expectedVersion: 1 })).status, 200);
    assert.equal((await req('', 'PUT', { ...content, draft: 'Stale', expectedVersion: 1 })).status, 409);
    assert.equal((await req('/review', 'POST', { expectedVersion: 1 })).status, 409);
    await req('/review', 'POST', { expectedVersion: 2 });
    const published = await (await req('/publish', 'POST', { expectedVersion: 2 })).json();
    assert.equal(JSON.parse(published.snapshot).draft, content.draft);
    assert.deepEqual(await (await req('/publish', 'POST', { expectedVersion: 2 })).json(), published);
    // No-op saves preserve review, changed saves require a new review.
    assert.equal((await (await req('', 'PUT', { ...content, expectedVersion: 2 })).json()).reviewed, true);
    const updated = await (await req('', 'PUT', { ...content, draft: 'New copy', expectedVersion: 2 })).json();
    assert.equal(updated.version, 3);
    assert.equal(updated.reviewed, false);
    assert.equal((await req('/publish', 'POST', { expectedVersion: 3 })).status, 409);
    assert.deepEqual(await (await req('/publications/' + published.id)).json(), published);
    assert.deepEqual(await (await req('/publish', 'POST', { expectedVersion: 2 })).json(), published);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM publications').get()?.n, 1);
  } finally { await app.close(); }
});

test('fixture controls are local, resets revoke sessions, and old endpoints are retired', async () => {
  const app = await harness();
  try {
    const token = await app.session('maya');
    for (const path of ['/api/projects', '/api/provider/check', '/__test/provider']) assert.equal((await app.request(path)).status, 404);
    assert.equal((await app.request('/__test/session', 'POST', { actorId: 'ren' }, undefined, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await app.request('/__test/session', 'POST', { actorId: 'ren' }, undefined, { Origin: app.url })).status, 201);
    assert.equal((await app.request('/__test/fixtures', 'POST', { scenario: 'empty' })).status, 200);
    assert.equal((await app.request('/api/me', 'GET', undefined, token)).status, 401);
    assert.deepEqual(await (await app.request('/api/campaigns', 'GET', undefined, await app.session('maya'))).json(), []);
    seed(app.db, 'test');
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM campaigns').get()?.n, 2);
  } finally { await app.close(); }
});

test('production, unset and unknown environments do not expose fixture controls', async () => {
  for (const env of ['production', 'staging', '']) {
    const app = await harness(env);
    try {
      for (const path of ['actors', 'session', 'fixtures']) assert.equal((await app.request(`/__test/${path}`, path === 'actors' ? 'GET' : 'POST', path === 'actors' ? undefined : {})).status, 404);
      assert.throws(() => seed(app.db, env), /Fixtures require/);
      assert.equal((await app.request('/')).status, 200);
    } finally { await app.close(); }
  }
});

test('forward migration preserves legacy data; campaign versions survive reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'campaign-lab-'));
  const path = join(directory, 'lab.sqlite');
  try {
    let db = new DatabaseSync(path);
    db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    db.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY); INSERT INTO migrations VALUES ('001_initial.sql'); INSERT INTO actors VALUES ('old', 'Legacy', 'admin'); INSERT INTO projects VALUES (1, 'Preserved', 'old');");
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('SELECT name FROM projects').get()?.name, 'Preserved');
    seed(db, 'test');
    seed(db, 'test');
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM campaigns').get()?.n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get()?.n, 2);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('generation uses saved brief, enforces permissions, and leaves saved content unchanged', async () => {
  const briefs: unknown[] = [];
  const app = await harness('test', async brief => { briefs.push(brief); return 'Generated copy'; });
  try {
    const token = await app.session('maya');
    const path = '/api/campaigns/launch/generate';
    assert.equal((await app.request(path, 'POST', { expectedVersion: 1 })).status, 401);
    for (const [actor, status] of [['evan', 403], ['priya', 404]] as const) {
      assert.equal((await app.request(path, 'POST', { expectedVersion: 1 }, await app.session(actor))).status, status);
    }
    for (const data of [{ expectedVersion: 0 }, { expectedVersion: 1, goal: 'Forged' }]) {
      assert.equal((await app.request(path, 'POST', data, token)).status, 400);
    }
    assert.equal((await app.request(path, 'POST', { expectedVersion: 2 }, token)).status, 409);
    assert.equal(briefs.length, 0);
    const before = await (await app.request('/api/campaigns/launch', 'GET', undefined, token)).json();
    assert.deepEqual(await (await app.request(path, 'POST', { expectedVersion: 1 }, token)).json(), { draft: 'Generated copy', expectedVersion: 1 });
    assert.deepEqual(briefs, [{ goal: before.goal, facts: before.facts, tone: before.tone }]);
    assert.deepEqual(await (await app.request('/api/campaigns/launch', 'GET', undefined, token)).json(), before);
    await app.request('/api/campaigns/launch', 'PUT', { ...content, goal: '  ', expectedVersion: 1 }, token);
    assert.equal((await app.request(path, 'POST', { expectedVersion: 2 }, token)).status, 400);
  } finally { await app.close(); }
});

test('generation rejects duplicates and stale results, then releases the campaign lock', async () => {
  let finish!: (draft: string) => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const app = await harness('test', () => { started(); return new Promise(resolve => { finish = resolve; }); });
  try {
    const token = await app.session('maya');
    const path = '/api/campaigns/launch/generate';
    const generation = app.request(path, 'POST', { expectedVersion: 1 }, token);
    await pending;
    assert.equal((await app.request(path, 'POST', { expectedVersion: 1 }, token)).status, 409);
    await app.request('/api/campaigns/launch', 'PUT', { ...content, expectedVersion: 1 }, token);
    finish('Obsolete output');
    assert.equal((await generation).status, 409);
    const saved = await (await app.request('/api/campaigns/launch', 'GET', undefined, token)).json();
    assert.equal(saved.draft, content.draft);
  } finally { await app.close(); }
});

test('missing generation configuration returns an actionable error', async () => {
  const app = await harness();
  try {
    const response = await app.request('/api/campaigns/launch/generate', 'POST', { expectedVersion: 1 }, await app.session('maya'));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /OPENAI_API_KEY/);
  } finally { await app.close(); }
});

test('generation accepts local brief variations and allows saving that brief during the request', async () => {
  let finish!: (draft: string) => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const brief = { goal: 'Local goal', facts: 'Local facts', tone: 'Warm', previousDraft: 'Previous variation' };
  const app = await harness('test', input => {
    assert.deepEqual(input, brief);
    start();
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    const token = await app.session('maya');
    const generation = app.request('/api/campaigns/launch/generate', 'POST', { expectedVersion: 1, ...brief }, token);
    await started;
    assert.equal((await app.request('/api/campaigns/launch', 'PUT', { expectedVersion: 1, goal: brief.goal, facts: brief.facts, tone: brief.tone, draft: brief.previousDraft }, token)).status, 200);
    finish('Next variation');
    assert.equal((await generation).status, 200);
    const saved = await (await app.request('/api/campaigns/launch', 'GET', undefined, token)).json();
    assert.equal(saved.draft, brief.previousDraft);
    assert.equal(saved.version, 2);
  } finally { await app.close(); }
});

test('publishers can inspect and review any saved version without changing the current revision', async () => {
  const app = await harness();
  try {
    for (let version = 2; version <= 7; version++) mutate(app.db, 'maya', 'launch', 'save', { ...content, draft: `Campaign draft revision ${version}.`, expectedVersion: version - 1 });
    const token = await app.session('ren');
    const req = (suffix: string, method = 'GET', data?: unknown, auth = token) => app.request('/api/campaigns/launch' + suffix, method, data, auth);
    const versions = await (await req('/versions')).json();
    assert.deepEqual(versions.map((v: { version: number }) => v.version), [7, 6, 5, 4, 3, 2, 1]);
    const before = await (await req('')).json();
    const older = await (await req('/versions/3')).json();
    assert.equal(older.draft, 'Campaign draft revision 3.');
    assert.equal((await req('/versions/3/review', 'POST', { role: 'publisher' })).status, 400);
    const reviewed = await (await req('/versions/3/review', 'POST', {})).json();
    assert.equal(reviewed.version, 3);
    assert.equal(reviewed.reviewed, true);
    assert.equal(reviewed.draft, older.draft);
    assert.deepEqual(await (await req('')).json(), before);
    assert.deepEqual(await (await req('/versions/3/review', 'POST', {})).json(), reviewed);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 1);
    assert.equal((await req('/publish', 'POST', { expectedVersion: 7 })).status, 409);
    // Review a snapshot even after another editor saves a newer version.
    await req('', 'PUT', { ...content, expectedVersion: 7 });
    assert.equal((await req('/versions/7/review', 'POST', {})).status, 200);
    const latest = await (await req('')).json();
    assert.equal(latest.version, 8);
    assert.equal(latest.reviewed, false);
    for (const actor of ['maya', 'evan', 'priya']) {
      const auth = await app.session(actor);
      for (const suffix of ['/versions', '/versions/3', '/versions/3/review']) {
        assert.equal((await req(suffix, suffix.endsWith('/review') ? 'POST' : 'GET', suffix.endsWith('/review') ? {} : undefined, auth)).status, actor === 'priya' ? 404 : 403);
      }
    }
    assert.equal((await app.request('/api/campaigns/launch/versions')).status, 401);
    assert.equal((await req('/versions/999')).status, 404);
    assert.equal((await req('/versions/999/review', 'POST', {})).status, 404);
    assert.equal((await req('/versions/0')).status, 400);
    assert.equal((await app.request('/api/campaigns/missing/versions', 'GET', undefined, token)).status, 404);
  } finally { await app.close(); }
});
