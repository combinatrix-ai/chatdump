const packageJson = require('../package.json');

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

function selectAccounts(input, store, providers) {
  const allAccounts = store.getAccounts();
  const providerNames = providers.allProviders().map((provider) => provider.name);

  if (input.provider && !providers.getProvider(input.provider)) {
    throw new Error(
      `Unknown provider: ${input.provider}. Available providers: ${providerNames.join(', ')}`,
    );
  }

  if (input.accountIds?.length) {
    return input.accountIds.map((id) => {
      const account = store.getAccount(id);
      if (!account) throw new Error(`Account not found: ${id}`);
      return account;
    });
  }

  let selected = allAccounts;
  if (input.provider) {
    selected = selected.filter((account) => account.provider === input.provider);
  }

  if (!(input.all || input.includeDisabled)) {
    selected = selected.filter((account) => account.autoSync !== false);
  }

  return selected;
}

function makeToolResponse(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

function validateSyncInput(input) {
  if (input.sinceDays !== undefined && input.fullSync) {
    throw new Error('sinceDays and fullSync cannot be used together');
  }
}

async function startMcpServer() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod'),
  ]);

  const store = require('./store');
  const { getAccounts } = store;
  const { askQuestion } = require('./ask');
  const { getConversation } = require('./conversation');
  const scheduler = require('./scheduler');
  const providers = require('./providers');

  const server = new McpServer(
    {
      name: 'chatdump-mcp',
      version: packageJson.version,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    'ask',
    {
      title: 'Ask through a chatdump browser session',
      description:
        'Ask a question using a configured chatdump browser session. Currently supports ChatGPT accounts.',
      inputSchema: {
        prompt: z.string().min(1),
        accountId: z.string().optional(),
        provider: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        visible: z.boolean().optional(),
      },
    },
    async (input) => {
      await server.sendLoggingMessage({
        level: 'info',
        logger: 'chatdump',
        data: {
          tool: 'ask',
          provider: input.provider || 'openai',
          accountId: input.accountId || '',
          message: 'question started',
        },
      });

      const result = await askQuestion(input);

      await server.sendLoggingMessage({
        level: 'info',
        logger: 'chatdump',
        data: {
          tool: 'ask',
          provider: result.provider,
          accountId: result.accountId,
          message: 'question completed',
        },
      });

      return makeToolResponse(result);
    },
  );

  server.registerTool(
    'conversation',
    {
      title: 'Get a chatdump conversation by id',
      description:
        'Fetch a full conversation by provider conversation id. Currently supports ChatGPT conversation ids.',
      inputSchema: {
        conversationId: z.string().min(1),
        accountId: z.string().optional(),
        provider: z.string().optional(),
        includeRaw: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      const result = await getConversation(input);
      const response = {
        accountId: result.accountId,
        provider: result.provider,
        conversationId: result.conversationId,
        title: result.title,
        markdown: result.markdown,
        raw: input.includeRaw ? result.raw : undefined,
      };
      if (!input.includeRaw) delete response.raw;
      return makeToolResponse(response);
    },
  );

  server.registerTool(
    'accounts',
    {
      title: 'List chatdump accounts',
      description: 'List configured chatdump accounts and their sync status.',
      inputSchema: {
        provider: z.string().optional(),
        includeDisabled: z.boolean().optional(),
      },
    },
    async (input) => {
      const selected = selectAccounts(input, store, providers).map((account) =>
        accountSummary(account, store),
      );
      return makeToolResponse({ accounts: selected });
    },
  );

  server.registerTool(
    'sync',
    {
      title: 'Sync chatdump accounts',
      description:
        'Sync configured chatdump accounts to their Obsidian vaults using existing login sessions.',
      inputSchema: {
        accountIds: z.array(z.string()).optional(),
        provider: z.string().optional(),
        includeDisabled: z.boolean().optional(),
        all: z.boolean().optional(),
        sinceDays: z.number().int().positive().optional(),
        fullSync: z.enum(['created_at', 'last_message_at']).optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async (input) => {
      validateSyncInput(input);
      const accounts = selectAccounts(input, store, providers);
      const mode = input.fullSync ? `full-sync:${input.fullSync}` : undefined;

      if (input.dryRun) {
        return makeToolResponse({
          dryRun: true,
          accounts: accounts.map((account) => accountSummary(account, store)),
          options: {
            sinceDays: input.sinceDays,
            mode,
          },
        });
      }

      const results = [];
      for (const account of accounts) {
        const messages = [];
        await server.sendLoggingMessage({
          level: 'info',
          logger: 'chatdump',
          data: { accountId: account.id, message: 'sync started' },
        });

        await scheduler.syncAccount(
          account.id,
          (state, message) => {
            const entry = { state, message: message || '' };
            messages.push(entry);
            server
              .sendLoggingMessage({
                level: state === 'error' ? 'error' : 'info',
                logger: 'chatdump',
                data: { accountId: account.id, ...entry },
              })
              .catch(() => {});
          },
          {
            interactive: false,
            sinceDays: input.sinceDays,
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

      return makeToolResponse({
        synced: results,
        ok: results.every((result) => result.ok),
      });
    },
  );

  server.registerResource(
    'accounts',
    'chatdump://accounts',
    {
      title: 'chatdump accounts',
      description: 'Configured chatdump accounts as JSON.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const accounts = getAccounts().map((account) => accountSummary(account, store));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ accounts }, null, 2),
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error('MCP transport error:', error);
  };
  const closed = new Promise((resolve) => {
    transport.onclose = resolve;
  });

  await server.connect(transport);
  await closed;
}

module.exports = {
  startMcpServer,
  _test: {
    accountSummary,
    selectAccounts,
    validateSyncInput,
  },
};
