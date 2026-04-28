const claude = require('./claude');
const openai = require('./openai');
const gemini = require('./gemini');

const providers = { claude, openai, gemini };

function getProvider(name) {
  return providers[name] || null;
}

function allProviders() {
  return Object.values(providers);
}

module.exports = { getProvider, allProviders };
