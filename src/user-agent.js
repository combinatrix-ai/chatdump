function chromeUserAgent(chromeVersion, platform = process.platform) {
  const major = String(chromeVersion || '').split('.')[0];
  if (!/^\d+$/.test(major)) throw new Error(`Invalid Chrome version: ${chromeVersion}`);

  const platformToken =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';

  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

module.exports = { chromeUserAgent };
