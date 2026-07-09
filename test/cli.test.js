const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs } = require('../src/cli');
const { main } = require('../src/cli-entry');

test('parseArgs parses sync selectors and options', () => {
  const options = parseArgs([
    'sync',
    '--account',
    'openai:user@example.com',
    '--since-days=7',
    '--json',
  ]);

  assert.equal(options.command, 'sync');
  assert.deepEqual(options.accountIds, ['openai:user@example.com']);
  assert.equal(options.sinceDays, 7);
  assert.equal(options.json, true);
});

test('parseArgs parses full sync mode', () => {
  const options = parseArgs(['sync', '--provider', 'openai', '--full-sync', 'created_at']);

  assert.equal(options.provider, 'openai');
  assert.equal(options.mode, 'full-sync:created_at');
});

test('parseArgs accepts mcp command', () => {
  const options = parseArgs(['mcp']);

  assert.equal(options.command, 'mcp');
});

test('parseArgs parses fetch ref and options', () => {
  const options = parseArgs([
    'fetch',
    'https://chatgpt.com/share/abc123',
    '--account',
    'openai:user@example.com',
    '--provider=openai',
    '--json',
  ]);

  assert.equal(options.command, 'fetch');
  assert.equal(options.conversationId, 'https://chatgpt.com/share/abc123');
  assert.deepEqual(options.accountIds, ['openai:user@example.com']);
  assert.equal(options.provider, 'openai');
  assert.equal(options.json, true);
});

test('parseArgs rejects fetch without a ref', () => {
  assert.throws(() => parseArgs(['fetch', '--json']), /requires a url or conversation id/);
});

test('parseArgs rejects fetch with multiple refs', () => {
  assert.throws(() => parseArgs(['fetch', 'c1', 'c2']), /exactly one url or conversation id/);
});

test('parseArgs rejects incompatible sync modes', () => {
  assert.throws(
    () => parseArgs(['sync', '--since-days', '7', '--full-sync', 'created_at']),
    /cannot be used together/,
  );
});

test('cli-entry fetch delegates to mcp.conversation and prints markdown only', async () => {
  const stdout = [];
  const stderr = [];
  let request;

  const exitCode = await main(
    [
      'fetch',
      'https://chatgpt.com/share/abc123',
      '--account',
      'openai:user@example.com',
      '--provider',
      'openai',
    ],
    {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      requestData: async (cmd, args) => {
        request = { cmd, args };
        return {
          accountId: 'openai:user@example.com',
          provider: 'openai',
          conversationId: 'abc123',
          shared: true,
          title: 'Shared chat',
          markdown: '# Shared chat\n\nHello',
          raw: { providerPayload: true },
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(request, {
    cmd: 'mcp.conversation',
    args: {
      conversationId: 'https://chatgpt.com/share/abc123',
      accountId: 'openai:user@example.com',
      provider: 'openai',
    },
  });
  assert.deepEqual(stdout, ['# Shared chat\n\nHello']);
  assert.deepEqual(stderr, []);
});

test('cli-entry fetch --json strips raw provider payload', async () => {
  const stdout = [];

  const exitCode = await main(['fetch', 'c1', '--json'], {
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: () => {} },
    requestData: async () => ({
      accountId: 'openai:user@example.com',
      provider: 'openai',
      conversationId: 'c1',
      shared: false,
      title: 'Conversation',
      markdown: 'body',
      raw: { providerPayload: true },
    }),
  });

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout.join(''));
  assert.equal(parsed.markdown, 'body');
  assert.equal(parsed.raw, undefined);
});
