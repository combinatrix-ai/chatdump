// Account-add flow, extracted from the tray menu so it can be tested without
// Electron. The tray owns the UI (the provider submenu and the ChatGPT
// side-effect warning); everything below is the bookkeeping that follows a
// successful login: copy cookies into a persistent partition, resolve who
// just logged in, and re-key the account entry under the real email.
//
// Deps are injected (see createTray in tray.js for the production wiring):
//   openLoginWindow(providerName)   -> { session, accountInfo?, cookies? }
//   getSession(accountId)           -> Electron session for that partition
//   upsertAccount/updateAccount/removeAccount/getAccounts  (store)
//   onAccountsChanged()             -> rebuild the menu
//   startInitialSync(accountId)     -> kick off the first sync (fire & forget)
//   now()                           -> Date.now, injectable for tests
//   logger(message)                 -> console.log

async function copyProviderCookies(cookies, targetSession, targetLabel, logger) {
  logger(`[account] Copying ${cookies.length} cookies to ${targetLabel}`);
  for (const cookie of cookies) {
    const details = {
      url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
    };

    if (cookie.sameSite) {
      details.sameSite = cookie.sameSite;
    }

    try {
      await targetSession.cookies.set(details);
    } catch (e) {
      logger(`[account] Cookie copy failed for ${targetLabel}: ${cookie.name}: ${e.message}`);
    }
  }
}

async function clearSessionStorage(ses, label, logger) {
  try {
    await ses.clearStorageData();
    logger(`[account] Cleared session storage for ${label}`);
    return true;
  } catch (e) {
    logger(`[account] Could not clear session storage for ${label}: ${e.message}`);
    return false;
  }
}

// Identify the account that just logged in, cheapest source first. Every
// strategy is best-effort: a provider that exposes none of them (or throws)
// leaves the account under its temporary id, which still works.
async function resolveAccountInfo(provider, loginResult, ses) {
  let info = null;
  try {
    // Strategy 1: the API response the login window fetched for us.
    if (loginResult.accountInfo && provider.parseAccountInfo) {
      info = provider.parseAccountInfo(loginResult.accountInfo);
    }
    // Strategy 2: the provider's own cookies.
    if (!info?.email && loginResult.cookies && provider.parseAccountFromCookies) {
      const cookieInfo = provider.parseAccountFromCookies(loginResult.cookies);
      if (cookieInfo.email || cookieInfo.name) {
        info = { ...info, ...cookieInfo };
      }
    }
    // Strategy 3: an API call on the persistent session.
    if (!info?.email) {
      const apiInfo = await provider.getAccountInfo(ses);
      if (apiInfo) info = { ...info, ...apiInfo };
    }
  } catch {
    /* identification is best-effort */
  }
  return info;
}

// Run the post-login flow for `provider`. Never throws: returns
// { ok: true, accountId } or { ok: false, error }.
async function addAccount(provider, deps) {
  const logger = deps.logger || (() => {});
  const now = deps.now || Date.now;

  let accountId = null;
  let persistSes = null;

  try {
    const loginResult = await deps.openLoginWindow(provider.name);
    const tempSes = loginResult.session;

    try {
      // A timestamped id keeps the entry unique until the real email is known.
      accountId = `${provider.name}:account-${now()}`;
      persistSes = deps.getSession(accountId);
      const cookies = await tempSes.cookies.get({ url: provider.baseUrl });
      await copyProviderCookies(cookies, persistSes, accountId, logger);

      // Save right away so the account shows up in the menu while we identify it.
      deps.upsertAccount({
        id: accountId,
        provider: provider.name,
        email: '',
        name: `${provider.displayName} account`,
        status: 'ok',
      });
      deps.onAccountsChanged();

      const info = await resolveAccountInfo(provider, loginResult, persistSes);

      let syncId = accountId;
      if (info?.email) {
        // Re-key under `provider:email`: drop the temporary partition and
        // copy the same cookies into the real one.
        const realId = `${provider.name}:${info.email}`;
        await clearSessionStorage(deps.getSession(accountId), accountId, logger);
        persistSes = null;
        deps.removeAccount(accountId);

        await copyProviderCookies(cookies, deps.getSession(realId), realId, logger);
        deps.upsertAccount({
          id: realId,
          provider: provider.name,
          email: info.email,
          name: info.name,
          status: 'ok',
        });
        syncId = realId;
      } else if (info?.name) {
        // A name but no email — keep the temporary id and label it.
        deps.updateAccount(accountId, { name: info.name });
      }

      deps.onAccountsChanged();
      deps.startInitialSync(syncId);
      return { ok: true, accountId: syncId };
    } finally {
      // The temporary partition holds live login cookies. Clear it unless it
      // became (or stayed) a real account entry.
      if (accountId && persistSes && !deps.getAccounts().some((a) => a.id === accountId)) {
        await clearSessionStorage(persistSes, accountId, logger);
      }
    }
  } catch (e) {
    logger(`[account] Add account failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { addAccount, _test: { resolveAccountInfo } };
