const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ENABLED = !!process.env.DEBUG;

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'webui-sync');
let logPath = null;

function ensureLogFile() {
  if (logPath) return logPath;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  logPath = path.join(LOG_DIR, `http-${date}.log`);
  return logPath;
}

function redactHeaders(headers) {
  if (!headers) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization') {
      out[k] = typeof v === 'string' ? `<redacted len=${v.length}>` : '<redacted>';
    } else if (lk === 'cookie') {
      const names = String(v)
        .split(';')
        .map((p) => p.split('=')[0].trim())
        .filter(Boolean);
      out[k] = `<redacted ${names.length} cookies: ${names.join(',')}>`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function logHttp(entry) {
  if (!ENABLED) return;
  try {
    const file = ensureLogFile();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      requestHeaders: redactHeaders(entry.requestHeaders),
    });
    fs.appendFileSync(file, `${line}\n`);
  } catch (e) {
    // Best effort — never throw from logger
    console.error(`[debug-log] write failed: ${e.message}`);
  }
}

function getLogPath() {
  return ENABLED ? ensureLogFile() : null;
}

module.exports = { logHttp, getLogPath, ENABLED };
