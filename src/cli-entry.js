// Pure-node entry point for the chatdump CLI. Invoked by build/bin/chatdump
// via `ELECTRON_RUN_AS_NODE=1 <app binary> .../src/cli-entry.js <args>`, so
// this file (and everything it requires -- ipc-client.js, ipc-protocol.js,
// mcp.js) MUST NOT require('electron'): under ELECTRON_RUN_AS_NODE,
// require('electron') resolves to a stub path string, not the API.
//
// Every command delegates to the running GUI app over a Unix socket (see
// ipc-client.js) so there is only ever one Electron process touching the
// Chromium userData profile (cookies, LevelDB, SingletonLock). `list`/
// `accounts`/`sync` stream stdout/progress text via runViaDelegation();
// `mcp` runs a thin stdio MCP server in this same pure-node process (see
// mcp.js), whose tools each delegate to the GUI individually.
const { parseArgs, printHelp, CliUsageError } = require('./cli');
const { runViaDelegation } = require('./ipc-client');

// Accept both `chatdump list` (new, direct) and `chatdump cli list`
// (old spelling some docs/muscle-memory may still use) by stripping an
// optional leading `cli` token.
function stripLeadingCliToken(argv) {
  return argv[0] === 'cli' ? argv.slice(1) : argv;
}

async function main(argv) {
  const args = stripLeadingCliToken(argv);
  const options = parseArgs(args);

  if (options.command === 'help') {
    printHelp(process.stdout);
    return 0;
  }

  if (options.command === 'mcp') {
    await require('./mcp').startMcpServer();
    return 0;
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
