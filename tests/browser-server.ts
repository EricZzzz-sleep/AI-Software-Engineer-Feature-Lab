import { openDatabase, seed } from '../src/db.js';
import { createApp } from '../src/app.js';
const db = openDatabase(':memory:');
seed(db, 'test');
createApp(db, 'test').listen(3199, '127.0.0.1');
