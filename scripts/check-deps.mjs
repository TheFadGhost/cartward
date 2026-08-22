import { hash, verify } from '@node-rs/argon2';
import Database from 'better-sqlite3';

const h = await hash('correct horse battery staple', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
const ok = await verify(h, 'correct horse battery staple');
console.log('argon2 OK:', ok, h.slice(0, 31) + '...');

const db = new Database(':memory:');
db.exec('CREATE TABLE t(x)');
console.log('sqlite OK:', db.prepare('SELECT sqlite_version() AS v').get().v);
