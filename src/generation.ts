import type { DatabaseSync } from 'node:sqlite';
import type { Job } from './jobs.js';

export class ProviderError extends Error {
  constructor(public code: 'timeout' | 'transient' | 'malformed' | 'provider_error') { super(code); }
}
export type Provider = (job: Job, signal: AbortSignal) => Promise<unknown>;
export function validateOutput(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('malformed');
  const draft = (value as Record<string, unknown>).draft;
  if (typeof draft !== 'string' || !draft.trim() || draft.length > 20000) throw new ProviderError('malformed');
  return draft.trim();
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ProviderError('timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
export function fakeProvider(db: DatabaseSync): Provider {
  return async (job, signal) => {
    if (job.scenario === 'timeout') { await pause(2147483647, signal); throw new ProviderError('timeout'); }
    if (job.scenario === 'transient_then_ok' && job.attempts === 1) throw new ProviderError('transient');
    if (job.scenario === 'malformed') return { draft: 42 };
    if (job.scenario === 'delayed_success') {
      while (!signal.aborted) {
        const saved = db.prepare('SELECT released FROM generation_jobs WHERE id = ?').get(job.id);
        if (!saved) throw new ProviderError('provider_error');
        if (saved.released) break;
        await pause(25, signal);
      }
    }
    if (signal.aborted) throw new ProviderError('timeout');
    const brief = JSON.parse(job.brief_snapshot) as { goal: string; facts: string; tone: string };
    return { draft: `${brief.goal}\n\n${brief.facts || '[Add verified source facts before publication.]'}` };
  };
}
