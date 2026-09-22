import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { active, readJob, transaction, type Job } from './jobs.js';
import { fakeProvider, ProviderError, validateOutput, type Provider } from './generation.js';

export type Timing = { attemptMs: number; backoffMs: number; budgetMs: number; leaseGraceMs: number };
export const defaultTiming: Timing = { attemptMs: 30000, backoffMs: 1000, budgetMs: 65000, leaseGraceMs: 2000 };
export type Claim = { job: Job; token: string; attemptDeadline: number };
function terminal(db: DatabaseSync, job: Job, status: 'failed' | 'obsolete' | 'succeeded', now: number, error: string | null = null) {
  db.prepare('UPDATE generation_jobs SET status = ?, finished_at = ?, error_code = ? WHERE id = ?').run(status, now, error, job.id);
  db.prepare('UPDATE campaigns SET active_generation_id = NULL WHERE id = ? AND active_generation_id = ?').run(job.campaign_id, job.id);
  db.prepare('UPDATE generation_outbox SET done = 1, lease_token = NULL, lease_until = NULL WHERE job_id = ?').run(job.id);
}
export function claimWork(db: DatabaseSync, now = Date.now(), timing: Timing = defaultTiming): Claim | null {
  return transaction(db, () => {
    const work = db.prepare(`SELECT job_id FROM generation_outbox WHERE done = 0 AND available_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?) ORDER BY available_at, rowid LIMIT 1`).get(now, now);
    if (!work) return null;
    const job = readJob(db, String(work.job_id))!;
    if (!active(job.status)) {
      db.prepare('UPDATE generation_outbox SET done = 1, lease_token = NULL, lease_until = NULL WHERE job_id = ?').run(job.id);
      return null;
    }
    if (job.status === 'running') {
      db.prepare("UPDATE generation_attempts SET outcome = 'interrupted', finished_at = ? WHERE job_id = ? AND attempt = ? AND outcome = 'running'").run(now, job.id, job.attempts);
      if (job.attempts >= 2 || now + timing.backoffMs >= job.deadline_at!) {
        terminal(db, job, 'failed', now, 'worker_interrupted');
      } else {
        db.prepare("UPDATE generation_jobs SET status = 'retrying', error_code = 'worker_interrupted' WHERE id = ?").run(job.id);
        db.prepare('UPDATE generation_outbox SET available_at = ?, lease_until = NULL, lease_token = NULL WHERE job_id = ?').run(now + timing.backoffMs, job.id);
      }
      return null;
    }
    const budget = job.deadline_at ?? now + timing.budgetMs;
    if (now >= budget || job.attempts >= 2) { terminal(db, job, 'failed', now, 'budget_exhausted'); return null; }
    const deadline = Math.min(now + timing.attemptMs, budget);
    const token = randomUUID();
    db.prepare(`UPDATE generation_jobs SET status = 'running', attempts = attempts + 1,
      started_at = coalesce(started_at, ?), deadline_at = ?, error_code = NULL WHERE id = ?`).run(now, budget, job.id);
    db.prepare('UPDATE generation_outbox SET lease_token = ?, lease_until = ? WHERE job_id = ?').run(token, deadline + timing.leaseGraceMs, job.id);
    db.prepare(`INSERT INTO generation_attempts (job_id, attempt, token, started_at, deadline_at, outcome)
      VALUES (?, ?, ?, ?, ?, 'running')`).run(job.id, job.attempts + 1, token, now, deadline);
    return { job: readJob(db, job.id)!, token, attemptDeadline: deadline };
  });
}
export type Outcome = { output: unknown } | { error: string };
export function completeWork(db: DatabaseSync, claim: Claim, outcome: Outcome, now = Date.now(), timing: Timing = defaultTiming): boolean {
  return transaction(db, () => {
    const work = db.prepare('SELECT * FROM generation_outbox WHERE job_id = ?').get(claim.job.id);
    const job = readJob(db, claim.job.id);
    if (!job || job.status !== 'running' || !work || work.done || work.lease_token !== claim.token || Number(work.lease_until) <= now) return false;
    let error: string | null = 'error' in outcome ? outcome.error : null;
    let draft = '';
    if (now >= claim.attemptDeadline || now >= job.deadline_at!) error = 'timeout';
    if (!error && 'output' in outcome) {
      try { draft = validateOutput(outcome.output); } catch { error = 'malformed'; }
    }
    if (error) {
      db.prepare('UPDATE generation_attempts SET outcome = ?, finished_at = ? WHERE job_id = ? AND attempt = ?').run(error, now, job.id, job.attempts);
      if (['timeout', 'transient'].includes(error) && job.attempts < 2 && now + timing.backoffMs < job.deadline_at!) {
        db.prepare("UPDATE generation_jobs SET status = 'retrying', error_code = ? WHERE id = ?").run(error, job.id);
        db.prepare('UPDATE generation_outbox SET available_at = ?, lease_until = NULL, lease_token = NULL WHERE job_id = ?').run(now + timing.backoffMs, job.id);
      } else terminal(db, job, 'failed', now, error);
      return true;
    }
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(job.campaign_id)!;
    db.prepare("UPDATE generation_attempts SET outcome = 'succeeded', finished_at = ? WHERE job_id = ? AND attempt = ?").run(now, job.id, job.attempts);
    if (campaign.brief_revision !== job.brief_revision || campaign.draft_revision !== job.base_draft_revision || campaign.active_generation_id !== job.id) {
      terminal(db, job, 'obsolete', now, 'content_changed');
      return true;
    }
    const version = Number(campaign.version) + 1;
    const brief = JSON.parse(job.brief_snapshot) as { goal: string; facts: string; tone: string };
    db.prepare(`INSERT INTO campaign_versions (campaign_id, version, goal, facts, tone, draft, saved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(job.campaign_id, version, brief.goal, brief.facts, brief.tone, draft, job.created_by);
    // A generation is a new draft revision even if the text happens to match the prior draft.
    db.prepare('UPDATE campaign_versions SET draft_revision = ?, draft_brief_revision = ? WHERE campaign_id = ? AND version = ?')
      .run(job.base_draft_revision + 1, job.brief_revision, job.campaign_id, version);
    db.prepare('UPDATE campaigns SET version = ?, draft_revision = ?, draft_brief_revision = ? WHERE id = ?')
      .run(version, job.base_draft_revision + 1, job.brief_revision, job.campaign_id);
    db.prepare('UPDATE generation_jobs SET result_draft = ?, applied_version = ? WHERE id = ?').run(draft, version, job.id);
    terminal(db, job, 'succeeded', now);
    return true;
  });
}
export async function runOnce(db: DatabaseSync, options: { provider?: Provider; timing?: Timing; now?: () => number } = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const timing = options.timing ?? defaultTiming;
  const claim = claimWork(db, now(), timing);
  if (!claim) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ProviderError('timeout')); }, Math.max(0, claim.attemptDeadline - now()));
    });
    const output = await Promise.race([Promise.resolve().then(() => (options.provider ?? fakeProvider(db))(claim.job, controller.signal)), timeout]);
    completeWork(db, claim, { output }, now(), timing);
  } catch (error) {
    completeWork(db, claim, { error: error instanceof ProviderError ? error.code : 'provider_error' }, now(), timing);
  } finally { clearTimeout(timer); controller.abort(); }
  return true;
}
