const { ipcMain, app, shell } = require('electron');
const { join, dirname } = require('path');

const self = join(__dirname, '..'); // The app.asar we're running from

const restart = () => {
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

// IPC is registered exactly once (OpenAsar re-registered every time the window opened, leaking handlers)
ipcMain.on('DISCORD_UPDATED_QUOTES', (e, c) => {
  if (c === 'o') return exports.open();

  // Status report from the injected script (is the settings tab in place, and if not, why)
  if (c && typeof c === 'object' && c.asarDiag) {
    global.asarDiag = { ...c.asarDiag, at: new Date().toISOString(), discord: app.getVersion() };
    try { require('fs').writeFileSync(join(require('../paths').getUserData(), 'asar-diagnostics.json'), JSON.stringify(global.asarDiag, null, 2)); } catch { }
  }
});

ipcMain.on('cg', e => { e.returnValue = oaConfig; });
ipcMain.on('cs', (e, c) => { if (c && typeof c === 'object') save(c); });
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
