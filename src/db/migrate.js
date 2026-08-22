import { db } from './index.js';
console.log('[migrate] up to date;', db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, 'migrations applied');
