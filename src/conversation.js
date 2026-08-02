const { ensureAuthenticated, getSession } = require('./auth');
const store = require('./store');
const providers = require('./providers');
const { selectCapableAccount } = require('./account-selection');

const SHARE_URL_RE = /chatgpt\.com\/share\/(?:e\/)?([A-Za-z0-9-]+)/i;
const CONVERSATION_URL_RE = /chatgpt\.com\/(?:c|g\/[^/]+\/c)\/([0-9a-f-]{36})/i;

// Accepts a raw id, a normal conversation URL (…/c/<id>), or a share URL (…/share/<id>).
// Returns { kind: 'share' | 'conversation', id }.
function parseConversationRef(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('conversationId is required');

  const share = value.match(SHARE_URL_RE);
  if (share) return { kind: 'share', id: share[1] };

  const conv = value.match(CONVERSATION_URL_RE);
  if (conv) return { kind: 'conversation', id: conv[1] };

  if (/^https?:\/\//i.test(value)) {
    throw new Error(`Unrecognized ChatGPT URL: ${value}`);
  }
  return { kind: 'conversation', id: value };
}

function requiredFetchMethod(kind) {
  return kind === 'share' ? 'fetchSharedConversationById' : 'fetchConversationById';
}

function unsupportedMessage(provider, name, kind) {
  const label = provider.displayName || name;
  return kind === 'share'
    ? `${label} does not support fetching shared conversations yet`
    : `${label} does not support conversation fetch by id yet`;
}

function getConversationProvider(name, kind = 'conversation') {
  const provider = providers.getProvider(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  if (typeof provider[requiredFetchMethod(kind)] !== 'function') {
    throw new Error(unsupportedMessage(provider, name, kind));
  }
  return provider;
}

function selectConversationAccount(
  input = {},
  kind = 'conversation',
  storeModule = store,
  providersModule = providers,
) {
  return selectCapableAccount(
    input,
    storeModule,
    providersModule,
    requiredFetchMethod(kind),
    kind === 'share' ? 'fetching shared conversations' : 'conversation fetch by id',
  );
}

async function getConversation(input = {}) {
  const ref = input.shareId
    ? { kind: 'share', id: String(input.shareId).trim() }
    : parseConversationRef(input.conversationId);

  const account = selectConversationAccount(input, ref.kind);
  const provider = getConversationProvider(account.provider, ref.kind);
  await ensureAuthenticated(account.provider, account.id, { interactive: false });

  const raw =
    ref.kind === 'share'
      ? await provider.fetchSharedConversationById(getSession(account.id), ref.id, {
          timeoutMs: input.timeoutMs,
        })
      : await provider.fetchConversationById(getSession(account.id), ref.id, {
          timeoutMs: input.timeoutMs,
        });
  const markdown = provider.convertToMarkdown(raw);

  return {
    accountId: account.id,
    provider: account.provider,
    conversationId: provider.getId?.(raw) || ref.id,
    shared: ref.kind === 'share',
    title: raw.title || raw.name || '',
    markdown,
    raw,
  };
}

module.exports = {
  getConversation,
  _test: {
    selectConversationAccount,
    parseConversationRef,
  },
};
