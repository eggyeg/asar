const { join } = require('path');

global.asarVersion = '1.1.1';
global.oaVersion = global.asarVersion; // Kept for compatibility with mods that read it

global.log = (area, ...args) => console.log(`[\x1b[38;2;139;123;255masar\x1b[0m > ${area}]`, ...args);

log('Init', 'asar', asarVersion);

if (process.resourcesPath.startsWith('/usr/lib/electron')) global.systemElectron = true; // Using system electron, flag for other places
process.resourcesPath = join(__dirname, '..'); // Force resourcesPath for system electron

const paths = require('./paths');
paths.init();

global.settings = require('./appSettings').getSettings();
global.oaConfig = settings.get('asar') ?? settings.get('openasar', {}); // Migrate existing OpenAsar config transparently

const M = require('module');

// V8 compile cache (Node 22+ / Electron 33+): caches bytecode for every module required after this point,
// including discord_desktop_core, cutting main-process startup parse/compile time on every launch after the first.
if (oaConfig.compileCache !== false) try {
  const r = M.enableCompileCache?.(join(paths.getUserData(), 'asar_cache'));
  if (r) log('Init', 'Compile cache', ['failed', 'enabled', 'enabled', 'disabled'][r.status] ?? r.status);
} catch (e) { log('Init', 'Compile cache unavailable', e?.message); }

require('./cmdSwitches')();

// Force u2QuickLoad (pre-"minified" ish)
const b = join(paths.getExeDir(), 'modules'); // Base dir
if (process.platform === 'win32') try {
  for (const m of require('fs').readdirSync(b)) M.globalPaths.unshift(join(b, m)); // For each module dir, add to globalPaths
} catch { log('Init', 'Failed to QS globalPaths'); }

// Inject Module.globalPaths into resolve lookups as it was removed in Electron >=17 and Discord depends on it
const rlp = M._resolveLookupPaths;
M._resolveLookupPaths = (request, parent) => {
  if (parent?.paths?.length > 0) parent.paths = parent.paths.concat(M.globalPaths);
  return rlp(request, parent);
};

if (process.argv.includes('--overlay-host')) { // If overlay
  require('discord_overlay2/standalone_host.js');
} else {
  require('./bootstrap')();
}
