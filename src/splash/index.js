const { app, ipcMain } = require('electron');

const moduleUpdater = require("../updater/moduleUpdater");
const updater = require("../updater/updater");

let launched, win;


exports.initSplash = (startMin) => {
  const inst = updater.getUpdater();
  if (inst) initNew(inst);
    else initOld();

  launchSplash(startMin);


  if (process.env.ASAR_QUICKSTART || process.env.OPENASAR_QUICKSTART || oaConfig.quickstart) setTimeout(() => {
    destroySplash();

    launchMain();

    setTimeout(() => {
      events.emit('APP_SHOULD_SHOW');
    }, 100);
  }, 300);
};

exports.focusWindow = () => win?.focus?.();
// Discord's window is ready: the bar fills up, then the splash closes
exports.pageReady = () => {
  const first = win && !('dom' in marks);
  if (first) { exports.milestone('dom'); saveTimes(); sendState('done'); }
  destroySplash(first ? 260 : 100);
  process.nextTick(() => events.emit('APP_SHOULD_SHOW'));
};

const destroySplash = (delay = 100) => {
  win?.setSkipTaskbar?.(true);

  setTimeout(() => {
    if (!win) return;

    win.hide();
    win.close();
    win = null;
  }, delay);
};

// --- Startup timing for the splash bar ---
// Each launch records when its steps happened (ms after the splash opened); the bar follows the median of the last 5
// launches, so it moves at the speed Discord actually starts on this PC and fills up when Discord is ready.
const T0 = { at: 0 }, marks = {};
let unusual = false; // updates were installed this launch: its times aren't typical
const plan = () => {
  const list = (settings.get('asarBootTimes') ?? []).filter(x => x && typeof x === 'object');
  const med = k => { const v = list.map(x => x[k]).filter(n => n >= 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  return { checked: med('checked') ?? 900, window: med('window') ?? 1900, page: med('page') ?? 2600, dom: med('dom') ?? 4800 };
};
exports.milestone = name => {
  if (!T0.at || name in marks) return;
  marks[name] = Date.now() - T0.at;
  sendState('milestone', { name, at: marks[name] });
};
const saveTimes = () => {
  if (unusual || !('checked' in marks) || !('dom' in marks)) return;
  try {
    const prev = settings.get('asarBootTimes');
    settings.set('asarBootTimes', [ ...(Array.isArray(prev) ? prev : []), { ...marks } ].slice(-5));
    settings.save();
  } catch { }
};
// asar's own update, installed on the splash (download progress, installing, restarting)
exports.asarUpdate = s => { unusual = true; sendState('asar-update', s); };

const launchMain = () => {
  moduleUpdater.events.removeAllListeners(); // Remove updater v1 listeners

  if (!launched && win != null) {
    sendState('starting');
    exports.milestone('checked');

    launched = true;
    events.emit('APP_SHOULD_LAUNCH');
  }
};

let lastState = null;
const sendState = (status, s = {}) => {
  if (status !== 'milestone') lastState = { status, ...s };
  if (status === 'downloading' || status === 'installing') unusual = true;
  try {
    win.webContents.send('state', { status, ...s });
  } catch { }
};


const launchSplash = (startMin) => {
  win = require('../utils/win')({
    width: 300,
    height: process.platform === 'darwin' ? 300 : 350
  }, 'splash');

  T0.at = Date.now();
  // The page missed what happened before it loaded: send the plan, the steps so far and the latest state
  win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('state', { status: 'plan', plan: plan(), elapsed: Date.now() - T0.at, marks: { ...marks }, last: lastState }); } catch { }
  });

  if (process.platform !== 'darwin') win.on('closed', () => !launched && app.quit());

  ipcMain.on('ss', launchMain);
  ipcMain.on('sq', app.quit);

  if (!startMin) win.once('ready-to-show', win.show);
};


const events = exports.events = new (require('events').EventEmitter)();

let toSend = 0; // Progress state to send for ModuleUpdater (0 = downloading, 1 = installing)
class UIProgress { // Generic class to track updating and sent states to splash
  constructor(st) {
    this.st = st;

    this.reset();
  }

  reset() {
    Object.assign(this, {
      progress: new Map(),
      done: new Set(),
      total: new Set()
    });
  }

  record(id, state, current, outOf) {
    this.total.add(id);

    if (current) this.progress.set(id, [ current, outOf ?? 100 ]);
    if (state === 'Complete') this.done.add(id);

    this.send();
  }

  send() {
    if ((toSend === -1 && this.progress.size > 0 && this.progress.size > this.done.size) || toSend === this.st) {
      const progress = Math.min(100, [...this.progress.values()].reduce((a, x) => a + x[0], 0) / [...this.progress.values()].reduce((a, x) => a + x[1], 0) * 100); // Clamp progress to 0-100

      sendState(this.st ? 'installing' : 'downloading', {
        current: this.done.size + 1,
        total: this.total.size,
        progress
      });

      return true;
    }
  }
}

const initNew = async (inst) => {
  toSend = -1;

  const retryOptions = {
    skip_host_delta: true,
    skip_module_delta: {},
    skip_all_module_delta: false,
    allow_optional_updates: settings.get('ALLOW_OPTIONAL_UPDATES', true)
  };

  while (true) {
    sendState('checking-for-updates');

    try {
      let installedAnything = false;
      const downloads = new UIProgress(0);
      const installs = new UIProgress(1);

      await inst.updateToLatestWithOptions(retryOptions, ({ task, state, percent }) => {
        const download = task.HostDownload || task.ModuleDownload;
        const install = task.HostInstall || task.ModuleInstall;

        installedAnything = true;

        const simpleRecord = (tracker, x) => tracker.record(x.package_sha256, state, percent);

        if (download != null) simpleRecord(downloads, download);

        if (!downloads.send()) installs.send();

        if (install == null) return;
        simpleRecord(installs, install);

        if (state === 'Failed') {
          if (task.HostInstall != null) {
            retryOptions.skip_host_delta = true;
          } else if (task.ModuleInstall != null) {
            retryOptions.skip_module_delta[install.version.module.name] = true;
          }
        }
      });

      if (!installedAnything) {
        await inst.startCurrentVersion({});
        inst.collectGarbage();

        return launchMain();
      }
    } catch (e) {
      log('Splash', e);
      await new Promise(r => fail(r));
    }
  }
};

const initOld = () => { // "Old" (not v2 / new, win32 only)
  const on = (k, v) => moduleUpdater.events.on(k, v);

  const check = () => moduleUpdater.checkForUpdates();

  const downloads = new UIProgress(0), installs = new UIProgress(1);

  const handleFail = () => {
    fail(check);
  };

  on('checked', ({ failed, count }) => { // Finished check
    installs.reset();
    downloads.reset();

    if (failed) handleFail();
      else if (!count) launchMain(); // Count is 0 / undefined
  });

  on('downloaded', ({ failed }) => { // Downloaded all modules
    toSend = 1;

    if (failed > 0) handleFail();
  });

  on('installed', check); // Installed all modules

  on('downloading-module', ({ name, cur, total }) => {
    downloads.record(name, '', cur, total);
    installs.record(name, 'Waiting');
  });

  on('installing-module', ({ name, cur, total }) => {
    installs.record(name, '', cur, total);
  });

  const segment = (tracker) => (({ name }) => {
    tracker.record(name, 'Complete');
  });

  on('downloaded-module', segment(downloads));
  on('installed-module', segment(installs));

  on('manual', (e) => sendState('manual', { details: e })); // Host manual update required

  sendState('checking-for-updates');

  check();
};

const fail = (c) => {
  sendState('fail', { seconds: 10 });

  setTimeout(c, 10000);
};
