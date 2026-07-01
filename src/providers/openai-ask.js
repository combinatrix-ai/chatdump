const { BrowserWindow } = require('electron');

const BASE = 'https://chatgpt.com';
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

function clampTimeout(timeoutMs) {
  const parsed = Number.parseInt(timeoutMs, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function extractConversationId(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value, BASE);
    const match = url.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    const match = value.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function waitForPageLoad(win, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error(`Timed out loading ${url}`)), timeoutMs);

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onLoad);
      win.webContents.removeListener('did-fail-load', onFail);
      if (error) reject(error);
      else resolve();
    }

    function onLoad() {
      finish();
    }

    function onFail(_event, _code, description) {
      finish(new Error(`Failed to load ${url}: ${description}`));
    }

    win.webContents.once('did-finish-load', onLoad);
    win.webContents.once('did-fail-load', onFail);
    win.loadURL(url).catch(finish);
  });
}

function evaluate(win, fn, ...args) {
  const source = `(${fn})(...${JSON.stringify(args)})`;
  return win.webContents.executeJavaScript(source, true);
}

function log(message) {
  console.error(`[openai-ask] ${message}`);
}

async function waitFor(win, fn, args, options) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs || 500;
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await evaluate(win, fn, ...(args || []));
      if (result?.ok) return result.value;
      if (result?.error) lastError = result.error;
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${options.label || 'Condition'} timed out${lastError ? `: ${lastError}` : ''}`);
}

function getPageState() {
  const composer =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('[data-testid="prompt-textarea"]') ||
    document.querySelector('textarea') ||
    document.querySelector('[contenteditable="true"]');

  const loginLink = Array.from(document.querySelectorAll('a,button')).find((el) =>
    /log in|sign in|ログイン/i.test(el.textContent || el.getAttribute('aria-label') || ''),
  );

  return {
    ok: Boolean(composer),
    error: loginLink && !composer ? 'login required' : '',
    value: {
      assistantCount: document.querySelectorAll('[data-message-author-role="assistant"]').length,
      href: location.href,
    },
  };
}

function focusComposer() {
  const composer =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('[data-testid="prompt-textarea"]') ||
    document.querySelector('textarea') ||
    document.querySelector('[contenteditable="true"]');

  if (!composer) return { ok: false, error: 'prompt composer not found' };

  composer.focus();
  return { ok: true, value: true };
}

function clickSendButton() {
  const buttons = Array.from(document.querySelectorAll('button'));
  const sendButton = buttons.find((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
    return (
      button.matches('[data-testid="send-button"], [data-testid="composer-submit-button"]') ||
      /send|submit|送信/i.test(label)
    );
  });

  if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
    sendButton.click();
    return { ok: true, value: true };
  }

  return { ok: false, error: 'send button not ready' };
}

function getAssistantSnapshot(beforeCount) {
  const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  const last = messages[messages.length - 1];
  const text = (last?.innerText || '').trim();
  const stopButton = Array.from(document.querySelectorAll('button')).find((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
    return (
      button.matches('[data-testid="stop-button"]') || /stop generating|stop|停止/i.test(label)
    );
  });

  return {
    ok: messages.length > beforeCount && text.length > 0,
    value: {
      count: messages.length,
      generating: Boolean(stopButton),
      text,
      href: location.href,
      conversationId:
        (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] ||
        document.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id') ||
        '',
    },
  };
}

function getConversationLocation() {
  const href = location.href;
  return {
    ok: Boolean((location.pathname.match(/\/c\/([^/?#]+)/) || [])[1]),
    value: {
      href,
      conversationId: (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || '',
    },
  };
}

async function getConversationLocationAfterAnswer(win, fallbackHref) {
  const startedAt = Date.now();
  let latest = null;

  while (Date.now() - startedAt < 10000) {
    latest = await evaluate(win, getConversationLocation);
    if (latest?.ok) return latest.value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const href = latest?.value?.href || fallbackHref || win.webContents.getURL();
  return {
    href,
    conversationId: extractConversationId(href),
  };
}

async function waitForStableAnswer(win, beforeCount, timeoutMs) {
  const startedAt = Date.now();
  let previousText = '';
  let stableCount = 0;
  let latest = null;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await evaluate(win, getAssistantSnapshot, beforeCount);
    if (latest?.ok) {
      const { text, generating } = latest.value;
      if (text === previousText) stableCount++;
      else stableCount = 0;
      previousText = text;

      if (!generating && stableCount >= 2) {
        return latest.value;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (latest?.value?.text) return latest.value;
  throw new Error('Timed out waiting for ChatGPT answer');
}

async function askChatGptInBrowser(ses, options = {}) {
  const timeoutMs = clampTimeout(options.timeoutMs);
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    show: Boolean(options.visible),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
    },
  });

  try {
    log('loading ChatGPT');
    await waitForPageLoad(win, BASE, Math.min(timeoutMs, 60000));
    log('waiting for composer');
    const initialState = await waitFor(win, getPageState, [], {
      timeoutMs: Math.min(timeoutMs, 60000),
      intervalMs: 1000,
      label: 'ChatGPT composer',
    });
    const beforeCount = initialState.assistantCount || 0;

    log('focusing composer');
    await waitFor(win, focusComposer, [], {
      timeoutMs: 10000,
      intervalMs: 500,
      label: 'ChatGPT composer focus',
    });
    log('inserting prompt');
    await win.webContents.insertText(options.prompt);
    await new Promise((resolve) => setTimeout(resolve, 500));

    log('submitting prompt');
    try {
      await waitFor(win, clickSendButton, [], {
        timeoutMs: 10000,
        intervalMs: 500,
        label: 'ChatGPT send button',
      });
    } catch {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    log('waiting for answer');
    const answer = await waitForStableAnswer(win, beforeCount, timeoutMs);
    const location = await getConversationLocationAfterAnswer(win, answer.href);
    log(`answer received conversationId=${location.conversationId || answer.conversationId || ''}`);
    return {
      answer: answer.text,
      url: location.href || answer.href || win.webContents.getURL(),
      conversationId: location.conversationId || answer.conversationId || '',
    };
  } finally {
    if (!options.visible && !win.isDestroyed()) win.close();
  }
}

module.exports = {
  askChatGptInBrowser,
  _test: {
    clampTimeout,
    extractConversationId,
  },
};
