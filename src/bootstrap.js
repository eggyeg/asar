const { app, session } = require('electron');
const { readFileSync } = require('fs');
const { join } = require('path');

if (!settings.get('enableHardwareAcceleration', true)) app.disableHardwareAcceleration();
process.env.PULSE_LATENCY_MSEC = process.env.PULSE_LATENCY_MSEC ?? 30;

const buildInfo = require('./utils/buildInfo');
app.setVersion(buildInfo.version);
global.releaseChannel = buildInfo.releaseChannel;

log('BuildInfo', buildInfo.releaseChannel, buildInfo.version);

const Constants = require('./Constants');
app.setAppUserModelId(Constants.APP_ID);

if (buildInfo.releaseChannel !== 'stable' && process.platform === 'linux') {
  app.setName(app.getName() + '-' + buildInfo.releaseChannel);
}

const fatal = e => log('Fatal', e);
process.on('uncaughtException', console.error);

const splash = require('./splash');
const updater = require('./updater/updater');
const moduleUpdater = require('./updater/moduleUpdater');
const autoStart = require('./autoStart');

const env = k => process.env['ASAR_' + k] ?? process.env['OPENASAR_' + k];

let desktopCore, mainWindow;

// Bring the main window back no matter what state it is in (minimized, hidden to tray, behind other windows)
const restoreMain = () => {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!w) return splash.focusWindow();

  try { desktopCore?.setMainWindowVisible?.(true); } catch { }
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
};

// Physical key (KeyO), so it works on every keyboard layout (on Ukrainian/Russian layouts the O key types "щ")
const isHotkey = i => i.type === 'keyDown' && (process.platform === 'darwin' ? i.meta : i.control) && i.alt && !i.shift && (i.code === 'KeyO' || i.key?.toLowerCase() === 'o');
const hotkeyLabel = process.platform === 'darwin' ? 'Cmd + Option + O' : 'Ctrl + Alt + O';

// Startup timing, shown in asar settings so you can see how fast Discord opens
const recordLaunch = () => {
  try {
    const t = Math.round(process.uptime() * 100) / 100;
    const prev = settings.get('asarStats', []);
    const list = [ ...(Array.isArray(prev) ? prev : []), { t, at: Date.now(), v: asarVersion } ].slice(-10);
    settings.set('asarStats', list);
    settings.save();
    log('Startup', `Discord window ready ${t}s after launch`);
  } catch { }
};

const launchStats = () => {
  const list = settings.get('asarStats', []);
  if (!Array.isArray(list) || !list.length) return null;
  const last = list[list.length - 1].t;
  const recent = list.slice(-5);
  return { last, avg: recent.length > 1 ? recent.reduce((a, x) => a + x.t, 0) / recent.length : null, n: recent.length };
};

// Raise Discord's processes above other apps so it stays responsive while games/browsers are busy (Windows only;
// other platforms need root to raise priority)
const boostPriority = () => {
  if (process.platform !== 'win32' || oaConfig.priority === false) return;
  const os = require('os');
  for (const m of app.getAppMetrics()) {
    if (![ 'Browser', 'Tab', 'GPU' ].includes(m.type)) continue;
    try { os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { }
  }
};

const startCore = () => {
  if (oaConfig.js || oaConfig.css) session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    delete d.responseHeaders['content-security-policy'];
    delete d.responseHeaders['Content-Security-Policy'];
    cb(d);
  });

  require('./config'); // Registers the IPC that opens asar settings (window itself only opens when you ask)

  // Read the injected renderer script once (OpenAsar re-read + re-templated it on every dom-ready)
  const injectedSrc = readFileSync(join(__dirname, 'mainWindow.js'), 'utf8');
  const injected = () => injectedSrc.replace('__ASAR_CFG__', () => JSON.stringify({
    version: asarVersion,
    noTrack: oaConfig.noTrack !== false,
    domOpt: oaConfig.domOptimizer !== false,
    themeSync: oaConfig.themeSync !== false,
    entry: oaConfig.settingsEntry !== false,
    noBlur: oaConfig.noBlur !== false,
    instant: oaConfig.instantUI !== false,
    hotkey: hotkeyLabel,
    stats: launchStats(),
    css: oaConfig.css ?? ''
  }));

  let firstReady = true;
  app.on('browser-window-created', (e, bw) => {
    bw.webContents.on('dom-ready', () => {
      if (!bw.resizable) return; // Main window (and popouts) only - not our splash/config
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = global.asarMainWindow = bw;

      if (firstReady) {
        firstReady = false;
        recordLaunch();
        setTimeout(boostPriority, 2000); // after GPU/renderer processes exist
      }

      splash.pageReady(); // Show main window as soon as the DOM is ready instead of waiting on Core

      bw.webContents.executeJavaScript(injected()).catch(e => log('Inject', e));
      if (oaConfig.js) bw.webContents.executeJavaScript(oaConfig.js).catch(e => log('Inject', 'Custom JS', e));
    });

    // Hotkey that always opens asar settings, even if Discord changes its settings UI again
    if (oaConfig.hotkey !== false) bw.webContents.on('before-input-event', (ev, i) => {
      if (!isHotkey(i)) return;
      ev.preventDefault();
      require('./config').open();
    });
  });

  desktopCore = require('discord_desktop_core');

  const stub = () => new Proxy({}, {
    get: (target, prop) => target[prop] ??= () => { }
  });
  const desktopTTI = stub();

  desktopCore.startup({
    splashScreen: splash,
    moduleUpdater,
    buildInfo,
    Constants,
    updater,
    autoStart,

    appSettings: require('./appSettings'),
    paths: require('./paths'),

    // Stubs
    GPUSettings: { replace: () => { } },
    crashReporterSetup: {
      isInitialized: () => true,
      getGlobalSentry: () => null,
      metadata: {}
    },
    logger: {
      createLogger: () => ({ error: () => { }, info: () => { }, warn: () => { } }),
      initializeLogging: () => { },
      ipcMainRendererLogger: () => { }
    },
    analytics: new Proxy({}, {
      get: (target, prop) => {
        if (prop === 'getDesktopTTI') return () => desktopTTI;
        return target[prop] ??= () => { };
      }
    })
  });
};

const startUpdate = () => {
  const noTrack = oaConfig.noTrack !== false;
  const urls = [
    ...(noTrack ? [ 'https://*/api/*/science', 'https://*/api/*/metrics', 'https://*/error-reporting-proxy/*', 'https://*.sentry.io/*' ] : []),
    ...(oaConfig.noTyping === true ? [ 'https://*/api/*/typing' ] : [])
  ];

  if (urls.length > 0) session.defaultSession.webRequest.onBeforeRequest({ urls }, (e, cb) => cb({ cancel: true }));

  const startMin = process.argv?.includes?.('--start-minimized');
  if (Constants.USE_NEW_UPDATER && updater.tryInitUpdater(buildInfo, Constants.NEW_UPDATE_ENDPOINT, Constants.USE_RUST_BSPATCH)) {
    const inst = updater.getUpdater();

    inst.on('host-updated', () => autoStart.update(() => { }));
    inst.on('unhandled-exception', fatal);
    inst.on('InconsistentInstallerState', fatal);
    inst.on('update-error', console.error);

    require('./firstRun').do();
  } else {
    moduleUpdater.init(Constants.UPDATE_ENDPOINT, buildInfo);
  }

  splash.events.once('APP_SHOULD_LAUNCH', () => {
    if (!env('NOSTART')) startCore();
  });

  let done;
  splash.events.once('APP_SHOULD_SHOW', () => {
    if (done) return;
    done = true;

    desktopCore.setMainWindowVisible(!startMin);

    setTimeout(() => {
      if (env('SMOKE')) { // CI: proves a real Discord client booted all the way through asar
        console.log('ASAR_SMOKE_OK');
        return app.exit(0);
      }

      if (oaConfig.autoupdate !== false) require('./asarUpdate')().then(r => {
        log('AsarUpdate', r);
        if (!/^Updated/.test(r)) return;

        const { Notification } = require('electron');
        if (Notification.isSupported()) new Notification({ title: 'asar updated', body: 'Restart Discord to use the new version.' }).show();
      });

      try { require('module').flushCompileCache?.(); } catch { }
    }, 3000);
  });

  splash.initSplash(startMin);
};


module.exports = () => {
  app.on('second-instance', (e, a) => {
    const url = a.includes('--url') && a[a.indexOf('--') + 1];
    desktopCore?.handleOpenUrl?.(url);

    // Launching Discord again (shortcut, taskbar, start menu) should bring the existing window back
    if (!a.includes('--start-minimized')) restoreMain();
  });

  if (!app.requestSingleInstanceLock() && !(process.argv?.includes?.('--multi-instance') || oaConfig.multiInstance === true)) return app.quit();

  app.whenReady().then(startUpdate);
};

module.exports.restoreMain = restoreMain;
