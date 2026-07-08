const COMMANDS = new Set(['help', 'list', 'accounts', 'sync', 'mcp']);

function loadRuntime() {
  return {
    store: require('./store'),
    scheduler: require('./scheduler'),
    providers: require('./providers'),
    mcp: require('./mcp'),
  };
}

function getCliArgs(argv = process.argv) {
  const markerIndex = argv.findIndex((arg) => arg === 'cli' || arg === '--cli');
  if (markerIndex >= 0) return argv.slice(markerIndex + 1);
  return null;
}

function printHelp(stream = process.stdout) {
  stream.write(`chatdump CLI

Usage:
  chatdump cli list [--json]
  chatdump cli sync [--all] [--include-disabled] [--account <id>] [--provider <name>] [--since-days <days>] [--full-sync <created_at|last_message_at>] [--json]
  chatdump cli mcp

Examples:
  chatdump cli list
  chatdump cli sync --all
  chatdump cli sync --account openai:user@example.com --since-days 7
  chatdump cli sync --account openai:user@example.com --full-sync created_at
  chatdump cli mcp

Notes:
  The CLI reuses the Electron app's configured accounts and persisted login sessions.
  It does not open provider login windows; re-login from the menu bar app if auth expired.
  The MCP server speaks stdio and is intended to be launched by an MCP client.
`);
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

function listAccounts(options) {
  const { store } = loadRuntime();
  const accounts = store.getAccounts().map((account) => formatAccount(account, store));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ accounts }, null, 2)}\n`);
    return;
  }

  if (accounts.length === 0) {
    process.stdout.write('No accounts configured.\n');
    return;
  }

  for (const account of accounts) {
    const status = account.lastError
      ? `error: ${account.lastError}`
      : account.status === 'expired'
        ? 'expired'
        : account.status || 'ok';
    process.stdout.write(
      `${account.id}\n  provider: ${account.provider}\n  email: ${account.email || '-'}\n  autoSync: ${account.autoSync ? 'on' : 'off'}\n  status: ${status}\n  vault: ${account.vaultPath || '-'}\n`,
    );
  }
}

function formatAccount(account, store) {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email || '',
    name: account.name || '',
    autoSync: account.autoSync !== false,
    status: account.status || 'ok',
    lastError: account.lastError || '',
    lastSyncedAt: account.lastSyncedAt || '',
    vaultPath: store.getVaultPath(account.id) || '',
  };
}

function selectAccounts(options) {
  const { store, providers } = loadRuntime();
  const accounts = store.getAccounts();

  if (options.provider && !providers.getProvider(options.provider)) {
    const names = providers
      .allProviders()
      .map((provider) => provider.name)
      .join(', ');
    throw new CliUsageError(`Unknown provider: ${options.provider}. Available providers: ${names}`);
  }

  if (options.accountIds.length > 0) {
    return options.accountIds.map((id) => {
      const account = store.getAccount(id);
      if (!account) throw new CliUsageError(`Account not found: ${id}`);
      return account;
    });
  }

  let selected = accounts;
  if (options.provider) {
    selected = selected.filter((account) => account.provider === options.provider);
  }

  if (!options.includeDisabled) {
    selected = selected.filter((account) => account.autoSync !== false);
  }

  return selected;
}

async function syncSelectedAccounts(options) {
  const { store, scheduler } = loadRuntime();
  const accounts = selectAccounts(options);
  const results = [];

  if (accounts.length === 0) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ synced: [], message: 'No matching accounts' }, null, 2)}\n`,
      );
    } else {
      process.stderr.write('No matching accounts.\n');
    }
    return 2;
  }

  for (const account of accounts) {
    if (!options.json) process.stderr.write(`[${account.id}] sync started\n`);
    const statusMessages = [];
    await scheduler.syncAccount(
      account.id,
      (state, message) => {
        statusMessages.push({ state, message });
        if (!options.json && message) process.stderr.write(`[${account.id}] ${message}\n`);
      },
      {
        interactive: false,
        sinceDays: options.sinceDays,
        mode: options.mode,
      },
    );

    const updated = store.getAccount(account.id) || account;
    const result = {
      id: account.id,
      provider: account.provider,
      ok: !(updated.lastError || updated.status === 'expired'),
      status: updated.status || 'ok',
      lastError: updated.lastError || '',
      lastSyncedAt: updated.lastSyncedAt || '',
      messages: statusMessages,
    };
    results.push(result);
    if (!options.json) {
      process.stderr.write(
        `[${account.id}] ${result.ok ? 'ok' : `failed: ${result.lastError || result.status}`}\n`,
      );
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ synced: results }, null, 2)}\n`);
  }

  return results.every((result) => result.ok) ? 0 : 3;
}

async function runCli(args) {
  const options = parseArgs(args);

  if (options.command === 'help') {
    printHelp();
    return 0;
  }

  if (options.command === 'list' || options.command === 'accounts') {
    listAccounts(options);
    return 0;
  }

  if (options.command === 'sync') {
    return syncSelectedAccounts(options);
  }

  if (options.command === 'mcp') {
    const { mcp } = loadRuntime();
    await mcp.startMcpServer();
    return 0;
  }

  throw new CliUsageError(`Unhandled command: ${options.command}`);
}

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

module.exports = {
  getCliArgs,
  parseArgs,
  runCli,
  _test: {
    CliUsageError,
    parseFullSyncMode,
    parsePositiveInteger,
    printHelp,
  },
};
