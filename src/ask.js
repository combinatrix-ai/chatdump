const { ensureAuthenticated, getSession } = require('./auth');
const store = require('./store');
const providers = require('./providers');
const { selectCapableAccount } = require('./account-selection');

function getAskCapableProvider(name) {
  const provider = providers.getProvider(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  if (typeof provider.askWithBrowser !== 'function') {
    throw new Error(`${provider.displayName || name} does not support browser ask yet`);
  }
  return provider;
}

function selectAskAccount(input = {}, storeModule = store, providersModule = providers) {
  return selectCapableAccount(input, storeModule, providersModule, 'askWithBrowser', 'browser ask');
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
