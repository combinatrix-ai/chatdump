// Pure-node entry point for the chatdump CLI. Invoked by build/bin/chatdump
// via `ELECTRON_RUN_AS_NODE=1 <app binary> .../src/cli-entry.js <args>`, so
// this file (and everything it requires -- ipc-client.js, ipc-protocol.js)
// MUST NOT require('electron'): under ELECTRON_RUN_AS_NODE, require('electron')
// resolves to a stub path string, not the API.
//
// `list`/`sync` delegate to the running GUI app over a Unix socket (see
// ipc-client.js) so there is only ever one Electron process touching the
// Chromium userData profile (cookies, LevelDB, SingletonLock).
//
// `mcp` is NOT delegated in this PR -- it still relaunches the app binary
// the old way: a second full Electron process (this time WITHOUT
// ELECTRON_RUN_AS_NODE), which src/main.js detects and routes straight into
// startMcpServer(). MCP moving onto the same IPC socket is planned for a
// later PR; for now this keeps `chatdump mcp` working unchanged.
const { execFileSync } = require('node:child_process');
const { parseArgs, printHelp, CliUsageError } = require('./cli');
const { runViaDelegation } = require('./ipc-client');

// Accept both `chatdump list` (new, direct) and `chatdump cli list`
// (old spelling some docs/muscle-memory may still use) by stripping an
// optional leading `cli` token.
function stripLeadingCliToken(argv) {
  return argv[0] === 'cli' ? argv.slice(1) : argv;
}

function runMcpOldWay() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    execFileSync(process.execPath, ['cli', 'mcp'], { stdio: 'inherit', env });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

async function main(argv) {
  const args = stripLeadingCliToken(argv);
  const options = parseArgs(args);

  if (options.command === 'help') {
    printHelp(process.stdout);
    return 0;
  }

  if (options.command === 'mcp') {
    return runMcpOldWay();
  }

  if (options.command === 'list' || options.command === 'accounts' || options.command === 'sync') {
    const { command, ...delegatedArgs } = options;
    return runViaDelegation(command, delegatedArgs);
  }

  throw new CliUsageError(`Unhandled command: ${options.command}`);
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((e) => {
    if (e instanceof CliUsageError) {
      process.stderr.write(`${e.message}\n`);
      printHelp(process.stderr);
      process.exitCode = 1;
    } else {
      process.stderr.write(`${e.stack || e.message}\n`);
      process.exitCode = 1;
    }
  });
