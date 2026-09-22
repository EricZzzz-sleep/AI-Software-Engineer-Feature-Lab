import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase, seed } from '../src/db.js';
import { mutate, detail } from '../src/campaigns.js';
import { enqueue, readJob, releaseJob, configureScenario, getJob, jobStatus } from '../src/jobs.js';
import { claimWork, completeWork, runOnce, type Timing } from '../src/worker.js';
import { validateOutput } from '../src/generation.js';

const timing: Timing = { attemptMs: 100, backoffMs: 10, budgetMs: 250, leaseGraceMs: 5 };
const content = { goal: 'Invite team leads', facts: 'Workshop on October 1', tone: 'Friendly', draft: 'Original draft' };
function fixture(path = ':memory:') { const db = openDatabase(path); seed(db, 'test'); return db; }
const request = (key = 'request-0001', briefRevision = 1, draftRevision = 1) => ({ key, briefRevision, draftRevision });
function queue(db: DatabaseSync, scenario = 'success', now = 0) {
  configureScenario(db, 'maya', { campaignId: 'launch', scenario });
  return enqueue(db, 'maya', 'launch', request(), now).job;
}
const saved = (db: DatabaseSync) => detail(db, 'maya', 'launch') as Record<string, unknown>;

test('enqueue atomically creates one logical job and outbox item; key replay precedes revision validation', () => {
  const db = fixture();
  try {
    assert.throws(() => enqueue(db, 'maya', 'launch', request(), 0, () => { throw new Error('before commit'); }));
    assert.equal(db.prepare('SELECT count(*) AS n FROM generation_jobs').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM generation_outbox').get()?.n, 0);
    assert.equal(saved(db).active_generation_id, null);
    const first = enqueue(db, 'maya', 'launch', request(), 0);
    assert.equal(first.created, true);
    assert.equal(enqueue(db, 'ren', 'launch', request(), 0).job.id, first.job.id);
    assert.throws(() => enqueue(db, 'maya', 'launch', request('request-0001', 2), 0), /different revisions/);
    assert.throws(() => enqueue(db, 'maya', 'launch', request('request-0002'), 0), /already active/);
    mutate(db, 'maya', 'launch', 'save', { ...content, expectedVersion: 1 });
    assert.equal(enqueue(db, 'maya', 'launch', request(), 0).job.id, first.job.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM generation_outbox').get()?.n, 1);
  } finally { db.close(); }
});

test('independent revisions preserve no-op saves and draft provenance, including no draft and clearing', () => {
  const db = fixture();
  try {
    const before = saved(db);
    mutate(db, 'maya', 'launch', 'save', { expectedVersion: 1, goal: before.goal, facts: before.facts, tone: before.tone, draft: before.draft });
    assert.equal(saved(db).version, 1);
    mutate(db, 'maya', 'launch', 'save', { expectedVersion: 1, goal: 'New goal', facts: before.facts, tone: before.tone, draft: before.draft });
    assert.equal(saved(db).brief_revision, 2); assert.equal(saved(db).draft_revision, 1); assert.equal(saved(db).draft_brief_revision, 1);
    mutate(db, 'maya', 'launch', 'save', { expectedVersion: 2, goal: 'New goal', facts: before.facts, tone: before.tone, draft: '' });
    assert.equal(saved(db).draft_revision, 2); assert.equal(saved(db).draft_brief_revision, 2);
    db.exec("INSERT INTO campaigns (id,workspace_id,title) VALUES ('empty','a','Empty'); INSERT INTO campaign_versions (campaign_id,version,goal,facts,tone,draft,saved_by) VALUES ('empty',1,'Goal','','','','maya')");
    const job = enqueue(db, 'maya', 'empty', request('empty-draft', 1, 0), 0).job;
    assert.equal(job.baseDraftRevision, 0);
  } finally { db.close(); }
});

test('migration backfills independent revisions without renumbering history or review', () => {
  const directory = mkdtempSync(join(tmpdir(), 'generation-migration-'));
  const path = join(directory, 'db.sqlite');
  try {
    let db = new DatabaseSync(path);
    db.exec("CREATE TABLE migrations(name TEXT PRIMARY KEY)");
    for (const name of ['001_initial.sql', '002_campaigns.sql']) {
      db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO migrations VALUES (?)').run(name);
    }
    db.exec("INSERT INTO actors VALUES ('maya','Maya','member'); INSERT INTO workspaces VALUES ('a','A'); INSERT INTO memberships VALUES ('maya','a','publisher'); INSERT INTO campaigns VALUES ('launch','a','Launch',4)");
    for (const [v, goal, draft] of [[1, 'Goal', ''], [2, 'Goal', 'Draft'], [3, 'New goal', 'Draft'], [4, 'New goal', '']] as const) {
      db.prepare("INSERT INTO campaign_versions(campaign_id,version,goal,facts,tone,draft,saved_by) VALUES ('launch',?,?,'','',?,'maya')").run(v, goal, draft);
    }
    db.exec("INSERT INTO reviews(campaign_id,version,actor_id) VALUES ('launch',3,'maya')"); db.close();
    db = openDatabase(path);
    assert.deepEqual(db.prepare('SELECT brief_revision, draft_revision, draft_brief_revision FROM campaign_versions ORDER BY version').all().map(r => Object.values(r)), [[1,0,0],[1,1,1],[2,1,1],[2,2,2]]);
    assert.equal(saved(db).version, 4); assert.equal(saved(db).draft_revision, 2);
    assert.equal(db.prepare('SELECT version FROM reviews').get()?.version, 3);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const edit of ['brief', 'draft', 'active-id']) test(`paused output becomes obsolete after changed ${edit}`, () => {
  const db = fixture();
  try {
    const job = queue(db, 'delayed_success'); const claim = claimWork(db, 0, timing)!;
    const before = saved(db);
    if (edit === 'active-id') db.prepare('UPDATE campaigns SET active_generation_id = ? WHERE id = ?').run('another-generation', 'launch');
    else mutate(db, 'maya', 'launch', 'save', { expectedVersion: 1, goal: edit === 'brief' ? 'New brief' : before.goal, facts: before.facts, tone: before.tone, draft: edit === 'draft' ? 'Manual edit' : before.draft });
    const edited = saved(db);
    releaseJob(db, 'maya', { campaignId: 'launch', jobId: job.id });
    assert.equal(completeWork(db, claim, { output: { draft: 'Obsolete output' } }, 1, timing), true);
    assert.equal(readJob(db, job.id)?.status, 'obsolete');
    assert.equal(saved(db).draft, edited.draft); assert.equal(saved(db).version, edited.version);
    if (edit === 'active-id') assert.equal(saved(db).active_generation_id, 'another-generation');
  } finally { db.close(); }
});

test('success applies exactly once, replay is harmless and historical reviews remain separate', () => {
  const db = fixture();
  try {
    mutate(db, 'ren', 'launch', 'review', { expectedVersion: 1 });
    const job = queue(db); const claim = claimWork(db, 0, timing)!;
    assert.equal(claimWork(db, 1, timing), null);
    completeWork(db, claim, { output: { draft: String(saved(db).draft) } }, 1, timing);
    assert.equal(saved(db).version, 2); assert.equal(saved(db).draft_revision, 2); assert.equal(saved(db).reviewed, false);
    assert.equal(readJob(db, job.id)?.applied_version, 2);
    assert.equal(completeWork(db, claim, { output: { draft: 'Duplicate' } }, 2, timing), false);
    db.prepare('UPDATE generation_outbox SET done = 0 WHERE job_id = ?').run(job.id);
    assert.equal(claimWork(db, 3, timing), null);
    assert.equal(saved(db).version, 2);
    assert.equal(enqueue(db, 'maya', 'launch', request(), 4).job.id, job.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 1);
  } finally { db.close(); }
});

for (const bad of [null, [], { draft: 4 }, { draft: '' }, { draft: ' ' }, { draft: 'x'.repeat(20001) }]) test(`invalid provider output cannot change persisted content (${typeof bad === 'object' && bad ? JSON.stringify(bad).slice(0,30) : bad})`, () => {
  const db = fixture();
  try {
    assert.throws(() => validateOutput(bad));
    const before = saved(db); const job = queue(db); const claim = claimWork(db, 0, timing)!;
    completeWork(db, claim, { output: bad }, 1, timing);
    assert.equal(readJob(db, job.id)?.status, 'failed'); assert.equal(readJob(db, job.id)?.attempts, 1);
    assert.equal(saved(db).draft, before.draft); assert.equal(saved(db).version, before.version);
  } finally { db.close(); }
});

test('retry deadlines persist across worker restarts; stale completions are fenced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'generation-restart-')); const path = join(directory, 'db.sqlite');
  let db = fixture(path);
  try {
    const job = queue(db); db.close(); db = openDatabase(path); // queued work survives restart
    const old = claimWork(db, 0, timing)!;
    db.close(); db = openDatabase(path);
    assert.equal(claimWork(db, 104, timing), null);
    assert.equal(claimWork(db, 105, timing), null); // interrupted attempt becomes retrying
    assert.equal(readJob(db, job.id)?.attempts, 1);
    assert.equal(readJob(db, job.id)?.deadline_at, 250);
    db.close(); db = openDatabase(path); // backoff survives restart
    assert.equal(claimWork(db, 114, timing), null);
    const second = claimWork(db, 115, timing)!;
    assert.equal(second.job.attempts, 2);
    assert.equal(completeWork(db, old, { output: { draft: 'Old worker' } }, 116, timing), false);
    completeWork(db, second, { output: { draft: 'Recovered draft' } }, 116, timing);
    db.close(); db = openDatabase(path);
    assert.equal(readJob(db, job.id)?.status, 'succeeded'); assert.equal(saved(db).draft, 'Recovered draft');
    db.prepare('UPDATE generation_outbox SET done = 0 WHERE job_id = ?').run(job.id); // duplicate delivery after commit
    assert.equal(claimWork(db, 117, timing), null); assert.equal(saved(db).version, 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('two timeouts fail durably, retry uses a fresh key, and total budget cannot reset', () => {
  const db = fixture();
  try {
    const before = saved(db); const job = queue(db, 'timeout');
    const first = claimWork(db, 0, timing)!;
    completeWork(db, first, { error: 'timeout' }, 100, timing);
    assert.equal(readJob(db, job.id)?.status, 'retrying');
    const second = claimWork(db, 110, timing)!;
    completeWork(db, second, { error: 'timeout' }, 210, timing);
    assert.equal(readJob(db, job.id)?.status, 'failed'); assert.equal(readJob(db, job.id)?.attempts, 2);
    assert.equal(saved(db).draft, before.draft);
    assert.equal(enqueue(db, 'maya', 'launch', request(), 211).job.id, job.id);
    const next = enqueue(db, 'maya', 'launch', request('fresh-request'), 211).job;
    assert.notEqual(next.id, job.id);
    claimWork(db, 211, timing);
    claimWork(db, 316, timing);
    assert.equal(claimWork(db, 500, timing), null);
    assert.equal(readJob(db, next.id)?.status, 'failed');
    assert.equal(readJob(db, next.id)?.deadline_at, 461);
  } finally { db.close(); }
});

test('both interrupted attempts terminate and late output is never applied', () => {
  const db = fixture();
  try {
    const job = queue(db); const a = claimWork(db, 0, timing)!;
    claimWork(db, 105, timing); const b = claimWork(db, 115, timing)!;
    claimWork(db, 220, timing);
    assert.equal(readJob(db, job.id)?.status, 'failed'); assert.equal(readJob(db, job.id)?.attempts, 2);
    assert.equal(completeWork(db, a, { output: { draft: 'Late' } }, 221, timing), false);
    assert.equal(completeWork(db, b, { output: { draft: 'Late' } }, 221, timing), false);
    assert.equal(saved(db).version, 1);
  } finally { db.close(); }
});

test('fake scenarios execute with bounded retry and durable delayed release', async () => {
  for (const scenario of ['success', 'malformed', 'transient_then_ok', 'timeout', 'delayed_success']) {
    const db = fixture();
    const short: Timing = { attemptMs: 40, backoffMs: 5, budgetMs: 200, leaseGraceMs: 100 };
    try {
      const job = queue(db, scenario, Date.now());
      const running = runOnce(db, { timing: short });
      if (scenario === 'delayed_success') releaseJob(db, 'maya', { campaignId: 'launch', jobId: job.id });
      await running;
      if (readJob(db, job.id)?.status === 'retrying') {
        await new Promise(resolve => setTimeout(resolve, 10)); await runOnce(db, { timing: short });
      }
      const result = readJob(db, job.id)!;
      assert.equal(result.status, ['timeout','malformed'].includes(scenario) ? 'failed' : 'succeeded');
      assert.equal(result.attempts, ['timeout','transient_then_ok'].includes(scenario) ? 2 : 1);
      if (result.status === 'succeeded') assert.match(result.result_draft!, /Shared availability/);
    } finally { db.close(); }
  }
});

test('provider ignoring cancellation is bounded and its late result is ignored', async () => {
  const db = fixture();
  try {
    const job = queue(db, 'success', Date.now());
    let resolve!: (value: unknown) => void;
    await runOnce(db, { timing: { ...timing, attemptMs: 10 }, provider: () => new Promise(r => { resolve = r; }) });
    assert.equal(readJob(db, job.id)?.status, 'retrying');
    resolve({ draft: 'Too late' }); await Promise.resolve();
    assert.equal(saved(db).version, 1);
  } finally { db.close(); }
});

test('job reads and controls remain workspace scoped and reset clears durable work', () => {
  const db = fixture();
  try {
    const job = queue(db);
    assert.equal(getJob(db, 'evan', 'launch', job.id).id, job.id);
    assert.throws(() => getJob(db, 'priya', 'launch', job.id), /Not found/);
    assert.throws(() => getJob(db, 'priya', 'workspace-b', job.id), /Not found/);
    assert.throws(() => jobStatus(db, 'priya', 'launch'), /Not found/);
    assert.throws(() => enqueue(db, 'evan', 'launch', request()), /cannot perform/);
    assert.throws(() => releaseJob(db, 'priya', { campaignId: 'launch', jobId: job.id }), /Not found/);
    const claim = claimWork(db, 0, timing)!;
    seed(db, 'test');
    assert.equal(completeWork(db, claim, { output: { draft: 'After reset' } }, 1, timing), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM generation_outbox').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM generation_jobs').get()?.n, 0);
  } finally { db.close(); }
});


test('a killed worker process is replaced and its leased job completes exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'generation-process-'));
  const path = join(directory, 'db.sqlite');
  const db = fixture(path);
  const script = `
    import { openDatabase } from './src/db.ts';
    import { runOnce } from './src/worker.ts';
    const db = openDatabase();
    while (true) {
      await runOnce(db, { timing: { attemptMs: 500, backoffMs: 20, budgetMs: 3000, leaseGraceMs: 50 } });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  `;
  const start = () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_PATH: path }, stdio: 'ignore',
  });
  const waitFor = async (check: () => boolean) => {
    const end = Date.now() + 5000;
    while (!check()) {
      if (Date.now() >= end) throw new Error('Worker did not reach expected durable state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let worker: ReturnType<typeof start> | undefined;
  try {
    const job = queue(db, 'delayed_success', Date.now());
    worker = start();
    await waitFor(() => readJob(db, job.id)?.status === 'running');
    const firstToken = db.prepare('SELECT lease_token FROM generation_outbox WHERE job_id = ?').get(job.id)?.lease_token;
    const stopped = once(worker, 'exit'); worker.kill('SIGKILL'); await stopped;
    releaseJob(db, 'maya', { campaignId: 'launch', jobId: job.id });
    worker = start();
    await waitFor(() => readJob(db, job.id)?.status === 'succeeded');
    assert.equal(readJob(db, job.id)?.attempts, 2);
    assert.equal(saved(db).version, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM generation_attempts WHERE job_id = ?').get(job.id)?.n, 2);
    assert.notEqual(db.prepare('SELECT token FROM generation_attempts WHERE job_id = ? AND attempt = 2').get(job.id)?.token, firstToken);
    assert.equal(db.prepare('SELECT done FROM generation_outbox WHERE job_id = ?').get(job.id)?.done, 1);
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) { const stopped = once(worker, 'exit'); worker.kill('SIGKILL'); await stopped; }
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
