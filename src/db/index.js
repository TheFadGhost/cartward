import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from '../config.js';

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/** Run fn inside an IMMEDIATE transaction (write lock up front). */
export function txImmediate(fn) {
  return db.transaction(fn).immediate();
}
