import { createApp } from './app.js';
import { openDatabase } from './db.js';

const db = openDatabase();
const server = createApp(db, process.env.NODE_ENV);
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '127.0.0.1', () => console.log(`Feature lab: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
