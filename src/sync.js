const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');

async function gitSync(vaultPath) {
  const gitDir = path.join(vaultPath, '.git');
  if (!fs.existsSync(gitDir)) {
    console.log('Vault is not a git repo, skipping git sync');
    return { skipped: true };
  }

  const git = simpleGit(vaultPath);

  try {
    await git.add('raw/claude-ai/*');
    const status = await git.status();

    if (status.staged.length === 0) {
      console.log('No changes to commit');
      return { committed: false };
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await git.commit(`sync: claude.ai conversations (${timestamp})`);

    // Try push, but don't fail if no remote
    try {
      await git.push();
    } catch (e) {
      console.log('Push failed (no remote?): ', e.message);
    }

    return { committed: true };
  } catch (e) {
    console.error('Git sync error:', e.message);
    return { error: e.message };
  }
}

module.exports = { gitSync };
