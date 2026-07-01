const { ensureAuthenticated, getSession } = require('./auth');
const store = require('./store');
const providers = require('./providers');

function getAskCapableProvider(name) {
  const provider = providers.getProvider(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  if (typeof provider.askWithBrowser !== 'function') {
    throw new Error(`${provider.displayName || name} does not support browser ask yet`);
  }
  return provider;
}

function selectAskAccount(input = {}, storeModule = store, providersModule = providers) {
  const accounts = storeModule.getAccounts();

  if (input.accountId) {
    const account = storeModule.getAccount(input.accountId);
    if (!account) throw new Error(`Account not found: ${input.accountId}`);
    const provider = providersModule.getProvider(account.provider);
    if (!provider) throw new Error(`Unknown provider: ${account.provider}`);
    if (typeof provider.askWithBrowser !== 'function') {
      throw new Error(
        `${provider.displayName || account.provider} does not support browser ask yet`,
      );
    }
    return account;
  }

  const providerName = input.provider || 'openai';
  const provider = providersModule.getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  if (typeof provider.askWithBrowser !== 'function') {
    throw new Error(`${provider.displayName || providerName} does not support browser ask yet`);
  }

  const account = accounts.find(
    (candidate) => candidate.provider === providerName && candidate.autoSync !== false,
  );
  if (!account) {
    throw new Error(`No enabled ${provider.displayName || providerName} account configured`);
  }
  return account;
}

async function askQuestion(input = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  const account = selectAskAccount(input);
  const provider = getAskCapableProvider(account.provider);

  await ensureAuthenticated(account.provider, account.id, { interactive: false });

  const result = await provider.askWithBrowser(getSession(account.id), {
    prompt,
    timeoutMs: input.timeoutMs,
    visible: Boolean(input.visible),
  });

  return {
    accountId: account.id,
    provider: account.provider,
    answer: result.answer,
    url: result.url || '',
    conversationId: result.conversationId || '',
  };
}

module.exports = {
  askQuestion,
  _test: {
    selectAskAccount,
  },
};
