const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

const ENABLED = isTruthyEnv(process.env.DEBUG);
const BODY_ENABLED = isTruthyEnv(process.env.DEBUG_BODY);

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'chatdump');
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
    } else if (lk === 'set-cookie') {
      const values = Array.isArray(v) ? v : [v];
      const names = values.map((p) => String(p).split('=')[0].trim()).filter(Boolean);
      out[k] = `<redacted ${names.length} cookies: ${names.join(',')}>`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeEntry(entry) {
  const out = {
    ...entry,
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
  };

  if ('responseBody' in out && !BODY_ENABLED) {
    out.responseBody = '<omitted; set DEBUG_BODY=1 to include truncated response bodies>';
  }
  if (typeof out.responseBody === 'string') {
    out.responseBody = out.responseBody.replace(
      /("(?:accessToken|access_token|id_token|refresh_token)"\s*:\s*")[^"]+(")/g,
      '$1<redacted>$2',
    );
  }

  return out;
}

function logHttp(entry) {
  if (!ENABLED) return;
  try {
    const file = ensureLogFile();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...sanitizeEntry(entry),
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

module.exports = { logHttp, getLogPath, ENABLED, BODY_ENABLED };
