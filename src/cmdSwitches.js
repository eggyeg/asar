const { join } = require('path');
const { app } = require('electron');

const paths = require('./paths');

const presets = {
  // Base Discord flags + CalculateNativeWinOcclusion off (fixes blank/frozen window when restoring from minimized/tray on Windows)
  'base': '--autoplay-policy=no-user-gesture-required --disable-features=WinRetrieveSuggestionsOnlyOnDemand,HardwareMediaKeyHandling,MediaSessionService,UseEcoQoSForBackgroundProcess,IntensiveWakeUpThrottling,AllowAggressiveThrottlingWithWebSocket,CalculateNativeWinOcclusion --disable-background-timer-throttling',

  // Performance: GPU raster + zero-copy, DrDc, bfcache, lazy wasm, no background throttling of the renderer
  'perf': '--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --enable-hardware-overlays=single-fullscreen,single-on-top,underlay --enable-features=EnableDrDc,CanvasOopRasterization,BackForwardCache:TimeToLiveInBackForwardCacheInSeconds/300/should_ignore_blocklists/true/enable_same_site/true,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,WebAssemblyLazyCompilation --disable-features=Vulkan --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --force_high_performance_gpu',

  // Balanced: just the base flags (closest to vanilla Discord)
  'balanced': '',

  // Battery: low power GPU, no media caching on battery, smaller V8 heap footprint
  'battery': '--enable-features=TurnOffStreamingMediaCachingOnBattery --force_low_power_gpu --js-flags=--optimize-for-size'
};

module.exports = () => {
  const sel = ('base,' + (oaConfig.cmdPreset || 'perf')).split(',');
  const flags = (oaConfig.customFlags ?? '').split(' ');
  for (const p of sel) if (presets[p]) flags.push(...presets[p].split(' '));

  if (process.platform === 'linux' && settings.get('openH264Enabled', true))
    flags.push('--enable-libopenh264', '--openh264-library-path=' + join(paths.getAssetCachePath(), 'openh264', 'libopenh264-2.5.1-linux64.7.so'));

  const c = {};
  for (const x of flags) {
    if (!x) continue;
    const i = x.indexOf('='); // Split on first = only (values can contain =)
    const k = (i === -1 ? x : x.slice(0, i)).replace(/^--/, '');
    const v = i === -1 ? '' : x.slice(i + 1);

    (c[k] = c[k] || new Set());
    if (v) for (const y of (k.endsWith('-features') ? v.split(',') : [ v ])) c[k].add(y); // Merge + dedupe feature lists
  }

  for (const k in c) app.commandLine.appendSwitch(k, [...c[k]].join(k === 'js-flags' ? ' ' : ','));
};
