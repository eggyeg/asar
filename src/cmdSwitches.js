const { join } = require('path');
const { app } = require('electron');

const paths = require('./paths');

const presets = {
  // Exactly the flags stock Discord launches with
  'base': '--autoplay-policy=no-user-gesture-required --disable-features=WinRetrieveSuggestionsOnlyOnDemand,HardwareMediaKeyHandling,MediaSessionService,UseEcoQoSForBackgroundProcess,IntensiveWakeUpThrottling,AllowAggressiveThrottlingWithWebSocket --disable-background-timer-throttling',

  // Stock (default): nothing on top of Discord's own flags. Chromium already uses GPU rasterization wherever the
  // driver supports it, so this is also the fastest stable option on most PCs.
  'stock': '',

  // GPU boost (opt-in, experimental): forces GPU features Chromium has blocklisted for some drivers. On affected
  // GPUs this makes the GPU process hang, which freezes Discord for 10-30 s (worst with screen share and image-heavy
  // channels). The freeze watchdog switches back to Stock automatically if that happens.
  'gpu': '--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --enable-hardware-overlays=single-fullscreen,single-on-top,underlay --enable-features=EnableDrDc,CanvasOopRasterization,WebAssemblyLazyCompilation --disable-features=Vulkan --force_high_performance_gpu',

  // Battery: low power GPU, no media caching on battery, smaller V8 heap footprint
  'battery': '--enable-features=TurnOffStreamingMediaCachingOnBattery --force_low_power_gpu --js-flags=--optimize-for-size'
};

const presetName = () => {
  if (oaConfig.safeMode || oaConfig.pure) return 'stock';
  const p = oaConfig.cmdPreset;
  if (p === 'perf') return 'gpu';
  if (p === 'balanced' || !presets[p]) return 'stock';
  return p;
};

const apply = () => {
  const preset = presetName();
  const flags = oaConfig.safeMode || oaConfig.pure ? [] : (oaConfig.customFlags ?? '').split(' ');
  for (const p of [ 'base', preset ]) if (presets[p]) flags.push(...presets[p].split(' '));
  log('Flags', 'Preset', preset + (oaConfig.pure ? ' (testing as stock Discord)' : oaConfig.safeMode ? ' (safe mode)' : ''));

  // Instant UI: Discord follows the system "reduce motion" setting by default, so this switches off its
  // JS-driven animations (modals, popouts, channel switches) properly rather than just CSS ones
  if (oaConfig.instantUI !== false && !oaConfig.pure) flags.push('--force-prefers-reduced-motion');

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

module.exports = apply;
module.exports.presetName = presetName;
