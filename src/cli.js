// Pure argument parsing for the chatdump CLI -- no electron, no store,
// no scheduler. Required both by src/cli-entry.js (a pure-node process
// launched via ELECTRON_RUN_AS_NODE, which must not touch electron APIs)
// and, historically, by the GUI process. The actual work for `list`/`sync`
// now lives in src/ipc-server.js, which runs inside the GUI Electron
// process and is reached over the IPC socket (see src/ipc-client.js).
const COMMANDS = new Set(['help', 'list', 'accounts', 'sync', 'mcp']);

function getCliArgs(argv = process.argv) {
  const markerIndex = argv.findIndex((arg) => arg === 'cli' || arg === '--cli');
  if (markerIndex >= 0) return argv.slice(markerIndex + 1);
  return null;
}

function printHelp(stream = process.stdout) {
  stream.write(`chatdump CLI

Usage:
  chatdump list [--json]
  chatdump sync [--all] [--include-disabled] [--account <id>] [--provider <name>] [--since-days <days>] [--full-sync <created_at|last_message_at>] [--json]
  chatdump mcp

Examples:
  chatdump list
  chatdump sync --all
  chatdump sync --account openai:user@example.com --since-days 7
  chatdump sync --account openai:user@example.com --full-sync created_at
  chatdump mcp

Notes:
  The CLI reuses the Electron app's configured accounts and persisted login sessions.
  It does not open provider login windows; re-login from the menu bar app if auth expired.
  The MCP server speaks stdio and is intended to be launched by an MCP client.
`);
}

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function parseArgs(args) {
  const options = {
    command: args[0] || 'help',
    accountIds: [],
    provider: '',
    includeDisabled: false,
    all: false,
    json: false,
    sinceDays: undefined,
    mode: undefined,
  };

  if (!COMMANDS.has(options.command)) {
    throw new CliUsageError(`Unknown command: ${options.command}`);
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--all') {
      options.all = true;
      options.includeDisabled = true;
    } else if (arg === '--include-disabled') {
      options.includeDisabled = true;
    } else if (arg === '--account') {
      const value = args[++i];
      if (!value) throw new CliUsageError('--account requires an account id');
      options.accountIds.push(value);
    } else if (arg.startsWith('--account=')) {
      options.accountIds.push(arg.slice('--account='.length));
    } else if (arg === '--provider') {
      const value = args[++i];
      if (!value) throw new CliUsageError('--provider requires a provider name');
      options.provider = value;
    } else if (arg.startsWith('--provider=')) {
      options.provider = arg.slice('--provider='.length);
    } else if (arg === '--since-days') {
      options.sinceDays = parsePositiveInteger(args[++i], '--since-days');
    } else if (arg.startsWith('--since-days=')) {
      options.sinceDays = parsePositiveInteger(arg.slice('--since-days='.length), '--since-days');
    } else if (arg === '--full-sync') {
      options.mode = parseFullSyncMode(args[++i]);
    } else if (arg.startsWith('--full-sync=')) {
      options.mode = parseFullSyncMode(arg.slice('--full-sync='.length));
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }

  if (options.sinceDays !== undefined && options.mode) {
    throw new CliUsageError('--since-days and --full-sync cannot be used together');
  }

  return options;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseFullSyncMode(value) {
  if (!value) throw new CliUsageError('--full-sync requires created_at or last_message_at');
  if (value !== 'created_at' && value !== 'last_message_at') {
    throw new CliUsageError('--full-sync must be created_at or last_message_at');
  }
  return `full-sync:${value}`;
}

module.exports = {
  getCliArgs,
  parseArgs,
  printHelp,
  CliUsageError,
  _test: {
    parseFullSyncMode,
    parsePositiveInteger,
  },
};
