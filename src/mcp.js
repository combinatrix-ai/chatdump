// Pure-node thin MCP stdio server. Runs under ELECTRON_RUN_AS_NODE (same as
// src/cli-entry.js), so this module MUST NOT require('electron') or any
// electron-only module (store/ask/conversation/scheduler/providers). Every
// tool delegates to the running GUI over the IPC socket (see
// src/ipc-client.js / src/ipc-server.js) -- the GUI is the only process that
// touches the Chromium session/cookies, so there is only ever one Electron
// process, matching the CLI's list/sync delegation.
const packageJson = require('../package.json');
const { requestData, requestStream } = require('./ipc-client');

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

// Fail fast on an obviously invalid sync input without a round-trip to (and
// possible launch of) the GUI. The GUI's ipc-server also validates this
// (see handleMcpSync/validateMcpSyncInput in src/ipc-server.js) so this is a
// convenience, not the source of truth.
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

      const result = await requestData('mcp.ask', input);

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
      const result = await requestData('mcp.conversation', input);
      return makeToolResponse(result);
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
      const result = await requestData('mcp.accounts', input);
      return makeToolResponse(result);
    },
  );

  server.registerTool(
    'sync',
    {
      title: 'Sync chatdump accounts',
      description:
        'Sync configured chatdump accounts to their destination folders using existing login sessions.',
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

      const result = await requestStream('mcp.sync', input, (progress) => {
        server
          .sendLoggingMessage({
            level: progress.state === 'error' ? 'error' : 'info',
            logger: 'chatdump',
            data: {
              accountId: progress.accountId,
              state: progress.state,
              message: progress.message,
            },
          })
          .catch(() => {});
      });

      return makeToolResponse(result);
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
      const result = await requestData('mcp.accounts', {});
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
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
    validateSyncInput,
  },
};
