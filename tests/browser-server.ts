import { openDatabase, seed } from '../src/db.js';
import { createApp } from '../src/app.js';
import { runOnce } from '../src/worker.js';
const db = openDatabase(':memory:');
seed(db, 'test');
createApp(db, 'test').listen(3199, '127.0.0.1');
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try { await runOnce(db, { timing: { attemptMs: 3000, budgetMs: 6500, backoffMs: 50, leaseGraceMs: 100 } }); }
  finally { running = false; }
}, 20);
