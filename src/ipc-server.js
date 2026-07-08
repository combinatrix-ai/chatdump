// Runs inside the GUI Electron process only. Listens on a Unix domain
// socket and does the real work (reading accounts, running syncs, asking
// questions, fetching conversations) for the thin CLI and MCP clients (see
// ipc-client.js, cli-entry.js, mcp.js), which run as separate pure-node
// processes and never touch store/scheduler/ask/conversation/electron
// directly. `list`/`accounts`/`sync` back the CLI (stdout/progress
// messages); the `mcp.*` commands back the MCP stdio server (structured
// `data` messages instead of stdout text).
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { app } = require('electron');
const { encode, createLineDecoder } = require('./ipc-protocol');

let server = null;

function getSocketPath() {
  return path.join(app.getPath('userData'), 'cli.sock');
}

// Pure: shape an account for CLI/JSON output. Mirrors mcp.js's accountSummary
// -- kept separate because cli output historically has its own field set,
// but the two should stay in sync if either changes.
function accountSummary(account, store) {
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

// Pure: resolve which accounts a `sync` request applies to.
function selectAccounts(args, store, providers) {
  const allAccounts = store.getAccounts();

  if (args.provider && !providers.getProvider(args.provider)) {
    const names = providers
      .allProviders()
      .map((provider) => provider.name)
      .join(', ');
    throw new Error(`Unknown provider: ${args.provider}. Available providers: ${names}`);
  }

  if (args.accountIds?.length > 0) {
    return args.accountIds.map((id) => {
      const account = store.getAccount(id);
      if (!account) throw new Error(`Account not found: ${id}`);
      return account;
    });
  }

  let selected = allAccounts;
  if (args.provider) {
    selected = selected.filter((account) => account.provider === args.provider);
  }
  if (!args.includeDisabled) {
    selected = selected.filter((account) => account.autoSync !== false);
  }
  return selected;
}

function formatAccountBlock(account) {
  const status = account.lastError
    ? `error: ${account.lastError}`
    : account.status === 'expired'
      ? 'expired'
      : account.status || 'ok';
  return `${account.id}\n  provider: ${account.provider}\n  email: ${account.email || '-'}\n  autoSync: ${account.autoSync ? 'on' : 'off'}\n  status: ${status}\n  vault: ${account.vaultPath || '-'}`;
}

function handleList(args, send, { store }) {
  const accounts = store.getAccounts().map((account) => accountSummary(account, store));

  if (args.json) {
    send({ type: 'stdout', text: JSON.stringify({ accounts }, null, 2) });
    return 0;
  }

  if (accounts.length === 0) {
    send({ type: 'stdout', text: 'No accounts configured.' });
    return 0;
  }

  for (const account of accounts) {
    send({ type: 'stdout', text: formatAccountBlock(account) });
  }
  return 0;
}

async function handleSync(args, send, { store, scheduler, providers }) {
  const accounts = selectAccounts(args, store, providers);

  if (accounts.length === 0) {
    if (args.json) {
      send({
        type: 'stdout',
        text: JSON.stringify({ synced: [], message: 'No matching accounts' }, null, 2),
      });
    } else {
      send({ type: 'progress', state: 'error', message: 'No matching accounts.' });
    }
    return 2;
  }

  const results = [];
  for (const account of accounts) {
    send({
      type: 'progress',
      state: 'start',
      message: 'sync started',
      accountId: account.id,
    });

    const statusMessages = [];
    await scheduler.syncAccount(
      account.id,
      (state, message) => {
        statusMessages.push({ state, message });
        if (message) {
          send({ type: 'progress', state, message, accountId: account.id });
        }
      },
      {
        interactive: false,
        sinceDays: args.sinceDays,
        mode: args.mode,
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

    send({
      type: 'progress',
      state: 'done',
      message: result.ok ? 'ok' : `failed: ${result.lastError || result.status}`,
      accountId: account.id,
    });
  }

  if (args.json) {
    send({ type: 'stdout', text: JSON.stringify({ synced: results }, null, 2) });
  }

  return results.every((result) => result.ok) ? 0 : 3;
}

function defaultDeps() {
  return {
    store: require('./store'),
    scheduler: require('./scheduler'),
    providers: require('./providers'),
  };
}

// mcp.* inputs treat `all` as a synonym for includeDisabled (mirroring the
// old src/mcp.js selectAccounts, which checked `input.all || input.includeDisabled`).
// The CLI doesn't need this fold: cli.js's --all flag already sets
// includeDisabled itself, so this is a no-op for `list`/`sync` requests.
function withMcpIncludeDisabled(args) {
  return { ...args, includeDisabled: Boolean(args.includeDisabled || args.all) };
}

async function handleMcpAccounts(args, send, { store, providers }) {
  const accounts = selectAccounts(withMcpIncludeDisabled(args), store, providers).map((account) =>
    accountSummary(account, store),
  );
  send({ type: 'data', payload: { accounts } });
  return 0;
}

async function handleMcpAsk(args, send, deps) {
  const ask = deps.ask || require('./ask');
  const result = await ask.askQuestion(args);
  send({ type: 'data', payload: result });
  return 0;
}

async function handleMcpConversation(args, send, deps) {
  const conversation = deps.conversation || require('./conversation');
  const result = await conversation.getConversation(args);
  const response = {
    accountId: result.accountId,
    provider: result.provider,
    conversationId: result.conversationId,
    title: result.title,
    markdown: result.markdown,
  };
  if (args.includeRaw) response.raw = result.raw;
  send({ type: 'data', payload: response });
  return 0;
}

function validateMcpSyncInput(args) {
  if (args.sinceDays !== undefined && args.fullSync) {
    throw new Error('sinceDays and fullSync cannot be used together');
  }
}

async function handleMcpSync(args, send, { store, scheduler, providers }) {
  validateMcpSyncInput(args);
  const accounts = selectAccounts(withMcpIncludeDisabled(args), store, providers);
  const mode = args.fullSync ? `full-sync:${args.fullSync}` : undefined;

  if (args.dryRun) {
    send({
      type: 'data',
      payload: {
        dryRun: true,
        accounts: accounts.map((account) => accountSummary(account, store)),
        options: { sinceDays: args.sinceDays, mode },
      },
    });
    return 0;
  }

  const results = [];
  for (const account of accounts) {
    const messages = [];
    send({ type: 'progress', state: 'start', message: 'sync started', accountId: account.id });

    await scheduler.syncAccount(
      account.id,
      (state, message) => {
        const entry = { state, message: message || '' };
        messages.push(entry);
        send({ type: 'progress', state, message: entry.message, accountId: account.id });
      },
      {
        interactive: false,
        sinceDays: args.sinceDays,
        mode,
      },
    );

    const updated = store.getAccount(account.id) || account;
    results.push({
      id: account.id,
      provider: account.provider,
      ok: !(updated.lastError || updated.status === 'expired'),
      status: updated.status || 'ok',
      lastError: updated.lastError || '',
      lastSyncedAt: updated.lastSyncedAt || '',
      messages,
    });
  }

  send({
    type: 'data',
    payload: { synced: results, ok: results.every((result) => result.ok) },
  });
  return 0;
}

// Dispatch a decoded `request` message, invoking `send(partial)` zero or
// more times (each call is stamped with the request's `id` by the caller)
// and resolving with the exit code once the command is done.
async function dispatch(request, send, deps = defaultDeps()) {
  const { cmd, args = {} } = request;
  if (cmd === 'list' || cmd === 'accounts') {
    return handleList(args, send, deps);
  }
  if (cmd === 'sync') {
    return handleSync(args, send, deps);
  }
  if (cmd === 'mcp.accounts') {
    return handleMcpAccounts(args, send, deps);
  }
  if (cmd === 'mcp.ask') {
    return handleMcpAsk(args, send, deps);
  }
  if (cmd === 'mcp.conversation') {
    return handleMcpConversation(args, send, deps);
  }
  if (cmd === 'mcp.sync') {
    return handleMcpSync(args, send, deps);
  }
  throw new Error(`Unsupported command: ${cmd}`);
}

function handleConnection(socket) {
  const decoder = createLineDecoder((msg) => {
    if (msg.type !== 'request') return;

    const send = (partial) => {
      if (socket.writable) socket.write(encode({ id: msg.id, ...partial }));
    };

    Promise.resolve()
      .then(() => dispatch(msg, send))
      .then((exitCode) => send({ type: 'result', exitCode }))
      .catch((e) => send({ type: 'error', message: e.message, exitCode: 1 }));
  });

  socket.on('data', (chunk) => decoder.push(chunk.toString('utf8')));
  socket.on('error', (e) => {
    console.error(`[ipc] connection error: ${e.message}`);
  });
}

function listen(socketPath) {
  server = net.createServer(handleConnection);
  server.on('error', (e) => {
    console.error(`[ipc] server error: ${e.message}`);
  });
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (e) {
      console.error(`[ipc] chmod failed: ${e.message}`);
    }
  });
}

// Start the socket server. Safe to call once, from the GUI process's
// app.whenReady() handler.
function startIpcServer() {
  const socketPath = getSocketPath();

  if (!fs.existsSync(socketPath)) {
    listen(socketPath);
    return;
  }

  // A socket file exists from a previous run (normal quit should have
  // unlinked it via stopIpcServer(); this handles a crash/kill -9). Probe it
  // before touching it -- app.requestSingleInstanceLock() means we should
  // never truly have two GUI processes, but be defensive.
  const probe = net.connect(socketPath);
  probe.on('connect', () => {
    console.error('[ipc] another chatdump instance is already listening on cli.sock');
    probe.destroy();
  });
  probe.on('error', () => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already gone -- fine, proceed to listen.
    }
    listen(socketPath);
  });
}

function stopIpcServer() {
  if (!server) return;
  const socketPath = getSocketPath();
  server.close();
  server = null;
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Nothing to clean up.
  }
}

module.exports = {
  startIpcServer,
  stopIpcServer,
  _test: {
    accountSummary,
    selectAccounts,
    formatAccountBlock,
    handleList,
    handleSync,
    handleMcpAccounts,
    handleMcpAsk,
    handleMcpConversation,
    handleMcpSync,
    validateMcpSyncInput,
    dispatch,
  },
};
