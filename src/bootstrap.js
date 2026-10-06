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
const debug = require('./debug');

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

// Most-used channels (visit count, decayed by how long ago), for "keep top channels ready"
const topChannels = () => {
  const v = settings.get('asarVisits', {});
  const now = Date.now();
  return Object.entries(v && typeof v === 'object' ? v : {})
    .map(([ c, e ]) => ({ c, g: e.g, s: e.n / (1 + (now - e.t) / 86400000) }))
    .sort((a, b) => b.s - a.s).slice(0, 30).map(({ c, g }) => ({ c, g }));
};

const launchStats = () => {
  const list = settings.get('asarStats', []);
  if (!Array.isArray(list) || !list.length) return null;
  const last = list[list.length - 1].t;
  const recent = list.slice(-5);
  return { last, avg: recent.length > 1 ? recent.reduce((a, x) => a + x.t, 0) / recent.length : null, n: recent.length };
};

// Opt-in: raise ALL of Discord's processes above other apps (Windows only). 1.1 raised only the UI, GPU and main
// processes, which starved Discord's own network and audio/video processes while a heavy channel was rendering.
const pure = global.asarPure = oaConfig.pure === true; // "Test as stock Discord": asar changes nothing but measures

const boostPriority = () => {
  if (process.platform !== 'win32' || oaConfig.priority !== true || oaConfig.safeMode || pure) return;
  const os = require('os');
  for (const m of app.getAppMetrics()) {
    try { os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { }
  }
};

// --- Freeze watchdog ---
// Records every time Discord's window stops responding or the GPU process dies. If that happens while one of asar's
// optional speed-ups is on, asar switches them all off (safe mode) and tells you, so a bad setting can't keep
// freezing Discord.
const freezes = global.asarFreezes = { count: 0, longest: 0, gpu: 0, events: [] };

const saveFreezes = () => {
  try {
    const f = join(require('./paths').getUserData(), 'asar-freezes.json');
    let all = [];
    try { all = JSON.parse(readFileSync(f, 'utf8')); } catch { }
    require('fs').writeFileSync(f, JSON.stringify([ ...all, ...freezes.events.splice(0) ].slice(-50), null, 2));
  } catch { }
};

const riskyOn = () => {
  const preset = require('./cmdSwitches').presetName();
  // Anything asar changes that could slow Discord down: flags, priority, page changes, the user's own CSS/JS
  return preset === 'gpu' || oaConfig.priority === true || oaConfig.prefetch !== false || oaConfig.keepReady !== false || oaConfig.instantSwitch !== false || oaConfig.warmSettings !== false || oaConfig.pickerTune !== false || oaConfig.domOptimizer === true || !!(oaConfig.customFlags ?? '').trim()
    || oaConfig.instantUI !== false || oaConfig.noBlur !== false || !!(oaConfig.css ?? '').trim() || !!(oaConfig.js ?? '').trim();
};

const enterSafeMode = reason => {
  if (oaConfig.safeMode || !riskyOn()) return;
  const c = { ...oaConfig, safeMode: true, safeModeReason: reason, safeModeAt: Date.now() };
  global.oaConfig = c;
  settings.set('asar', c);
  settings.save();
  log('Watchdog', 'Safe mode on:', reason);
  debug.ev('safe-mode', { reason });

  const { Notification } = require('electron');
  if (Notification.isSupported()) new Notification({
    title: 'asar turned on safe mode',
    body: `Discord froze (${reason}). asar turned off its optional speed-ups. Restart Discord to apply.`
  }).show();
};

let lastFreezeAt = 0;
const recordFreeze = (kind, ms, extra) => {
  // The page heartbeat and Electron's unresponsive event can both see the same freeze; count it once
  if (kind !== 'gpu') {
    if (Date.now() - lastFreezeAt < 15000) return;
    lastFreezeAt = Date.now();
  }
  const ev = { at: new Date().toISOString(), kind, ms, preset: require('./cmdSwitches').presetName(), ...extra };
  freezes.events.push(ev);
  debug.ev('freeze', { kind, ms, ...extra });
  if (kind !== 'gpu') { freezes.count++; freezes.longest = Math.max(freezes.longest, ms); }
  if (kind === 'gpu') freezes.gpu++;
  log('Watchdog', kind, ms ? ms + 'ms' : '', extra ?? '');
  saveFreezes();
  if (kind !== 'gpu' && (ms >= 8000 || freezes.count >= 2)) enterSafeMode(`Discord froze for ${Math.round(ms / 1000)} s`);
};
global.asarRecordFreeze = recordFreeze;

// Main-process stall monitor: Discord's main process handles IPC from the page and the voice/stream engine. If it's
// blocked, opening channels and starting/stopping streams wait on it. Logged (not used for safe mode).
const mainStalls = global.asarMainStalls = { count: 0, longest: 0 };
const watchMainLoop = () => {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - 500;
    last = now;
    if (lag > (global.asarLagMax ?? 0)) global.asarLagMax = lag; // worst lag per debug sample
    if (lag < 1000) return;
    mainStalls.count++;
    mainStalls.longest = Math.max(mainStalls.longest, lag);
    debug.ev('stall', { ms: lag });
    freezes.events.push({ at: new Date().toISOString(), kind: 'main', ms: lag });
    log('Watchdog', 'main process stalled', lag + 'ms');
    saveFreezes();
  }, 500).unref?.();
};

app.on('child-process-gone', (e, d) => {
  if (d.type !== 'GPU' || d.reason === 'clean-exit') return;
  recordFreeze('gpu', 0, { reason: d.reason, exitCode: d.exitCode });
  enterSafeMode('the graphics process ' + (d.reason === 'killed' ? 'hung' : d.reason));
});

const watchWindow = bw => {
  let since = 0;
  bw.on('unresponsive', () => { since = Date.now(); });
  bw.on('responsive', () => {
    if (!since) return;
    const ms = Date.now() - since;
    since = 0;
    recordFreeze('window', ms + 5000); // the event itself only fires after ~5 s without a response
  });
};

// --- Faster screen-share picker ---
// The Go Live picker asks for a thumbnail of every window and screen, repeatedly while it's open, and they're
// PNG-encoded in Discord's main process. Thumbnails are capped at the size the picker shows (measured: encoding 10
// sources takes 873 ms at 1920x1080 vs 51 ms at 480x270), identical requests in flight are shared, and a repeat
// within 1.5 s gets the last result instead of capturing everything again. Sources without thumbnails (used when
// the stream actually starts) are never cached.
const picker = global.asarPicker = { calls: 0, captures: 0, totalMs: 0, requested: null, used: null };
const tuneScreenPicker = () => {
  const tune = oaConfig.pickerTune !== false && !pure && !oaConfig.safeMode; // otherwise only measured (for debug logs)
  try {
    const { desktopCapturer } = require('electron');
    const orig = desktopCapturer.getSources.bind(desktopCapturer);
    const MAX_W = 480, MAX_H = 270;
    let inflight = null, cache = null;

    desktopCapturer.getSources = (opts = {}) => {
      picker.calls++;
      const o = { ...opts };
      const ts = o.thumbnailSize;
      picker.requested = ts ? ts.width + 'x' + ts.height : 'default (150x150)';
      if (tune && ts && ts.width > 0 && ts.height > 0 && (ts.width > MAX_W || ts.height > MAX_H)) {
        const s = Math.min(MAX_W / ts.width, MAX_H / ts.height);
        o.thumbnailSize = { width: Math.max(1, Math.round(ts.width * s)), height: Math.max(1, Math.round(ts.height * s)) };
      }
      picker.used = o.thumbnailSize ? o.thumbnailSize.width + 'x' + o.thumbnailSize.height : picker.requested;
      const note = { asked: picker.requested, made: picker.used, types: Array.isArray(o.types) ? o.types.join('+') : undefined };

      const key = JSON.stringify(o);
      const thumbs = !(o.thumbnailSize && (o.thumbnailSize.width === 0 || o.thumbnailSize.height === 0));
      if (tune && thumbs && cache && cache.key === key && Date.now() - cache.at < 1500) { debug.ev('picker', { ...note, ms: 0, sources: cache.res?.length, cached: true }); return Promise.resolve(cache.res); }
      if (tune && inflight && inflight.key === key) { debug.ev('picker', { ...note, shared: true }); return inflight.p; }

      const t = Date.now();
      picker.captures++;
      const p = orig(o).then(res => {
        picker.totalMs += Date.now() - t;
        debug.ev('picker', { ...note, ms: Date.now() - t, sources: res?.length });
        if (tune && thumbs) cache = { key, at: Date.now(), res };
        if (inflight?.p === p) inflight = null;
        return res;
      }, e => {
        debug.ev('picker', { ...note, ms: Date.now() - t, failed: String(e?.message ?? e).slice(0, 80) });
        if (inflight?.p === p) inflight = null;
        throw e;
      });
      if (tune) inflight = { key, p };
      return p;
    };
  } catch (e) { log('Picker', e); }
};

// --- Warm connections ---
// Keep connections to Discord's API and image/media servers open, so the first messages and images after you
// open a channel don't wait on new TLS handshakes. Repeated when Discord is focused (at most every 2 minutes).
let lastWarm = 0;
const warmConnections = () => {
  if (oaConfig.warmup === false || pure || Date.now() - lastWarm < 120000) return;
  lastWarm = Date.now();
  const host = buildInfo.releaseChannel === 'stable' ? 'discord.com' : buildInfo.releaseChannel + '.discord.com';
  for (const [ url, n ] of [ [ 'https://' + host, 2 ], [ 'https://cdn.discordapp.com', 2 ], [ 'https://media.discordapp.net', 4 ], [ 'https://images-ext-1.discordapp.net', 1 ] ]) {
    try { session.defaultSession.preconnect({ url, numSockets: n }); } catch { }
  }
};

const startCore = () => {
  // asar registers NO network hooks by default. While any session.webRequest listener exists, Electron routes every
  // request (messages, images, stream setup) through Discord's main process, so whenever that process is busy -
  // e.g. starting or stopping a screen share - all loading waits on it. Custom CSS/JS don't need the page's CSP
  // removed (insertCSS / executeJavaScript bypass it); removing it is an advanced opt-in for scripts that load
  // external resources.
  if (oaConfig.removeCSP === true && !pure) session.defaultSession.webRequest.onHeadersReceived({
    urls: [ 'app*', 'channels/*', 'popout*', 'login*' ].flatMap(p => [ 'https://discord.com/' + p, 'https://*.discord.com/' + p ])
  }, (d, cb) => {
    if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') return cb({});
    const h = { ...d.responseHeaders };
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-security-policy') delete h[k];
    cb({ responseHeaders: h });
  });

  require('./config'); // Registers the IPC that opens asar settings (window itself only opens when you ask)

  // Read the injected renderer script once (OpenAsar re-read + re-templated it on every dom-ready)
  const injectedSrc = readFileSync(join(__dirname, 'mainWindow.js'), 'utf8');
  const injected = () => injectedSrc.replace('__ASAR_CFG__', () => JSON.stringify({
    version: asarVersion,
    noTrack: oaConfig.noTrack !== false && !pure,
    noTyping: oaConfig.noTyping === true && !pure,
    domOpt: oaConfig.domOptimizer === true && !oaConfig.safeMode && !pure,
    themeSync: oaConfig.themeSync !== false && !pure,
    entry: oaConfig.settingsEntry !== false,
    noBlur: oaConfig.noBlur !== false && !pure && !oaConfig.safeMode,
    pure,
    prefetch: oaConfig.prefetch !== false && !pure && !oaConfig.safeMode,
    keepReady: oaConfig.keepReady !== false && !pure && !oaConfig.safeMode,
    loader: oaConfig.loader !== false && !pure,
    instantSwitch: oaConfig.instantSwitch !== false && !pure && !oaConfig.safeMode,
    warmSettings: oaConfig.warmSettings !== false && !pure && !oaConfig.safeMode,
    memTrim: oaConfig.memTrim !== false && !pure && !oaConfig.safeMode,
    top: topChannels(),
    hotkey: hotkeyLabel,
    stats: launchStats(),
    debug: debug.isOn() ? { salt: debug.salt() } : null
  })) + '\n//# sourceURL=asar-injected.js'; // named, so slow frames and errors from asar's code can be told apart from Discord's

  let firstReady = true;
  app.on('browser-window-created', (e, bw) => {
    bw.webContents.on('dom-ready', () => {
      if (!bw.resizable) return; // Main window (and popouts) only - not our splash/config
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = global.asarMainWindow = bw;

      if (firstReady) {
        firstReady = false;
        asarMark('Discord page DOM ready');
        watchWindow(bw);
        debug.watch(bw);
        debug.windowReady();
        warmConnections();
        bw.on('focus', warmConnections);
        recordLaunch();
        setTimeout(boostPriority, 2000); // after GPU/renderer processes exist
      }

      splash.pageReady(); // Show main window as soon as the DOM is ready instead of waiting on Core

      bw.webContents.executeJavaScript(injected()).catch(e => log('Inject', e));
      if (!pure && !oaConfig.safeMode && oaConfig.css) bw.webContents.insertCSS(oaConfig.css).catch(e => log('Inject', 'Custom CSS', e));
      if (!pure && !oaConfig.safeMode && oaConfig.js) bw.webContents.executeJavaScript(oaConfig.js + '\n//# sourceURL=asar-custom.js').catch(e => log('Inject', 'Custom JS', e));
    });

    // Hotkey that always opens asar settings, even if Discord changes its settings UI again
    if (oaConfig.hotkey !== false) bw.webContents.on('before-input-event', (ev, i) => {
      if (!isHotkey(i)) return;
      ev.preventDefault();
      require('./config').open();
    });
  });

  tuneScreenPicker(); // before Discord's core loads, so it uses the tuned version
  asarMark('loading Discord core');
  desktopCore = require('discord_desktop_core');
  asarMark('Discord core loaded');

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
  asarMark('Discord core started');
};

const startUpdate = () => {
  asarMark('app ready');
  // Tracking / typing requests are blocked inside Discord's page (mainWindow.js), not with a network hook.
  watchMainLoop();

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
    asarMark('updates checked');
    if (!env('NOSTART')) startCore();
  });

  let done;
  splash.events.once('APP_SHOULD_SHOW', () => {
    if (done) return;
    done = true;
    asarMark('Discord window shown');

    desktopCore.setMainWindowVisible(!startMin);

    setTimeout(() => {
      if (env('SMOKE')) { // CI: proves a real Discord client booted all the way through asar
        console.log('ASAR_SMOKE_OK');
        return app.exit(0);
      }

      if (oaConfig.autoupdate !== false) require('./asarUpdate')().then(r => {
        log('AsarUpdate', r);
        debug.ev('update', { result: r });
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

  // Debug recording (asar settings > Debug): from the very start if asked, and recovery of an unfinished one
  if (oaConfig.debugOnStart === true) debug.start('launch');
  debug.init();

  app.whenReady().then(startUpdate);
};

module.exports.restoreMain = restoreMain;
