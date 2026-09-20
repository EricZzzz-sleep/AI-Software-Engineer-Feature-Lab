import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { actors, openDatabase, seed } from '../src/db.js';

async function harness(env = 'test') {
  const db = openDatabase(':memory:');
  seed(db, 'test');
  const server = createApp(db, env);
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
