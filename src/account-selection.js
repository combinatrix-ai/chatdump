function selectCapableAccount(input, store, providers, method, actionLabel) {
  if (input.accountId) {
    const account = store.getAccount(input.accountId);
    if (!account) throw new Error(`Account not found: ${input.accountId}`);
    if (input.provider && account.provider !== input.provider) {
      throw new Error(
        `Account ${input.accountId} belongs to ${account.provider}, not the requested provider ${input.provider}`,
      );
    }
    assertCapability(account, providers, method, actionLabel);
    return account;
  }

  const providerName = input.provider || 'openai';
  const provider = providers.getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  assertCapability({ provider: providerName }, providers, method, actionLabel);

  const account = store.getAccounts().find((candidate) => candidate.provider === providerName);
  if (!account) {
    throw new Error(`No ${provider.displayName || providerName} account configured`);
  }
  return account;
}

function assertCapability(account, providers, method, actionLabel) {
  const provider = providers.getProvider(account.provider);
  if (!provider) throw new Error(`Unknown provider: ${account.provider}`);
  if (typeof provider[method] !== 'function') {
    throw new Error(
      `${provider.displayName || account.provider} does not support ${actionLabel} yet`,
    );
  }
}

module.exports = { selectCapableAccount };
