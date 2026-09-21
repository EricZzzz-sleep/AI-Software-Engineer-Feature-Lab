import type { DatabaseSync } from 'node:sqlite';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, 'Unexpected request field');
}
export function access(db: DatabaseSync, actorId: string, id: string, action: 'read' | 'save' | 'publish' = 'read') {
  const campaign = db.prepare(`SELECT c.*, m.role FROM campaigns c JOIN memberships m
    ON m.workspace_id = c.workspace_id WHERE c.id = ? AND m.actor_id = ?`).get(id, actorId);
  if (!campaign) throw new HttpError(404, 'Not found');
  if ((action === 'save' && campaign.role === 'viewer') || (action === 'publish' && campaign.role !== 'publisher')) {
    throw new HttpError(403, 'Your role cannot perform this action');
  }
  return campaign;
}
export function detail(db: DatabaseSync, actorId: string, id: string) {
  const campaign = access(db, actorId, id);
  const content = db.prepare('SELECT goal, facts, tone, draft, saved_at FROM campaign_versions WHERE campaign_id = ? AND version = ?').get(id, campaign.version!);
  return { ...campaign, ...content,
    reviewed: !!db.prepare('SELECT 1 FROM reviews WHERE campaign_id = ? AND version = ?').get(id, campaign.version!),
    publications: db.prepare('SELECT id, version, published_at FROM publications WHERE campaign_id = ? ORDER BY id DESC').all(id),
  };
}
export function mutate(db: DatabaseSync, actorId: string, id: string, action: 'save' | 'review' | 'publish', input: Record<string, unknown>) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const campaign = access(db, actorId, id, action === 'save' ? 'save' : 'publish');
    only(input, action === 'save' ? ['expectedVersion', 'goal', 'facts', 'tone', 'draft'] : ['expectedVersion']);
    if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw new HttpError(400, 'A valid expectedVersion is required');
    if (action === 'publish') {
      const existing = db.prepare('SELECT * FROM publications WHERE campaign_id = ? AND version = ?').get(id, Number(input.expectedVersion));
      if (existing) { db.exec('COMMIT'); return existing; }
    }
    if (input.expectedVersion !== campaign.version) throw new HttpError(409, 'This campaign changed on the server. Your text has been kept. Reload to see the latest version.');
    if (action === 'save') {
      const keys = ['goal', 'facts', 'tone', 'draft'] as const;
      for (const key of keys) {
        if (typeof input[key] !== 'string' || input[key].length > 20000) throw new HttpError(400, `${key} must be text of at most 20,000 characters`);
      }
      const previous = db.prepare('SELECT * FROM campaign_versions WHERE campaign_id = ? AND version = ?').get(id, campaign.version!);
      if (keys.some(key => previous?.[key] !== input[key])) {
        const version = Number(campaign.version) + 1;
        db.prepare('INSERT INTO campaign_versions (campaign_id, version, goal, facts, tone, draft, saved_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, version, String(input.goal), String(input.facts), String(input.tone), String(input.draft), actorId);
        db.prepare('UPDATE campaigns SET version = ? WHERE id = ?').run(version, id);
      }
    } else if (action === 'review') {
      db.prepare('INSERT OR IGNORE INTO reviews (campaign_id, version, actor_id) VALUES (?, ?, ?)').run(id, Number(campaign.version), actorId);
    } else {
      if (!db.prepare('SELECT 1 FROM reviews WHERE campaign_id = ? AND version = ?').get(id, Number(campaign.version))) throw new HttpError(409, 'Review this saved version before publishing');
      const snapshot = detail(db, actorId, id);
      db.prepare('INSERT INTO publications (campaign_id, version, actor_id, snapshot) VALUES (?, ?, ?, ?)')
        .run(id, Number(campaign.version), actorId, JSON.stringify(snapshot));
    }
    const result = action === 'publish'
      ? db.prepare('SELECT * FROM publications WHERE campaign_id = ? AND version = ?').get(id, Number(campaign.version))
      : detail(db, actorId, id);
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}


export function versionHistory(db: DatabaseSync, actorId: string, id: string) {
  access(db, actorId, id, 'publish');
  return db.prepare(`SELECT v.version, v.saved_at, a.name AS saved_by,
    EXISTS(SELECT 1 FROM reviews r WHERE r.campaign_id = v.campaign_id AND r.version = v.version) AS reviewed
    FROM campaign_versions v JOIN actors a ON a.id = v.saved_by
    WHERE v.campaign_id = ? ORDER BY v.version DESC`).all(id);
}
export function versionDetail(db: DatabaseSync, actorId: string, id: string, version: number) {
  access(db, actorId, id, 'publish');
  if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(400, 'A valid version is required');
  const saved = db.prepare(`SELECT v.*, a.name AS author FROM campaign_versions v
    JOIN actors a ON a.id = v.saved_by WHERE v.campaign_id = ? AND v.version = ?`).get(id, version);
  if (!saved) throw new HttpError(404, 'Saved version not found');
  return { ...saved, version, reviewed: !!db.prepare('SELECT 1 FROM reviews WHERE campaign_id = ? AND version = ?').get(id, version) };
}
export function reviewVersion(db: DatabaseSync, actorId: string, id: string, version: number, input: Record<string, unknown>) {
  db.exec('BEGIN IMMEDIATE');
  try {
    versionDetail(db, actorId, id, version);
    only(input, []);
    db.prepare('INSERT OR IGNORE INTO reviews (campaign_id, version, actor_id) VALUES (?, ?, ?)').run(id, version, actorId);
    const result = versionDetail(db, actorId, id, version);
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
