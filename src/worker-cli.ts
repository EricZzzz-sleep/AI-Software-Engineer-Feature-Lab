import { openDatabase, isTestEnvironment } from './db.js';
import { runOnce } from './worker.js';

if (!isTestEnvironment(process.env.NODE_ENV)) throw new Error('F2 uses fake providers only; worker requires development or test');
const db = openDatabase();
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopped = true; });
console.log('Generation worker started');
try {
  while (!stopped) {
    await runOnce(db);
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally { db.close(); }
