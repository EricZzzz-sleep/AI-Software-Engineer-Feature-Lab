import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const actors = [
  { id: 'maya', name: 'Maya', role: 'editor', workspaceId: 'a' },
  { id: 'ren', name: 'Ren', role: 'publisher', workspaceId: 'a' },
  { id: 'evan', name: 'Evan', role: 'viewer', workspaceId: 'a' },
  { id: 'priya', name: 'Priya', role: 'editor', workspaceId: 'b' },
] as const;

export function isTestEnvironment(env: string | undefined): boolean {
  return env === 'development' || env === 'test';
}

export function openDatabase(path = process.env.DATABASE_PATH ?? 'data/lab.sqlite'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(n => n.endsWith('.sql')).sort()) {
    // Check under the write lock so simultaneous app starts cannot apply a migration twice.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT name FROM migrations WHERE name = ?').get(name)) {
        db.exec(readFileSync(new URL(name, directory), 'utf8'));
        db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function seed(db: DatabaseSync, env: string | undefined, scenario: 'default' | 'empty' | 'conflict-v7' = 'default'): void {
  if (!isTestEnvironment(env)) throw new Error('Fixtures require NODE_ENV=development or test');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DELETE FROM publications; DELETE FROM reviews; DELETE FROM campaign_versions;
      DELETE FROM campaigns; DELETE FROM memberships; DELETE FROM workspaces;
      DELETE FROM sessions; DELETE FROM projects; DELETE FROM actors; DELETE FROM provider_controls;`);
    db.exec("INSERT INTO workspaces VALUES ('a', 'Workspace A'), ('b', 'Workspace B')");
    for (const actor of actors) {
      // Legacy role column remains for migration compatibility; campaign authorization uses memberships only.
      db.prepare('INSERT INTO actors (id, name, role) VALUES (?, ?, ?)').run(actor.id, actor.name, 'member');
      db.prepare('INSERT INTO memberships VALUES (?, ?, ?)').run(actor.id, actor.workspaceId, actor.role);
    }
    if (scenario !== 'empty') {
      for (const [id, workspace, title, owner] of [
        ['launch', 'a', 'Team scheduling launch', 'maya'],
        ['workspace-b', 'b', 'Workspace B campaign', 'priya'],
      ] as const) {
        db.prepare('INSERT INTO campaigns VALUES (?, ?, ?, 1)').run(id, workspace, title);
        db.prepare('INSERT INTO campaign_versions (campaign_id, version, goal, facts, tone, draft, saved_by) VALUES (?, 1, ?, ?, ?, ?, ?)')
          .run(id, 'Introduce team scheduling to busy team leads.', 'Shared availability. Fewer scheduling messages.', 'Clear and friendly', 'Bring your team together with simpler scheduling.', owner);
      }
    }
    if (scenario === 'conflict-v7') {
      for (let version = 2; version <= 7; version++) {
        db.prepare(`INSERT INTO campaign_versions (campaign_id, version, goal, facts, tone, draft, saved_by)
          VALUES ('launch', ?, ?, ?, 'Clear and friendly', ?, 'maya')`)
          .run(version, `Team scheduling campaign brief revision ${version}.`, 'Shared availability. Fewer scheduling messages.', `Campaign draft revision ${version}.`);
      }
      db.prepare("UPDATE campaigns SET version = 7 WHERE id = 'launch'").run();
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
