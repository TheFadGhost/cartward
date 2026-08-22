import { config } from '../config.js';

function emit(level, msg, fields) {
  const entry = { t: new Date().toISOString(), level, msg, ...fields };
  if (config.isProd || process.env.LOG_FORMAT === 'json') {
    console.log(JSON.stringify(entry));
  } else {
    const rid = fields.requestId ? ` [${fields.requestId}]` : '';
    const rest = Object.entries(fields)
      .filter(([k]) => k !== 'requestId')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.log(`${entry.t} ${level.toUpperCase()}${rid} ${msg}${rest ? ' ' + rest : ''}`);
  }
}

export const log = {
  info: (msg, fields = {}) => emit('info', msg, fields),
  warn: (msg, fields = {}) => emit('warn', msg, fields),
  error: (msg, fields = {}) => emit('error', msg, fields),
  debug: (msg, fields = {}) => {
    if (!config.isProd) emit('debug', msg, fields);
  },
};
