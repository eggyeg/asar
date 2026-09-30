const { join } = require('path');

// UI is bundled inside the asar and loaded from disk: no CDN round-trip, works offline,
// and can't be broken by a remote change (the OpenAsar UI was fetched from cdn.openasar.dev on every open).
module.exports = (o, n) => {
  const w = new (require('electron').BrowserWindow)({
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: '#17171c',
    webPreferences: {
      preload: join(__dirname, '..', n, 'preload.js'),
      spellcheck: false,
      backgroundThrottling: false
    },
    ...o
  });

  const c = w.webContents;
  c.once('dom-ready', () => {
    if (oaConfig.themeSync !== false) try {
      const cache = JSON.parse(require('fs').readFileSync(join(require('../paths').getUserData(), 'userDataCache.json'), 'utf8'));
      const css = cache.asarSplashCSS ?? cache.openasarSplashCSS;
      if (css) c.insertCSS(css);
    } catch { }
  });

  c.setWindowOpenHandler(({ url }) => { // External links open in the browser, never in-app
    if (/^https:\/\//.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  w.loadFile(join(__dirname, '..', n, 'index.html'));

  return w;
};
