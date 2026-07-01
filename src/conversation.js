const { ensureAuthenticated, getSession } = require('./auth');
const store = require('./store');
const providers = require('./providers');

function getConversationProvider(name) {
  const provider = providers.getProvider(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  if (typeof provider.fetchConversationById !== 'function') {
    throw new Error(
      `${provider.displayName || name} does not support conversation fetch by id yet`,
    );
  }
  return provider;
}

function selectConversationAccount(input = {}, storeModule = store, providersModule = providers) {
  if (input.accountId) {
    const account = storeModule.getAccount(input.accountId);
    if (!account) throw new Error(`Account not found: ${input.accountId}`);
    const provider = providersModule.getProvider(account.provider);
    if (!provider) throw new Error(`Unknown provider: ${account.provider}`);
    if (typeof provider.fetchConversationById !== 'function') {
      throw new Error(
        `${provider.displayName || account.provider} does not support conversation fetch by id yet`,
      );
    }
    return account;
  }

  const providerName = input.provider || 'openai';
  const provider = providersModule.getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  if (typeof provider.fetchConversationById !== 'function') {
    throw new Error(
      `${provider.displayName || providerName} does not support conversation fetch by id yet`,
    );
  }

  const account = storeModule
    .getAccounts()
    .find((candidate) => candidate.provider === providerName && candidate.autoSync !== false);
  if (!account) {
    throw new Error(`No enabled ${provider.displayName || providerName} account configured`);
  }
  return account;
}

async function getConversation(input = {}) {
  const conversationId = String(input.conversationId || '').trim();
  if (!conversationId) throw new Error('conversationId is required');

  const account = selectConversationAccount(input);
  const provider = getConversationProvider(account.provider);
  await ensureAuthenticated(account.provider, account.id, { interactive: false });

  const raw = await provider.fetchConversationById(getSession(account.id), conversationId, {
    timeoutMs: input.timeoutMs,
  });
  const markdown = provider.convertToMarkdown(raw);

  return {
    accountId: account.id,
    provider: account.provider,
    conversationId: provider.getId?.(raw) || conversationId,
    title: raw.title || raw.name || '',
    markdown,
    raw,
  };
}

module.exports = {
  getConversation,
  _test: {
    selectConversationAccount,
  },
};
