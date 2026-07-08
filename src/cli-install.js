const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLI_NAME = 'chatdump';
// The one standard place for a non-Homebrew user CLI on macOS. If it happens
// to be user-writable (common when Homebrew owns it on Intel) we symlink
// without escalation; otherwise we fall back to an administrator prompt.
const CANDIDATE_DIRS = ['/usr/local/bin'];
// Target used when escalating via administrator privileges (the candidate dir
// above is not writable by the current user).
const ESCALATION_DIR = '/usr/local/bin';

function isCliInstallAvailable() {
  const { app } = require('electron');
  return Boolean(app.isPackaged) && !process.mas;
}

function getWrapperPath(resourcesPath = process.resourcesPath) {
  return path.join(resourcesPath, 'bin', CLI_NAME);
}

// Pure: pick the first candidate dir that exists and is writable by us.
function pickWritableTarget(candidateDirs, fsLike = fs) {
  for (const dir of candidateDirs) {
    try {
      if (!fsLike.existsSync(dir)) continue;
      fsLike.accessSync(dir, fsLike.constants.W_OK);
      return dir;
    } catch {
      // Not writable (or accessSync unsupported for this stub) -- try the next candidate.
    }
  }
  return null;
}

// Pure: does any candidate dir contain a symlink named `chatdump` that
// resolves to wrapperRealPath? A symlink pointing at an old/moved app
// bundle (or anything else) does not count as installed.
function computeInstallStatus(candidateDirs, wrapperRealPath, fsLike = fs) {
  for (const dir of candidateDirs) {
    const target = path.join(dir, CLI_NAME);
    try {
      const stat = fsLike.lstatSync(target);
      if (!stat.isSymbolicLink()) continue;
      const resolved = fsLike.realpathSync(target);
      if (resolved === wrapperRealPath) {
        return { installed: true, path: target };
      }
    } catch {
      // Missing, unreadable, or a dangling symlink -- not installed here.
    }
  }
  return { installed: false, path: null };
}

// Pure: quote a string for safe embedding as a single shell argument.
function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Pure: escape a string for embedding inside an AppleScript double-quoted
// string literal (used to wrap the shell command passed to `do shell script`).
function appleScriptQuoteDouble(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Create/replace the `chatdump` symlink inside targetDir, pointing at
// wrapperPath. Refuses to clobber a pre-existing regular file that isn't a
// symlink we manage.
function linkIntoTarget(targetDir, wrapperPath, fsLike = fs) {
  const symlinkPath = path.join(targetDir, CLI_NAME);
  try {
    const stat = fsLike.lstatSync(symlinkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `${symlinkPath} already exists and is not a symlink chatdump manages; ` +
          'remove it manually and try again.',
      );
    }
    fsLike.rmSync(symlinkPath, { force: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // ENOENT: nothing there yet, nothing to remove.
  }
  fsLike.symlinkSync(wrapperPath, symlinkPath);
  return symlinkPath;
}

function escalateInstall(wrapperPath) {
  const innerCmd =
    `mkdir -p ${ESCALATION_DIR} && ` +
    `ln -sf ${shellQuoteSingle(wrapperPath)} ${ESCALATION_DIR}/${CLI_NAME}`;
  const script = `do shell script "${appleScriptQuoteDouble(innerCmd)}" with administrator privileges`;

  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (error, _stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, path: path.join(ESCALATION_DIR, CLI_NAME) });
        return;
      }
      const combined = `${error.message || ''} ${stderr || ''}`;
      if (combined.includes('-128') || /user canceled/i.test(combined)) {
        resolve({ ok: false, reason: 'cancelled' });
        return;
      }
      resolve({
        ok: false,
        reason: 'error',
        message: stderr?.trim() || error.message,
      });
    });
  });
}

// Install the `chatdump` command onto PATH. Returns a structured result --
// never throws, never shows a dialog (callers own UI).
async function installCliTool() {
  const wrapperPath = getWrapperPath();
  const target = pickWritableTarget(CANDIDATE_DIRS, fs);

  if (target) {
    try {
      const symlinkPath = linkIntoTarget(target, wrapperPath, fs);
      return { ok: true, path: symlinkPath };
    } catch (e) {
      return { ok: false, reason: 'error', message: e.message };
    }
  }

  return escalateInstall(wrapperPath);
}

function getCliInstallStatus() {
  const wrapperPath = getWrapperPath();
  let wrapperRealPath;
  try {
    wrapperRealPath = fs.realpathSync(wrapperPath);
  } catch {
    wrapperRealPath = wrapperPath;
  }
  return computeInstallStatus(CANDIDATE_DIRS, wrapperRealPath, fs);
}

module.exports = {
  isCliInstallAvailable,
  installCliTool,
  getCliInstallStatus,
  _test: {
    CLI_NAME,
    CANDIDATE_DIRS,
    ESCALATION_DIR,
    getWrapperPath,
    pickWritableTarget,
    computeInstallStatus,
    linkIntoTarget,
    shellQuoteSingle,
    appleScriptQuoteDouble,
  },
};
