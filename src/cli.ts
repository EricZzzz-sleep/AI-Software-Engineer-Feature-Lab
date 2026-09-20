import { isTestEnvironment, openDatabase, seed } from './db.js';

const command = process.argv[2];
if (!['migrate', 'seed', 'reset'].includes(command ?? '')) throw new Error('Usage: cli.ts migrate|seed|reset');
if (command !== 'migrate' && !isTestEnvironment(process.env.NODE_ENV)) {
  throw new Error('Seed/reset requires explicit NODE_ENV=development or test');
}
const db = openDatabase();
try {
  if (command !== 'migrate') seed(db, process.env.NODE_ENV);
  console.log(`Database ${command} complete`);
} finally {
  db.close();
}
