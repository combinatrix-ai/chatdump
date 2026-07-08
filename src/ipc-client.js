// Pure-node thin client for the chatdump CLI. Runs under
// ELECTRON_RUN_AS_NODE (see build/bin/chatdump / src/cli-entry.js) where
// require('electron') returns a stub path string rather than the API, so
// this module MUST NOT depend on any electron API -- socket path, app
// launch and everything else here is plain Node.
const { execFile } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { encode, createLineDecoder } = require('./ipc-protocol');

const APP_BUNDLE_ID = 'ai.combinatrix.chatdump';
const CONNECT_RETRY_MS = 150;
const CONNECT_TIMEOUT_MS = 15000;

// The app is macOS-only, so this can hardcode the standard userData
// location instead of asking electron for it.
function getSocketPath() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'chatdump', 'cli.sock');
}

function isGuiNotRunning(e) {
  return Boolean(e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED'));
}

function connectOnce(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Derive the .app bundle path from this process's executable. Under
// ELECTRON_RUN_AS_NODE, process.execPath is the packaged Electron binary at
// <bundle>.app/Contents/MacOS/chatdump, so the bundle is three levels up.
// Returns null if the path doesn't look like a macOS app bundle (e.g. dev
// runs via a system electron), in which case we fall back to the bundle id.
function bundlePathFromExecPath() {
  const macOsDir = path.dirname(process.execPath); // .../Contents/MacOS
  const bundle = path.resolve(macOsDir, '..', '..'); // .../Foo.app
  return bundle.endsWith('.app') ? bundle : null;
}

function launchGuiApp() {
  return new Promise((resolve) => {
    // Best-effort: if `open` fails we still fall through to polling, which
    // times out with a clear error. Prefer opening the bundle we're running
    // from by path -- that works even when the app isn't registered with
    // Launch Services yet (fresh download, dev build). Fall back to the
    // bundle id for unusual layouts (e.g. a system-electron dev run).
    const bundlePath = bundlePathFromExecPath();
    const openArgs = bundlePath ? [bundlePath] : ['-b', APP_BUNDLE_ID];
    // Scrub ELECTRON_RUN_AS_NODE from the child env: this process runs with
    // it set (we're a plain-Node CLI), and `open` would otherwise pass it
    // through to the launched GUI, which would then boot in Node mode and
    // exit instead of starting the real app + IPC server.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile('open', openArgs, { env }, () => resolve());
  });
}

// Connect to the running GUI's socket, launching the app and polling for it
// if it isn't up yet.
async function connectWithLaunch(socketPath) {
  try {
    return await connectOnce(socketPath);
  } catch (e) {
    if (!isGuiNotRunning(e)) throw e;
  }

  await launchGuiApp();

  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    try {
      return await connectOnce(socketPath);
    } catch (e) {
      if (!isGuiNotRunning(e) || Date.now() >= deadline) {
        throw new Error('Could not reach or start chatdump. Is it installed?');
      }
      await sleep(CONNECT_RETRY_MS);
    }
  }
}

// Send `cmd`/`args` to the running GUI over the IPC socket and stream the
// response to `stdout`/`stderr`. Resolves with the process exit code.
async function runViaDelegation(
  cmd,
  args,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  const socketPath = getSocketPath();
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let socket;
  try {
    socket = await connectWithLaunch(socketPath);
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 1;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(exitCode);
    };

    const decoder = createLineDecoder((msg) => {
      if (msg.id !== id) return;
      if (msg.type === 'stdout') {
        stdout.write(`${msg.text}\n`);
      } else if (msg.type === 'progress') {
        if (!args.json && msg.message) {
          const prefix = msg.accountId ? `[${msg.accountId}] ` : '';
          stderr.write(`${prefix}${msg.message}\n`);
        }
      } else if (msg.type === 'result') {
        finish(msg.exitCode);
      } else if (msg.type === 'error') {
        stderr.write(`${msg.message}\n`);
        finish(typeof msg.exitCode === 'number' ? msg.exitCode : 1);
      }
    });

    socket.on('data', (chunk) => decoder.push(chunk.toString('utf8')));
    socket.on('error', (e) => {
      stderr.write(`Connection to chatdump failed: ${e.message}\n`);
      finish(1);
    });
    socket.on('close', () => {
      if (!settled) {
        stderr.write('Connection to chatdump closed unexpectedly.\n');
        finish(1);
      }
    });

    socket.write(encode({ type: 'request', id, cmd, args }));
  });
}

module.exports = {
  runViaDelegation,
  _test: {
    getSocketPath,
    isGuiNotRunning,
  },
};
