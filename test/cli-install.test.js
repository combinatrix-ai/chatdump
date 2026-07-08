const assert = require('node:assert/strict');
const test = require('node:test');

const {
  _test: {
    CLI_NAME,
    pickWritableTarget,
    computeInstallStatus,
    linkIntoTarget,
    shellQuoteSingle,
    appleScriptQuoteDouble,
  },
} = require('../src/cli-install');

const W_OK = 2;

function makeFsStub({ dirs = [], writable = [], symlinks = {}, files = new Set() } = {}) {
  return {
    constants: { W_OK },
    existsSync: (p) => dirs.includes(p) || files.has(p) || Object.hasOwn(symlinks, p),
    accessSync: (p, mode) => {
      if (mode === W_OK && !writable.includes(p)) {
        const e = new Error(`EACCES: permission denied, access '${p}'`);
        e.code = 'EACCES';
        throw e;
      }
    },
    lstatSync: (p) => {
      if (Object.hasOwn(symlinks, p)) {
        return { isSymbolicLink: () => true };
      }
      if (files.has(p)) {
        return { isSymbolicLink: () => false };
      }
      const e = new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      e.code = 'ENOENT';
      throw e;
    },
    realpathSync: (p) => {
      if (Object.hasOwn(symlinks, p)) return symlinks[p];
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), {
        code: 'ENOENT',
      });
    },
    rmSync: () => {},
    symlinkSync: () => {},
  };
}

test('pickWritableTarget returns the first existing + writable candidate', () => {
  const fsStub = makeFsStub({
    dirs: ['/opt/homebrew/bin', '/usr/local/bin'],
    writable: ['/usr/local/bin'],
  });

  assert.equal(
    pickWritableTarget(['/opt/homebrew/bin', '/usr/local/bin'], fsStub),
    '/usr/local/bin',
  );
});

test('pickWritableTarget skips dirs that do not exist', () => {
  const fsStub = makeFsStub({ dirs: ['/usr/local/bin'], writable: ['/usr/local/bin'] });

  assert.equal(
    pickWritableTarget(['/opt/homebrew/bin', '/usr/local/bin'], fsStub),
    '/usr/local/bin',
  );
});

test('pickWritableTarget returns null when nothing is writable', () => {
  const fsStub = makeFsStub({ dirs: ['/opt/homebrew/bin', '/usr/local/bin'], writable: [] });

  assert.equal(pickWritableTarget(['/opt/homebrew/bin', '/usr/local/bin'], fsStub), null);
});

test('computeInstallStatus reports installed when a candidate symlink resolves to the wrapper', () => {
  const wrapperRealPath = '/Applications/chatdump.app/Contents/Resources/bin/chatdump';
  const fsStub = makeFsStub({
    symlinks: { [`/usr/local/bin/${CLI_NAME}`]: wrapperRealPath },
  });

  const status = computeInstallStatus(
    ['/opt/homebrew/bin', '/usr/local/bin'],
    wrapperRealPath,
    fsStub,
  );
  assert.deepEqual(status, { installed: true, path: `/usr/local/bin/${CLI_NAME}` });
});

test('computeInstallStatus reports not installed when symlink points at a different (stale) bundle', () => {
  const wrapperRealPath = '/Applications/chatdump.app/Contents/Resources/bin/chatdump';
  const fsStub = makeFsStub({
    symlinks: {
      [`/usr/local/bin/${CLI_NAME}`]:
        '/Users/me/Downloads/chatdump.app/Contents/Resources/bin/chatdump',
    },
  });

  const status = computeInstallStatus(
    ['/opt/homebrew/bin', '/usr/local/bin'],
    wrapperRealPath,
    fsStub,
  );
  assert.deepEqual(status, { installed: false, path: null });
});

test('computeInstallStatus reports not installed when nothing exists at any candidate', () => {
  const fsStub = makeFsStub({});
  const status = computeInstallStatus(
    ['/opt/homebrew/bin', '/usr/local/bin'],
    '/Applications/chatdump.app/Contents/Resources/bin/chatdump',
    fsStub,
  );
  assert.deepEqual(status, { installed: false, path: null });
});

test('computeInstallStatus ignores a regular file (not a symlink) at the candidate path', () => {
  const fsStub = makeFsStub({ files: new Set([`/usr/local/bin/${CLI_NAME}`]) });
  const status = computeInstallStatus(
    ['/usr/local/bin'],
    '/Applications/chatdump.app/Contents/Resources/bin/chatdump',
    fsStub,
  );
  assert.deepEqual(status, { installed: false, path: null });
});

test('linkIntoTarget creates the symlink when nothing exists yet', () => {
  const calls = [];
  const fsStub = makeFsStub({});
  fsStub.symlinkSync = (wrapperPath, symlinkPath) =>
    calls.push(['symlink', wrapperPath, symlinkPath]);
  fsStub.rmSync = () => calls.push(['rm']);

  const result = linkIntoTarget('/usr/local/bin', '/wrapper/chatdump', fsStub);

  assert.equal(result, `/usr/local/bin/${CLI_NAME}`);
  assert.deepEqual(calls, [['symlink', '/wrapper/chatdump', `/usr/local/bin/${CLI_NAME}`]]);
});

test('linkIntoTarget replaces a pre-existing symlink', () => {
  const calls = [];
  const fsStub = makeFsStub({ symlinks: { [`/usr/local/bin/${CLI_NAME}`]: '/old/wrapper' } });
  fsStub.symlinkSync = (wrapperPath, symlinkPath) =>
    calls.push(['symlink', wrapperPath, symlinkPath]);
  fsStub.rmSync = (p) => calls.push(['rm', p]);

  const result = linkIntoTarget('/usr/local/bin', '/wrapper/chatdump', fsStub);

  assert.equal(result, `/usr/local/bin/${CLI_NAME}`);
  assert.deepEqual(calls, [
    ['rm', `/usr/local/bin/${CLI_NAME}`],
    ['symlink', '/wrapper/chatdump', `/usr/local/bin/${CLI_NAME}`],
  ]);
});

test('linkIntoTarget refuses to clobber a regular (non-symlink) file', () => {
  const fsStub = makeFsStub({ files: new Set([`/usr/local/bin/${CLI_NAME}`]) });

  assert.throws(
    () => linkIntoTarget('/usr/local/bin', '/wrapper/chatdump', fsStub),
    /not a symlink chatdump manages/,
  );
});

test('shellQuoteSingle escapes embedded single quotes', () => {
  assert.equal(
    shellQuoteSingle("/Applications/it's here/chatdump"),
    "'/Applications/it'\\''s here/chatdump'",
  );
  assert.equal(shellQuoteSingle('/simple/path'), "'/simple/path'");
});

test('appleScriptQuoteDouble escapes backslashes and double quotes', () => {
  assert.equal(appleScriptQuoteDouble('a "quoted" \\value'), 'a \\"quoted\\" \\\\value');
});
