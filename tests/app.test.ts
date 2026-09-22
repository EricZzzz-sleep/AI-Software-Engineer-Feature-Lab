import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mutate, detail } from '../src/campaigns.js';
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

test('one-shot pre-commit failure rolls back all writes and is scoped to the session', async () => {
  const app = await harness();
  try {
    const token = await app.session('ren');
    const otherSession = await app.session('ren');
    const req = (path: string, method = 'GET', data?: unknown, session = token) => app.request(path, method, data, session);
    const campaign = '/api/campaigns/launch';
    await req(campaign + '/review', 'POST', { expectedVersion: 1 });
    const before = await (await req(campaign)).json();
    assert.equal((await req('/__test/save-failure', 'POST', { campaignId: 'launch' })).status, 200);
    assert.equal((await req(campaign, 'PUT', { ...content, expectedVersion: 0 })).status, 400);
    assert.equal((await req(campaign, 'PUT', { ...content, expectedVersion: 2 })).status, 409);
    // A no-op from a different session must neither fail nor consume this session's injection.
    const unchanged = { goal: before.goal, facts: before.facts, tone: before.tone, draft: before.draft, expectedVersion: 1 };
    assert.equal((await req(campaign, 'PUT', unchanged, otherSession)).status, 200);
    // A rejected save after role revocation must also leave the injection armed.
    app.db.exec("UPDATE memberships SET role = 'viewer' WHERE actor_id = 'ren'");
    assert.equal((await req(campaign, 'PUT', { ...content, expectedVersion: 1 })).status, 403);
    app.db.exec("UPDATE memberships SET role = 'publisher' WHERE actor_id = 'ren'");
    const failed = await req(campaign, 'PUT', { ...content, expectedVersion: 1 });
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /Nothing was saved/);
    assert.deepEqual(await (await req(campaign)).json(), before);
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM campaign_versions WHERE campaign_id = 'launch'").get()?.n, 1);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 1);
    const saved = await (await req(campaign, 'PUT', { ...content, expectedVersion: 1 })).json();
    assert.equal(saved.version, 2);
    assert.equal(saved.reviewed, false);
    assert.equal(saved.draft, content.draft);
  } finally { await app.close(); }
});

test('failure controls enforce authentication, workspace, fields, origin, and environment', async () => {
  const app = await harness();
  try {
    const path = '/__test/save-failure';
    assert.equal((await app.request(path, 'POST', { campaignId: 'launch' })).status, 401);
    for (const [actor, status] of [['maya', 200], ['ren', 200], ['evan', 403], ['priya', 404]] as const) {
      assert.equal((await app.request(path, 'POST', { campaignId: 'launch' }, await app.session(actor))).status, status);
    }
    const token = await app.session('maya');
    for (const input of [{}, { campaignId: 'launch', role: 'publisher' }]) assert.equal((await app.request(path, 'POST', input, token)).status, 400);
    assert.equal((await app.request(path, 'POST', { campaignId: 'missing' }, token)).status, 404);
    assert.equal((await app.request(path, 'POST', { campaignId: 'launch' }, token, { Origin: 'https://example.com' })).status, 403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(app.url + path, { method: 'POST', headers: { Host: 'example.com', Authorization: `Bearer ${token}` } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end(JSON.stringify({ campaignId: 'launch' }));
    });
    assert.equal(foreignHostStatus, 403);
    app.db.exec('UPDATE sessions SET expires_at = 0');
    assert.equal((await app.request(path, 'POST', { campaignId: 'launch' }, token)).status, 401);
  } finally { await app.close(); }
  for (const env of ['production', 'staging', '']) {
    const locked = await harness(env);
    try {
      assert.equal((await locked.request('/__test/save-failure', 'POST', { campaignId: 'launch' })).status, 404);
      assert.doesNotMatch(await (await locked.request('/')).text(), /id="mentor-drills"/);
    } finally { await locked.close(); }
  }
});

for (const editor of ['maya', 'ren']) test(`v7 simultaneous saves (${editor} and ren) have exactly one winner`, async () => {
  const app = await harness();
  try {
    const oldToken = await app.session('maya');
    await app.request('/__test/save-failure', 'POST', { campaignId: 'launch' }, oldToken);
    assert.equal((await app.request('/__test/fixtures', 'POST', { scenario: 'conflict-v7' })).status, 200);
    assert.equal((await app.request('/api/me', 'GET', undefined, oldToken)).status, 401);
    const tokens = [await app.session(editor), await app.session('ren')];
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM campaign_versions WHERE campaign_id = 'launch'").get()?.n, 7);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 0);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM publications').get()?.n, 0);
    const responses = await Promise.all(tokens.map((token, i) => app.request('/api/campaigns/launch', 'PUT', { ...content, draft: `Tab ${i}`, expectedVersion: 7 }, token)));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = responses.findIndex(r => r.status === 200);
    const saved = await (await app.request('/api/campaigns/launch', 'GET', undefined, tokens[0])).json();
    assert.equal(saved.version, 8);
    assert.equal(saved.draft, `Tab ${winner}`);
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM campaign_versions WHERE campaign_id = 'launch'").get()?.n, 8);
  } finally { await app.close(); }
});


test('saved brief and revision persist after reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'campaign-save-'));
  const path = join(directory, 'lab.sqlite');
  try {
    let db = openDatabase(path);
    seed(db, 'test', 'conflict-v7');
    mutate(db, 'maya', 'launch', 'save', { ...content, expectedVersion: 7 });
    db.close();
    db = openDatabase(path);
    const saved: Record<string, unknown> = detail(db, 'maya', 'launch');
    for (const [key, value] of Object.entries(content)) assert.equal(saved[key], value);
    assert.equal(saved.version, 8);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('armed failures are campaign-specific, apply to no-op saves, and clear on reset or restart', async () => {
  const app = await harness();
  try {
    const token = await app.session('maya');
    app.db.exec("INSERT INTO campaigns VALUES ('other', 'a', 'Other campaign', 1); INSERT INTO campaign_versions (campaign_id, version, goal, facts, tone, draft, saved_by) VALUES ('other', 1, '', '', '', '', 'maya')");
    const arm = () => app.request('/__test/save-failure', 'POST', { campaignId: 'launch' }, token);
    await arm();
    assert.equal((await app.request('/api/campaigns/other', 'PUT', { ...content, expectedVersion: 1 }, token)).status, 200);
    const saved = await (await app.request('/api/campaigns/launch', 'GET', undefined, token)).json();
    const noOp = { expectedVersion: 1, goal: saved.goal, facts: saved.facts, tone: saved.tone, draft: saved.draft };
    assert.equal((await app.request('/api/campaigns/launch', 'PUT', noOp, token)).status, 500);
    assert.equal((await app.request('/api/campaigns/launch', 'PUT', noOp, token)).status, 200);
    await arm();
    // A new server instance on the same database has no in-memory failure state.
    const restarted = createApp(app.db, 'test');
    restarted.listen(0, '127.0.0.1');
    await once(restarted, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(restarted.address() as AddressInfo).port}/api/campaigns/launch`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(noOp),
      });
      assert.equal(response.status, 200);
    } finally { await new Promise<void>(resolve => restarted.close(() => resolve())); }
    // Restore the exact old session after resetting to prove the failure set was cleared,
    // independently of reset's normal session revocation.
    const session = app.db.prepare('SELECT * FROM sessions').get()!;
    await app.request('/__test/fixtures', 'POST', { scenario: 'conflict-v7' });
    app.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session.token_hash!, session.actor_id!, session.expires_at!);
    assert.equal((await app.request('/api/campaigns/launch', 'PUT', { ...content, expectedVersion: 7 }, token)).status, 200);
  } finally { await app.close(); }
});

test('publishers can inspect and review any saved version without changing the current revision', async () => {
  const app = await harness();
  try {
    seed(app.db, 'test', 'conflict-v7');
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
