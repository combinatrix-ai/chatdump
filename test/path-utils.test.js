const assert = require('node:assert/strict');
const test = require('node:test');
const { sanitizeAccountKey, sanitizeFilenameTitle } = require('../src/path-utils');

test('path sanitizers share safe account and filename rules', () => {
  assert.equal(sanitizeAccountKey('user@example.com'), 'user@example.com');
  assert.equal(sanitizeAccountKey('a/b\\c:d'), 'a_b_c_d');
  assert.equal(sanitizeFilenameTitle('a/b title'), 'a_b_title');
  assert.equal(sanitizeFilenameTitle('x'.repeat(100)).length, 80);
});

test('sanitizeFilenameTitle replaces unsafe characters and whitespace, then truncates', () => {
  assert.equal(
    sanitizeFilenameTitle('a/b\\c:d*e?f"g<h>i|j two\tspaces'),
    'a_b_c_d_e_f_g_h_i_j_two_spaces',
  );
  assert.equal(sanitizeFilenameTitle('x'.repeat(100)), 'x'.repeat(80));
});
