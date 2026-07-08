const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs } = require('../src/cli');

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

test('parseArgs rejects incompatible sync modes', () => {
  assert.throws(
    () => parseArgs(['sync', '--since-days', '7', '--full-sync', 'created_at']),
    /cannot be used together/,
  );
});
