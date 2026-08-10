const { ensureAuthenticated, getSession } = require('./auth');
const store = require('./store');
const providers = require('./providers');
const { selectCapableAccount } = require('./account-selection');

function selectAskAccount(input = {}, storeModule = store, providersModule = providers) {
  return selectCapableAccount(input, storeModule, providersModule, 'askWithBrowser', 'browser ask');
}

async function askQuestion(input = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  // selectAskAccount already rejected providers without askWithBrowser.
  const account = selectAskAccount(input);
  const provider = providers.getProvider(account.provider);

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
