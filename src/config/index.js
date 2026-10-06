const { ipcMain, app, shell, clipboard } = require('electron');
const { join, dirname } = require('path');
const debug = require('../debug');

const self = join(__dirname, '..'); // The app.asar we're running from

const restart = () => {
  debug.finishNow('Discord was restarted from asar settings');
  app.relaunch();
  app.exit(0);
};

const save = c => {
  global.oaConfig = c;
  settings.set('asar', c);
  settings.save();
};

// Stock Discord asar kept by the installer / host updater
const backupPath = () => {
  const fs = require('original-fs');
  const dirs = [ ...new Set([ dirname(self), process.resourcesPath ]) ];
  return dirs.flatMap(d => [ 'app.asar.backup', 'app.asar.orig', '_app.asar' ].map(x => join(d, x))).find(x => fs.existsSync(x));
};

let visitSave = 0;

// IPC is registered exactly once (OpenAsar re-registered every time the window opened, leaking handlers)
ipcMain.on('DISCORD_UPDATED_QUOTES', (e, c) => {
  if (c === 'o') return exports.open();

  if (c && typeof c === 'object' && typeof c.asarFreeze === 'number') return global.asarRecordFreeze?.('page', c.asarFreeze);

  // Debug recorder: a batch of page events (only sent while recording), and startup marks from the page
  if (c && typeof c === 'object' && Array.isArray(c.asarDbg)) return debug.page(c.asarDbg);
  if (c && typeof c === 'object' && Array.isArray(c.asarMark)) {
    const [ n, t ] = c.asarMark;
    if (typeof n === 'string' && n.length < 60 && typeof t === 'number' && !asarMarks.some(m => m[0] === n)) asarMarks.push([ n, t ]);
    return;
  }

  // Channel visit (for "keep top channels ready"): IDs only, kept to the 150 most recent, saved at most every 10 s
  if (c && typeof c === 'object' && c.asarVisit) {
    const id = String(c.asarVisit.c ?? ''), g = String(c.asarVisit.g ?? '');
    if (!/^\d{5,25}$/.test(id) || !/^(@me|\d{5,25})$/.test(g)) return;
    const v = settings.get('asarVisits', {});
    const e = v[id] ?? { g, n: 0, t: 0 };
    e.n++; e.t = Date.now(); e.g = g;
    v[id] = e;
    const keys = Object.keys(v);
    if (keys.length > 150) for (const k of keys.sort((a, b) => v[a].t - v[b].t).slice(0, keys.length - 150)) delete v[k];
    settings.set('asarVisits', v);
    clearTimeout(visitSave);
    visitSave = setTimeout(() => settings.save(), 10000);
    return;
  }

  // Status report from the injected script (is the settings tab in place, and if not, why)
  if (c && typeof c === 'object' && c.asarDiag) {
    global.asarDiag = { ...c.asarDiag, at: new Date().toISOString(), discord: app.getVersion() };
    try { require('fs').writeFileSync(join(require('../paths').getUserData(), 'asar-diagnostics.json'), JSON.stringify(global.asarDiag, null, 2)); } catch { }
  }
});

ipcMain.on('cg', e => { e.returnValue = oaConfig; });
ipcMain.on('cs', (e, c) => {
  if (!c || typeof c !== 'object') return;
  // Keep fields set by the main process (safe mode, migrations) unless the window changes them explicitly
  for (const k of [ 'safeMode', 'safeModeReason', 'safeModeAt', 'configVersion' ]) if (!(k in c) && k in oaConfig) c[k] = oaConfig[k];
  if (debug.isOn()) {
    const changed = [ ...new Set([ ...Object.keys(c), ...Object.keys(oaConfig) ]) ].filter(k => JSON.stringify(c[k]) !== JSON.stringify(oaConfig[k]))
      .map(k => [ 'css', 'js', 'customFlags', 'updateUrl' ].includes(k) ? k + ' (edited)' : k + '=' + JSON.stringify(c[k] ?? null)).join(', ');
    if (changed) debug.ev('config', { changed: changed.slice(0, 300) });
  }
  save(c);
});

// Debug tab
ipcMain.on('dg', e => { e.returnValue = debug.status(); });
ipcMain.handle('ds', () => debug.start('button'));
ipcMain.handle('dx', () => debug.stop());
ipcMain.handle('dn', () => debug.snapshot());
ipcMain.handle('dt', (e, since) => debug.tail(Number(since) || 0));
ipcMain.handle('dw', (e, on) => { save({ ...oaConfig, debugOnStart: on === true }); return debug.status(); });
ipcMain.handle('do', (e, name) => { // open a saved log, or the folder
  if (name == null) { require('fs').mkdirSync(debug.dir(), { recursive: true }); return shell.openPath(debug.dir()); }
  if (debug.validName(name)) return shell.openPath(join(debug.dir(), name));
});
ipcMain.handle('dr', (e, name) => { if (debug.validName(name)) shell.showItemInFolder(join(debug.dir(), name)); });
ipcMain.handle('dy', (e, name) => {
  const t = debug.validName(name) && debug.summaryOf(name);
  if (!t) return false;
  clipboard.writeText(t);
  return true;
});
ipcMain.on('cr', () => { settings.save(); restart(); });
ipcMain.on('cc', () => win?.close());
ipcMain.on('cm', () => win?.minimize());
ipcMain.on('of', () => shell.openPath(join(require('../paths').getUserData(), 'settings.json')));

ipcMain.on('ci', e => {
  e.returnValue = {
    version: asarVersion,
    discord: app.getVersion(),
    channel: global.releaseChannel,
    electron: process.versions.electron,
    platform: process.platform,
    backup: !!backupPath(),
    updateUrl: require('../asarUpdate').DEFAULT_URL,
    lastUpdate: settings.get('asarLastUpdate'),
    stats: settings.get('asarStats', []),
    diag: global.asarDiag ?? null,
    freezes: global.asarFreezes ? { count: global.asarFreezes.count, longest: global.asarFreezes.longest, gpu: global.asarFreezes.gpu } : null,
    migrated: !!global.asarMigrated,
    pure: !!global.asarPure,
    picker: global.asarPicker ?? null,
    hwAccel: settings.get('enableHardwareAcceleration', true),
    mainStalls: global.asarMainStalls ?? null,
    cachesClearedAt: settings.get('asarCachesClearedAt') ?? null,
    hotkey: process.platform === 'darwin' ? 'Cmd + Option + O' : 'Ctrl + Alt + O'
  };
});

ipcMain.handle('cu', async () => {
  try {
    return await require('../asarUpdate')();
  } catch (e) {
    return 'Update failed: ' + (e?.message ?? e);
  }
});

ipcMain.handle('ck', async () => { // Repair caches: deleted on next start, before Chromium opens them
  settings.set('asarClearCaches', [ 'gpu', 'code', 'http' ]);
  settings.save();
  return 'ok';
});

ipcMain.handle('cx', async () => { // Restore stock Discord
  const p = backupPath();
  if (!p) return 'No stock Discord backup found next to app.asar';

  try {
    const fs = require('original-fs');
    try { fs.copyFileSync(self, self + '.asar-fork'); } catch { } // Keep a copy of asar so it can be put back by hand
    fs.copyFileSync(p, self);
    setTimeout(restart, 600);
    return 'ok';
  } catch (e) {
    return 'Restore failed: ' + (e?.message ?? e);
  }
});

let win;
exports.open = () => {
  if (win && !win.isDestroyed()) { // Already open: actually bring it back (show() alone doesn't un-minimize)
    if (win.isMinimized()) win.restore();
    win.show();
    return win.focus();
  }

  const parent = global.asarMainWindow && !global.asarMainWindow.isDestroyed() ? global.asarMainWindow : undefined;
  win = require('../utils/win')({
    width: 560,
    height: 680,
    minimizable: true,
    parent // Stays on top of Discord and never pushes Discord behind other windows
  }, 'config');

  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('closed', () => {
    win = null;
    if (parent && !parent.isDestroyed()) parent.focus();
  });
};
