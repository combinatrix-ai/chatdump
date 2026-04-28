const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_ENTRIES = 200;

function getLogDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function getLogPath(accountId) {
  const safe = accountId.replace(/[/\\:*?"<>|]/g, '_');
  return path.join(getLogDir(), `${safe}.json`);
}

function readLog(accountId) {
  const logPath = getLogPath(accountId);
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    return [];
  }
}

function appendLog(accountId, entry) {
  const dir = getLogDir();
  fs.mkdirSync(dir, { recursive: true });

  const logs = readLog(accountId);
  logs.push({
    time: new Date().toISOString(),
    ...entry,
  });

  // Keep only last N entries
  const trimmed = logs.slice(-MAX_ENTRIES);
  fs.writeFileSync(getLogPath(accountId), JSON.stringify(trimmed, null, 2));
}

function getRecentLogs(accountId, count = 10) {
  const logs = readLog(accountId);
  return logs.slice(-count);
}

function openLogFile(accountId) {
  const logPath = getLogPath(accountId);
  if (!fs.existsSync(logPath)) {
    // Create empty log
    fs.mkdirSync(getLogDir(), { recursive: true });
    fs.writeFileSync(logPath, '[]');
  }
  require('electron').shell.openPath(logPath);
}

module.exports = { appendLog, getRecentLogs, openLogFile };
