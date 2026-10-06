const { join } = require('path');

global.asarVersion = '1.7.0';
global.oaVersion = global.asarVersion; // Kept for compatibility with mods that read it

global.log = (area, ...args) => console.log(`[\x1b[38;2;139;123;255masar\x1b[0m > ${area}]`, ...args);

log('Init', 'asar', asarVersion);

if (process.resourcesPath.startsWith('/usr/lib/electron')) global.systemElectron = true; // Using system electron, flag for other places
process.resourcesPath = join(__dirname, '..'); // Force resourcesPath for system electron

const paths = require('./paths');
paths.init();

global.settings = require('./appSettings').getSettings();
global.oaConfig = settings.get('asar') ?? settings.get('openasar', {}); // Migrate existing OpenAsar config transparently

// asar 1.2: earlier defaults (forced GPU flags, partial priority boost, DOM optimizer) caused long freezes on some
// PCs. Move existing installs onto the stock-safe defaults once; anything can be turned back on in settings.
if ((oaConfig.configVersion ?? 0) < 2) {
  const c = { ...oaConfig, configVersion: 2 };
  if (!c.cmdPreset || c.cmdPreset === 'perf' || c.cmdPreset === 'balanced') c.cmdPreset = 'stock';
  c.priority = false;
  c.domOptimizer = false;
  global.oaConfig = c;
  settings.set('asar', c);
  settings.save();
  global.asarMigrated = true;
}

// asar 1.3: the GPU flags earlier versions forced can leave shader/GPU caches built for them; clear those once.
if ((oaConfig.configVersion ?? 0) < 3) {
  const c = { ...global.oaConfig, configVersion: 3 };
  global.oaConfig = c;
  settings.set('asar', c);
  settings.set('asarClearCaches', [ ...new Set([ ...(settings.get('asarClearCaches') ?? []), 'gpu' ]) ]);
  settings.save();
}

// "Repair caches" (asar settings > Advanced) and the migration above schedule cache folders to be deleted here,
// before Chromium opens them. Chromium recreates them as needed.
{
  const want = settings.get('asarClearCaches');
  if (Array.isArray(want) && want.length) {
    const groups = {
      gpu: [ 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache' ],
      code: [ 'Code Cache' ],
      http: [ 'Cache' ]
    };
    const fs = require('fs');
    for (const g of want) for (const d of groups[g] ?? []) {
      try { fs.rmSync(join(paths.getUserData(), d), { recursive: true, force: true }); } catch (e) { log('Init', 'Could not clear', d, e?.message); }
    }
    log('Init', 'Cleared caches', want.join(', '));
    settings.set('asarClearCaches', []);
    settings.set('asarCachesClearedAt', Date.now());
    settings.save();
  }
}

const M = require('module');

// V8 compile cache (Node 22+ / Electron 33+): caches bytecode for every module required after this point,
// including discord_desktop_core, cutting main-process startup parse/compile time on every launch after the first.
if (oaConfig.compileCache !== false && oaConfig.pure !== true) try {
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
