import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { actors, isTestEnvironment, seed } from './db.js';
import { openAIGenerator, type DraftGenerator } from './generation.js';
import { access, detail, HttpError, mutate, only, versionHistory, versionDetail, reviewVersion } from './campaigns.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 512000) throw new HttpError(413, 'Body too large');
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Expected a JSON object'); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function createApp(db: DatabaseSync, env: string | undefined, generator: DraftGenerator | null = openAIGenerator({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL })) {
  const generating = new Set<string>();
  const campaignDetail = (actorId: string, id: string) => ({ ...detail(db, actorId, id), generationEnabled: !!generator });
  const fixturesEnabled = isTestEnvironment(env);
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method;
      if (path.startsWith('/__test/')) {
        if (!fixturesEnabled) throw new HttpError(404, 'Not found');
        // Exact same-origin requests support the local actor switcher, while blocking cross-site minting.
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (!host || !/^127\.0\.0\.1(?::\d+)?$|^localhost(?::\d+)?$/.test(host) ||
          (origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new HttpError(403, 'Local same-origin requests only');
        }
        if (method === 'GET' && path === '/__test/actors') return json(res, 200, actors);
        if (method === 'POST' && path === '/__test/session') {
          const input = await body(req);
          only(input, ['actorId']);
          if (typeof input.actorId !== 'string' || !actors.some(a => a.id === input.actorId)) throw new HttpError(400, 'Unknown fixture actor');
          if (!db.prepare('SELECT id FROM actors WHERE id = ?').get(input.actorId)) throw new HttpError(409, 'Run the development seed command first');
          const token = randomBytes(32).toString('hex');
          db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), input.actorId, Date.now() + 3600000);
          return json(res, 201, { token, expiresIn: 3600 });
        }
        if (method === 'POST' && path === '/__test/fixtures') {
          const input = await body(req);
          only(input, ['scenario']);
          if (input.scenario !== 'default' && input.scenario !== 'empty') throw new HttpError(400, 'Unknown scenario');
          seed(db, env, input.scenario);
          return json(res, 200, { scenario: input.scenario });
        }
        throw new HttpError(404, 'Not found');
      }
      const assets: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/editor.js': ['editor.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
      };
      if (method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
      }
      if (method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
      const versionRoute = path.match(/^\/api\/campaigns\/([^/]+)\/versions(?:\/(\d+)(\/review)?)?$/);
      const route = path.match(/^\/api\/campaigns\/([^/]+)(?:\/(review|publish|publications|generate)(?:\/(\d+))?)?$/);
      if (path !== '/api/me' && path !== '/api/campaigns' && !route && !versionRoute) throw new HttpError(404, 'Not found');
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const actor = token ? db.prepare(`SELECT a.id, a.name FROM sessions s JOIN actors a ON a.id = s.actor_id
        WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash(token), Date.now()) : undefined;
      if (!actor || typeof actor.id !== 'string') throw new HttpError(401, 'Session expired. Sign in again; your text has been kept.');
      if (versionRoute) {
        const [, id, version, review] = versionRoute;
        if (method === 'GET' && !version) return json(res, 200, versionHistory(db, actor.id, id!));
        if (method === 'GET' && version && !review) return json(res, 200, versionDetail(db, actor.id, id!, Number(version)));
        if (method === 'POST' && version && review) return json(res, 200, reviewVersion(db, actor.id, id!, Number(version), await body(req)));
        throw new HttpError(405, 'Method not allowed');
      }
      if (method === 'GET' && path === '/api/me') return json(res, 200, { ...actor,
        memberships: db.prepare('SELECT workspace_id, role FROM memberships WHERE actor_id = ?').all(actor.id) });
      if (method === 'GET' && path === '/api/campaigns') return json(res, 200,
        db.prepare('SELECT c.id, c.title, c.workspace_id FROM campaigns c JOIN memberships m ON m.workspace_id = c.workspace_id WHERE m.actor_id = ? ORDER BY c.id').all(actor.id));
      if (route) {
        const id = route[1]!;
        const action = route[2];
        access(db, actor.id, id);
        if (method === 'GET' && !action) return json(res, 200, campaignDetail(actor.id, id));
        if (method === 'PUT' && !action) {
          mutate(db, actor.id, id, 'save', await body(req));
          return json(res, 200, campaignDetail(actor.id, id));
        }
        if (method === 'POST' && action === 'generate' && !route[3]) {
          access(db, actor.id, id, 'save');
          const input = await body(req);
          only(input, ['expectedVersion', 'goal', 'facts', 'tone', 'previousDraft']);
          if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw new HttpError(400, 'A valid expectedVersion is required');
          const saved: Record<string, unknown> = detail(db, actor.id, id);
          if (saved.version !== input.expectedVersion) throw new HttpError(409, 'This campaign changed on the server. Reload before generating.');
          const brief = { goal: String(saved.goal), facts: String(saved.facts), tone: String(saved.tone) };
          if (['goal', 'facts', 'tone'].some(key => key in input)) {
            for (const key of ['goal', 'facts', 'tone'] as const) {
              if (typeof input[key] !== 'string' || input[key].length > 20000) throw new HttpError(400, `${key} must be text of at most 20,000 characters`);
              brief[key] = input[key];
            }
          }
          if (input.previousDraft !== undefined && (typeof input.previousDraft !== 'string' || input.previousDraft.length > 20000)) throw new HttpError(400, 'previousDraft must be text of at most 20,000 characters');
          if (!brief.goal.trim()) throw new HttpError(400, 'Add a goal and audience to the brief before generating.');
          if (!generator) throw new HttpError(503, 'Generation is not configured. Set OPENAI_API_KEY on the server.');
          if (generating.has(id)) throw new HttpError(409, 'Generation is already in progress for this campaign.');
          generating.add(id);
          try {
            const draft = await generator({ ...brief, ...(typeof input.previousDraft === 'string' ? { previousDraft: input.previousDraft } : {}) });
            const latest = access(db, actor.id, id, 'save');
            const latestContent: Record<string, unknown> = detail(db, actor.id, id);
            if (latest.version !== saved.version && ['goal', 'facts', 'tone'].some(key => latestContent[key] !== saved[key] && latestContent[key] !== brief[key as keyof typeof brief])) throw new HttpError(409, 'This campaign changed during generation. Your text has been kept. Reload and try again.');
            return json(res, 200, { draft, expectedVersion: saved.version });
          } finally { generating.delete(id); }
        }
        if (method === 'POST' && (action === 'review' || action === 'publish') && !route[3]) return json(res, 200, mutate(db, actor.id, id, action, await body(req)));
        if (method === 'GET' && action === 'publications' && route[3]) {
          const publication = db.prepare('SELECT * FROM publications WHERE campaign_id = ? AND id = ?').get(id, Number(route[3]));
          if (!publication) throw new HttpError(404, 'Not found');
          return json(res, 200, publication);
        }
      }
      throw new HttpError(405, 'Method not allowed');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Internal server error' });
    }
  });
}
