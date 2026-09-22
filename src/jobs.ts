import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { access, HttpError, only } from './campaigns.js';

export const scenarios = ['success', 'delayed_success', 'timeout', 'malformed', 'transient_then_ok'] as const;
export type Scenario = typeof scenarios[number];
export type JobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'obsolete';
export type Job = {
  id: string; campaign_id: string; workspace_id: string; created_by: string;
  request_key: string; payload: string; payload_hash: string; brief_snapshot: string;
  brief_revision: number; base_draft_revision: number; scenario: Scenario; released: number;
  status: JobStatus; attempts: number; created_at: number; started_at: number | null;
  deadline_at: number | null; finished_at: number | null; error_code: string | null;
  result_draft: string | null; applied_version: number | null;
};
export const active = (status: string) => ['queued', 'running', 'retrying'].includes(status);
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function readJob(db: DatabaseSync, id: string): Job | undefined {
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as unknown as Job | undefined;
}
export function publicJob(job: Job) {
  return { id: job.id, campaignId: job.campaign_id, status: job.status, attempts: job.attempts,
    briefRevision: job.brief_revision, baseDraftRevision: job.base_draft_revision,
    createdAt: job.created_at, deadlineAt: job.deadline_at, finishedAt: job.finished_at,
    error: job.error_code, draft: job.result_draft, appliedVersion: job.applied_version };
}
export function getJob(db: DatabaseSync, actorId: string, campaignId: string, jobId: string) {
  access(db, actorId, campaignId);
  const job = readJob(db, jobId);
  if (!job || job.campaign_id !== campaignId) throw new HttpError(404, 'Not found');
  return publicJob(job);
}
export function jobStatus(db: DatabaseSync, actorId: string, campaignId: string) {
  access(db, actorId, campaignId);
  const running = db.prepare("SELECT * FROM generation_jobs WHERE campaign_id = ? AND status IN ('queued','running','retrying') LIMIT 1").get(campaignId) as unknown as Job | undefined;
  const terminal = db.prepare("SELECT * FROM generation_jobs WHERE campaign_id = ? AND status IN ('succeeded','failed','obsolete') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(campaignId) as unknown as Job | undefined;
  return { active: running ? publicJob(running) : null, latest: terminal ? publicJob(terminal) : null };
}
export function enqueue(db: DatabaseSync, actorId: string, campaignId: string, input: Record<string, unknown>, now = Date.now(), beforeCommit?: () => void) {
  return transaction(db, () => {
    const campaign = access(db, actorId, campaignId, 'save');
    only(input, ['key', 'briefRevision', 'draftRevision']);
    if (typeof input.key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.key)) throw new HttpError(400, 'A request key of 8–128 letters, digits, underscores or hyphens is required');
    for (const field of ['briefRevision', 'draftRevision']) {
      if (!Number.isSafeInteger(input[field]) || Number(input[field]) < (field === 'briefRevision' ? 1 : 0)) throw new HttpError(400, `Invalid ${field}`);
    }
    const payload = JSON.stringify({ briefRevision: input.briefRevision, draftRevision: input.draftRevision });
    const fingerprint = createHash('sha256').update(payload).digest('hex');
    const existing = db.prepare('SELECT * FROM generation_jobs WHERE workspace_id = ? AND campaign_id = ? AND request_key = ?')
      .get(campaign.workspace_id!, campaignId, input.key) as unknown as Job | undefined;
    if (existing) {
      if (existing.payload_hash !== fingerprint || existing.payload !== payload) throw new HttpError(409, 'This request key was already used with different revisions');
      return { created: false, job: publicJob(existing) };
    }
    const running = db.prepare("SELECT id FROM generation_jobs WHERE campaign_id = ? AND status IN ('queued','running','retrying')").get(campaignId);
    if (running) throw new HttpError(409, 'Generation is already active for this brief', { activeJobId: running.id });
    if (campaign.brief_revision !== input.briefRevision || campaign.draft_revision !== input.draftRevision) throw new HttpError(409, 'Saved content changed. Reload before generating.');
    const saved = db.prepare('SELECT goal, facts, tone FROM campaign_versions WHERE campaign_id = ? AND version = ?').get(campaignId, campaign.version!)!;
    if (!String(saved.goal).trim()) throw new HttpError(400, 'Save a goal and audience before generating');
    const scenario = db.prepare('SELECT scenario FROM generation_scenarios WHERE campaign_id = ?').get(campaignId)?.scenario ?? 'success';
    const id = randomUUID();
    db.prepare(`INSERT INTO generation_jobs (id, campaign_id, workspace_id, created_by, request_key, payload_hash, payload,
      brief_snapshot, brief_revision, base_draft_revision, scenario, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(id, campaignId, campaign.workspace_id!, actorId,
      input.key, fingerprint, payload, JSON.stringify(saved), Number(input.briefRevision), Number(input.draftRevision), scenario, now);
    db.prepare('INSERT INTO generation_outbox (job_id, available_at) VALUES (?, ?)').run(id, now);
    db.prepare('UPDATE campaigns SET active_generation_id = ? WHERE id = ?').run(id, campaignId);
    beforeCommit?.();
    return { created: true, job: publicJob(readJob(db, id)!) };
  });
}
export function configureScenario(db: DatabaseSync, actorId: string, input: Record<string, unknown>) {
  only(input, ['campaignId', 'scenario']);
  if (typeof input.campaignId !== 'string' || !scenarios.includes(input.scenario as Scenario)) throw new HttpError(400, 'Valid campaignId and scenario are required');
  access(db, actorId, input.campaignId, 'save');
  db.prepare('INSERT INTO generation_scenarios VALUES (?, ?) ON CONFLICT(campaign_id) DO UPDATE SET scenario = excluded.scenario').run(input.campaignId, String(input.scenario));
  return { scenario: input.scenario };
}
export function releaseJob(db: DatabaseSync, actorId: string, input: Record<string, unknown>) {
  only(input, ['campaignId', 'jobId']);
  if (typeof input.campaignId !== 'string' || typeof input.jobId !== 'string') throw new HttpError(400, 'campaignId and jobId are required');
  access(db, actorId, input.campaignId, 'save');
  getJob(db, actorId, input.campaignId, input.jobId);
  db.prepare('UPDATE generation_jobs SET released = 1 WHERE id = ?').run(input.jobId);
  return { released: true };
}
