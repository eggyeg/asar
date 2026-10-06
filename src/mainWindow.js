(() => {
const cfg = __ASAR_CFG__;
if (window.__asarInjected) return;
window.__asarInjected = true;

const open = () => DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', 'o');

// Globals for mods that want to detect us
window.asar = { version: cfg.version, open };
window.openasar = window.openasar ?? {};

// --- Disable Sentry (v7 hub + v8 scopes) ---
if (cfg.noTrack) {
  try {
    const S = window.__SENTRY__;
    const clients = [ S?.hub?.getClient?.() ];
    if (S) for (const k in S) clients.push(S[k]?.defaultCurrentScope?.getClient?.(), S[k]?.hub?.getClient?.());
    for (const c of clients) { const o = c?.getOptions?.(); if (o) o.enabled = false; }
    for (const x of Object.keys(console)) console[x] = console[x].__sentry_original__ ?? console[x];
  } catch { }
}

// --- Block tracking / typing requests inside the page ---
// (Not with a network hook: those make every request in Discord wait on its main process.) Blocked requests resolve
// instantly as 204 No Content, so Discord treats them as sent and never retries.
const blockParts = [
  cfg.noTrack && '/api/v\\d+/(?:science|metrics|track)(?:[/?#]|$)',
  cfg.noTrack && '/error-reporting-proxy/',
  cfg.noTrack && '\\.sentry\\.io/',
  cfg.noTyping && '/api/v\\d+/channels/\\d+/typing(?:[?#]|$)'
].filter(Boolean);

if (blockParts.length) {
  const blockRe = new RegExp(blockParts.join('|'));
  const blocked = u => { try { return blockRe.test(String(u)); } catch { return false; } };

  const XP = XMLHttpRequest.prototype, xOpen = XP.open, xSend = XP.send;
  XP.open = function (method, url) {
    this.__asarBlocked = blocked(url);
    return xOpen.apply(this, arguments);
  };
  XP.send = function () {
    if (!this.__asarBlocked) return xSend.apply(this, arguments);
    const x = this;
    setTimeout(() => {
      for (const [ k, v ] of [ [ 'readyState', 4 ], [ 'status', 204 ], [ 'statusText', 'No Content' ], [ 'responseText', '' ], [ 'response', '' ], [ 'responseURL', '' ] ])
        Object.defineProperty(x, k, { configurable: true, value: v });
      for (const t of [ 'readystatechange', 'load', 'loadend' ]) x.dispatchEvent(new ProgressEvent(t));
    }, 0);
  };

  const oFetch = window.fetch;
  window.fetch = function (input) {
    if (blocked(typeof input === 'string' ? input : input?.url)) return Promise.resolve(new Response(null, { status: 204 }));
    return oFetch.apply(this, arguments);
  };

  const oBeacon = navigator.sendBeacon?.bind(navigator);
  if (oBeacon) navigator.sendBeacon = (url, data) => blocked(url) ? true : oBeacon(url, data);
}

// --- Performance CSS ---
// Blur (backdrop-filter) is one of the most expensive things Chromium composites; Discord's refreshed UI uses it on
// popouts, modals and overlays. Measured: this rule adds no restyle cost.
// Animations are turned off ONLY via --force-prefers-reduced-motion (Discord's own reduced-motion mode). asar 1.1-1.3
// also set `transition-duration:1ms` on every element; since every element's transition-property defaults to `all`,
// that turned every style change into thousands of CSS transitions and froze Discord for 15-35 s on channel
// switches and stream start/stop (measured: 0.8 s -> 24 s for six restyles of 20k elements). Never do that again.
const perfCSS = cfg.noBlur ? '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' : '';

const addStyle = (id, css) => {
  if (!css) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  (document.head ?? document.documentElement).appendChild(el);
};
addStyle('asar-perf', perfCSS);
addStyle('asar-css', cfg.css);

// --- Theme sync: mirror Discord's colors into the splash / asar settings windows ---
const pickVar = (cs, ...names) => {
  for (const n of names) {
    const v = cs.getPropertyValue(n).trim();
    if (v) return v;
  }
};

let lastTheme = '';
const themesync = async () => {
  if (!cfg.themeSync || !window.DiscordNative?.userDataCache) return;

  const el = document.querySelector('.theme-dark, .theme-light, .theme-darker, .theme-midnight') ?? document.documentElement;
  const cs = getComputedStyle(el);

  const vars = {
    '--asar-bg': pickVar(cs, '--background-base-lower', '--background-primary'),
    '--asar-bg2': pickVar(cs, '--background-base-lowest', '--background-secondary', '--background-tertiary'),
    '--asar-surface': pickVar(cs, '--background-surface-high', '--background-secondary-alt', '--background-secondary'),
    '--asar-accent': pickVar(cs, '--brand-500', '--brand-experiment'),
    '--asar-text': pickVar(cs, '--text-strong', '--header-primary', '--text-normal'),
    '--asar-muted': pickVar(cs, '--text-muted')
  };
  if (!vars['--asar-bg']) return;

  const value = `:root{${Object.entries(vars).filter(x => x[1]).map(([ k, v ]) => `${k}:${v}`).join(';')}}`;
  if (value === lastTheme) return;
  lastTheme = value;

  const cached = await DiscordNative.userDataCache.getCached() || {};
  if (cached.asarSplashCSS === value) return;
  cached.asarSplashCSS = value;
  DiscordNative.userDataCache.cacheUserData(JSON.stringify(cached));
};

const safeSync = () => themesync().catch(() => { });
setTimeout(safeSync, 8000);
document.addEventListener('visibilitychange', () => document.hidden && safeSync());

// --- "asar" tab in Discord's settings ---
// Discord's settings (2025+) are built from a layout tree whose root has key "$Root" and a buildLayout() method.
// We add an "asar" section to it through Discord's webpack modules, the same way Vencord and BetterDiscord do.
// Independent of class names and UI language. Every step is recorded in `diag` (asar settings > About, and
// asar-diagnostics.json in Discord's data folder) so a failure can be pinpointed.
const diag = { version: cfg.version, wreq: false, root: false, types: false, react: false, wrapped: 0, patched: false, builds: 0, line: false, error: null, longTasks: 0, longestTask: 0 };
let lastReport = '';
const report = () => {
  const s = JSON.stringify(diag);
  if (s === lastReport) return;
  lastReport = s;
  try { DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', { asarDiag: diag }); } catch { }
};
const fail = (where, e) => { diag.error = where + ': ' + (e?.message ?? e); report(); };

let wreq, root, types, React, patched = false;
const scanned = new Set();

const getReq = () => {
  if (wreq) return wreq;
  const chunk = window.webpackChunkdiscord_app ?? window[Object.keys(window).find(k => k.startsWith('webpackChunk'))];
  if (!chunk?.push) return;
  chunk.push([ [ Symbol('asar') ], {}, r => { wreq = r; } ]);
  chunk.pop();
  diag.wreq = !!wreq?.c;
  return wreq;
};

const check = v => {
  if (!v || (typeof v !== 'object' && typeof v !== 'function')) return;
  if (!root && v.key === '$Root' && typeof v.buildLayout === 'function') root = v;
  else if (!types && typeof v.SIDEBAR_ITEM === 'number' && typeof v.SECTION === 'number' && typeof v.PANEL === 'number') types = v;
  else if (!React && typeof v.createElement === 'function' && typeof v.useEffect === 'function' && typeof v.Fragment !== 'undefined') React = v;
};

const scan = () => {
  const cache = getReq()?.c;
  if (!cache) return;

  for (const id in cache) {
    if (root && types && React) break;
    if (scanned.has(id)) continue;

    const ex = cache[id]?.exports;
    if (ex == null) continue;

    try {
      check(ex);
      if (typeof ex === 'object' || typeof ex === 'function') for (const k of Object.keys(ex)) check(ex[k]);
      scanned.add(id);
    } catch { } // export not initialised yet (TDZ); look again next scan
  }

  diag.root = !!root; diag.types = !!types; diag.react = !!React;
};

const lastLaunch = cfg.stats?.last ? `Last launch: Discord window in ${cfg.stats.last.toFixed(1)} s` + (cfg.stats.avg ? ` (average ${cfg.stats.avg.toFixed(1)} s over ${cfg.stats.n} launches)` : '') : '';

const Panel = () => {
  const h = React.createElement;
  React.useEffect(() => { open(); }, []);

  const btn = { cursor: 'pointer', border: 0, borderRadius: '8px', padding: '9px 18px', fontWeight: 600, fontSize: '14px', color: '#fff', background: 'var(--brand-500, #5865f2)' };
  const muted = { color: 'var(--text-muted, #94959c)', fontSize: '13px' };

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--text-default, var(--text-normal, #dbdee1))', fontSize: '14px', lineHeight: 1.5 } },
    h('div', null, 'asar settings open in their own window. If it went behind Discord, click the button.'),
    h('div', null, h('button', { type: 'button', onClick: open, style: btn }, 'Open asar settings')),
    h('div', { style: muted }, `asar ${cfg.version}` + (lastLaunch ? ' · ' + lastLaunch : '')),
    h('div', { style: muted }, `Shortcut anywhere in Discord: ${cfg.hotkey}`)
  );
};

const Icon = () => React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 64 64', fill: 'currentColor', 'aria-hidden': true, 'data-asar-icon': '' },
  React.createElement('path', { opacity: 0.4, d: 'M32 26 56 38 32 50 8 38Z' }),
  React.createElement('path', { opacity: 0.7, d: 'M32 17 56 29 32 41 8 29Z' }),
  React.createElement('path', { d: 'M32 8 56 20 32 32 8 20Z' })
);

// Vencord's defaults for Discord's layout node types, used if the enum module isn't loaded yet
const DEFAULT_TYPES = { SECTION: 1, SIDEBAR_ITEM: 2, PANEL: 3, CATEGORY: 5, CUSTOM: 19 };

const buildSection = () => {
  const T = types ?? DEFAULT_TYPES;
  let item;

  if (React) { // Full tab with a panel (Vencord-style)
    const custom = { key: 'asar_custom', type: T.CUSTOM, Component: Panel, useSearchTerms: () => [ 'asar', 'openasar' ] };
    const category = { key: 'asar_category', type: T.CATEGORY ?? 5, buildLayout: () => [ custom ] };
    const panel = { key: 'asar_panel', type: T.PANEL, useTitle: () => 'asar', buildLayout: () => [ category ] };
    item = { key: 'asar_main', type: T.SIDEBAR_ITEM, useTitle: () => 'asar', icon: () => React.createElement(Icon), buildLayout: () => [ panel ] };
  } else { // No React found: a sidebar item that just opens the window (BetterDiscord-style onClick item)
    item = { key: 'asar_main', type: T.SIDEBAR_ITEM, useTitle: () => 'asar', icon: () => null, buildLayout: () => [], onClick: open, usePredicate: () => true, useSearchTerms: () => [ 'asar' ] };
  }

  return { key: 'asar_section', type: T.SECTION, useTitle: () => 'asar', buildLayout: () => [ item ] };
};

const patchSettings = () => {
  if (patched) return true;
  scan();
  if (!root) { report(); return false; }

  const orig = root.buildLayout;
  const wrapped = function (...args) {
    const layout = orig.apply(this, args);
    diag.builds++;
    setTimeout(versionLine, 400); // settings are opening: add the version line too
    try {
      if (Array.isArray(layout) && !layout.some(s => s?.key === 'asar_section')) {
        let i = layout.findIndex(s => s?.key === 'games_and_apps_section');
        if (i === -1) i = layout.findIndex(s => s?.key === 'utility_section') - 1;
        layout.splice(i < 0 ? layout.length : i + 1, 0, buildSection());
      }
    } catch (e) { fail('buildLayout', e); }
    report();
    return layout;
  };

  try { root.buildLayout = wrapped; } catch { }
  if (root.buildLayout !== wrapped) try { Object.defineProperty(root, 'buildLayout', { value: wrapped, configurable: true, writable: true }); } catch (e) { fail('patch', e); }

  patched = diag.patched = root.buildLayout === wrapped;
  report();
  if (patched) cleanup();
  return patched;
};

// Discord downloads its settings code early but only runs it the first time settings opens, then builds the menu.
// Wrap every not-yet-run module that mentions "$Root" (like BetterDiscord does for all modules) so the root is
// patched the instant its module runs, before the menu is built. Also hook chunks that arrive later.
const wrapFactory = (mods, id, onDone) => {
  const f = mods[id];
  if (typeof f !== 'function' || f.__asar) return;
  let src;
  try { src = Function.prototype.toString.call(f); } catch { return; }
  if (!src.includes('$Root')) return;

  const w = function () {
    try { return f.apply(this, arguments); }
    finally {
      try { if (onDone) onDone(f); } catch { }
      try { patchSettings(); } catch (e) { fail('afterModule', e); }
    }
  };
  w.__asar = true;
  w.toString = () => src;
  mods[id] = w;
  diag.wrapped++;
};

const wrapPending = () => {
  const r = getReq();
  if (!r?.m) return;
  for (const id in r.m) {
    if (r.c?.[id]) continue; // already ran
    wrapFactory(r.m, id, f => { r.m[id] = f; });
  }
};

let unhook = () => { };
const hookChunks = () => {
  const chunk = window.webpackChunkdiscord_app;
  if (!chunk?.push || chunk.__asarHooked) return;

  const orig = chunk.push;
  const hooked = function (data) {
    try {
      const mods = data?.[1];
      if (!patched && mods && typeof mods === 'object') for (const id in mods) wrapFactory(mods, id);
    } catch { }
    return orig.apply(this, arguments);
  };

  chunk.push = hooked;
  chunk.__asarHooked = true;
  unhook = () => { if (chunk.push === hooked) chunk.push = orig; chunk.__asarHooked = false; };
};

// Always-visible "asar" line under Discord's build info at the bottom of the settings sidebar
// ("stable 627798 (01ad173) • 1.0.9260 x64"). Matched case-insensitively on the release channel, so it works in any language.
const VERSION_XPATH = '//text()[contains(.,"(")][' + [ 'stable', 'Stable', 'STABLE', 'ptb', 'PTB', 'Ptb', 'canary', 'Canary', 'CANARY', 'development', 'Development' ]
  .map(c => `starts-with(normalize-space(.),"${c} ")`).join(' or ') + ']';
let lastLine = 0, lineTimer = 0;
const versionLine = () => {
  if (document.getElementById('asar-ver')) return;
  const wait = (patched ? 1500 : 3000) - (Date.now() - lastLine);
  if (wait > 0) { // rate limited: try again once the window has passed instead of dropping it
    if (!lineTimer) lineTimer = setTimeout(() => { lineTimer = 0; versionLine(); }, wait + 20);
    return;
  }
  lastLine = Date.now();

  const res = document.evaluate(VERSION_XPATH, document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  for (let i = 0; i < res.snapshotLength; i++) {
    const t = res.snapshotItem(i);
    if (!/^(stable|ptb|canary|development)\s+\d+/i.test(t.nodeValue.trim())) continue;

    const el = t.parentElement;
    const anchor = el.closest('div') ?? el;
    const ver = el.cloneNode(false);
    ver.removeAttribute('id');
    ver.id = 'asar-ver';
    ver.textContent = `asar ${cfg.version} · open settings (${cfg.hotkey})`;
    Object.assign(ver.style, { display: 'block', cursor: 'pointer', textDecoration: 'underline', marginTop: '4px' });
    ver.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); open(); }, true);
    anchor.insertAdjacentElement('afterend', ver);
    diag.line = true;
    report();
    return;
  }
};

let timer;
const attempt = () => {
  try { patchSettings(); } catch (e) { fail('attempt', e); }
  // Once the tab is patched in, our icon only exists while settings are open, so the (whole-page) version-line
  // search never runs while you're using chat
  try { if (!patched || document.querySelector('[data-asar-icon]')) versionLine(); } catch (e) { fail('line', e); }
};
const schedule = e => {
  if (e.type === 'keyup' && !(e.ctrlKey || e.metaKey)) return; // typing in chat: ignore (settings open with a click or Ctrl+,)
  clearTimeout(timer);
  timer = setTimeout(attempt, 200);
};
const cleanup = () => unhook();

if (cfg.entry) {
  try { getReq(); hookChunks(); wrapPending(); } catch (e) { fail('init', e); }
  for (const t of [ 1000, 4000, 15000 ]) setTimeout(attempt, t);
  setTimeout(() => unhook(), 180000); // stop inspecting new code chunks after 3 minutes no matter what
  document.addEventListener('click', schedule, true);
  document.addEventListener('keyup', schedule, true);
  report();
}

// Freeze heartbeat: if this 1 s timer fires late, the page was frozen for that long. Works without input (Electron's
// "unresponsive" event only fires if you click or type during the freeze). Only counted while Discord is visible,
// since hidden pages may be throttled legitimately.
{
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - last - 1000;
    last = now;
    if (gap > 3000 && document.visibilityState === 'visible') {
      try { DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', { asarFreeze: Math.round(gap + 1000) }); } catch { }
    }
  }, 1000);
}

// Slow-request log: any request that takes over 2 s, split into where the time went, so a slow channel can be
// pinned on the network/Discord's servers ("waiting for server") or on this PC ("stalled before sending").
// Only the host and path are kept, with long numbers (channel/message IDs) replaced by :id.
try {
  diag.slow = [];
  new PerformanceObserver(list => {
    let changed = false;
    for (const e of list.getEntries()) {
      if (e.duration < 2000 || !/^https?:/.test(e.name)) continue;
      let where = e.name;
      try { const u = new URL(e.name); where = u.host + u.pathname.replace(/\d{6,}/g, ':id'); } catch { }
      const r = e.requestStart > 0;
      diag.slow.push({
        at: new Date(performance.timeOrigin + e.startTime).toISOString(),
        where,
        total: Math.round(e.duration),
        stalled: r ? Math.round(e.requestStart - e.startTime) : null,
        server: r ? Math.round(e.responseStart - e.requestStart) : null,
        download: r ? Math.round(e.responseEnd - e.responseStart) : null
      });
      changed = true;
    }
    if (changed) {
      if (diag.slow.length > 25) diag.slow.splice(0, diag.slow.length - 25);
      report();
    }
  }).observe({ type: 'resource', buffered: false });
} catch { }

// Freeze diagnostics: long tasks (>1 s) on Discord's page, reported to asar-diagnostics.json
try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.duration < 1000) continue;
      diag.longTasks++;
      diag.longestTask = Math.max(diag.longestTask, Math.round(e.duration));
    }
    report();
  }).observe({ type: 'longtask', buffered: true });
} catch { }

// --- Preload channels on hover + channel switch timing ---
// When the pointer rests on a channel link for 150 ms, ask Discord to fetch that channel's messages (the same call it
// makes when you click), so they're usually there by the time you click. Conservative: text-type channels only,
// channels Discord hasn't loaded yet, at most one request per 500 ms, each channel at most once per 2 minutes.
const perfMods = { actions: null, messages: null, channels: null };
const perfScanned = new Set();
const findPerf = () => {
  if (perfMods.actions && perfMods.messages && perfMods.channels) return true;
  const cache = getReq()?.c;
  if (!cache) return false;
  const look = v => {
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) return;
    if (!perfMods.actions && typeof v.fetchMessages === 'function' && typeof v.sendMessage === 'function') perfMods.actions = v;
    else if (v._dispatchToken !== undefined && typeof v.getName === 'function') {
      const n = v.getName();
      if (n === 'MessageStore' && !perfMods.messages) perfMods.messages = v;
      else if (n === 'ChannelStore' && !perfMods.channels) perfMods.channels = v;
    }
  };
  for (const id in cache) {
    if (perfScanned.has(id)) continue;
    const ex = cache[id]?.exports;
    if (ex == null) continue;
    try {
      look(ex);
      if (typeof ex === 'object' || typeof ex === 'function') for (const k of Object.keys(ex)) look(ex[k]);
      perfScanned.add(id);
    } catch { }
    if (perfMods.actions && perfMods.messages && perfMods.channels) break;
  }
  diag.prefetchReady = !!(perfMods.actions && perfMods.messages && perfMods.channels);
  return diag.prefetchReady;
};

const TEXT_TYPES = new Set([ 0, 1, 3, 5, 10, 11, 12 ]); // text, DM, group DM, announcement, threads
const prefetched = new Map(); // channelId -> time
let lastPrefetch = 0, hoverTimer = 0;
diag.prefetch = { sent: 0, skipped: 0, failed: 0 };

const channelIdOf = a => {
  const m = /^\/channels\/(?:@me|\d+)\/(\d+)/.exec(a.getAttribute('href') || '');
  return m?.[1];
};

// Returns 'gated' if it should be retried a bit later (rate limit), anything else means done/skipped
const prefetch = (cid, kind = 'hover') => {
  if (!(kind === 'kept' ? cfg.keepReady : cfg.prefetch) || document.hidden || location.pathname.endsWith('/' + cid)) return;
  if (Date.now() - (prefetched.get(cid) ?? 0) < 120000) return;
  if (Date.now() - lastPrefetch < 500) return 'gated';
  if (!findPerf()) return;
  try {
    const ch = perfMods.channels.getChannel?.(cid);
    if (!ch || !TEXT_TYPES.has(ch.type)) { diag.prefetch.skipped++; return; }
    const cm = perfMods.messages.getMessages?.(cid);
    if (cm && ((cm.ready || cm.hasFetched) && cm.length > 0 || cm.loadingMore)) { diag.prefetch.skipped++; return; } // loaded or loading
    prefetched.set(cid, Date.now());
    lastPrefetch = Date.now();
    diag.prefetch.sent++;
    if (kind === 'kept') diag.prefetch.kept = (diag.prefetch.kept ?? 0) + 1;
    const r = perfMods.actions.fetchMessages({ channelId: cid, limit: 50 });
    if (r?.catch) r.catch(() => { diag.prefetch.failed++; });
  } catch { diag.prefetch.failed++; }
};

// --- Keep your top channels ready ---
// Channels you open most (counted by asar, stored in Discord's settings.json) are loaded in the background: the top
// 4 in the server you're in plus your top channels overall, max 10, one every 0.8 s, never while Discord is hidden.
// Discord keeps loaded channels in memory, so this only sends a request for channels it doesn't have (or dropped).
const guildOf = () => /^\/channels\/(@me|\d+)/.exec(location.pathname)?.[1];
const warmQueue = [];
let warmTimer = 0;
const pump = () => {
  warmTimer = 0;
  if (!warmQueue.length) return;
  if (document.hidden) { warmTimer = setTimeout(pump, 5000); return; }
  const c = warmQueue.shift();
  if (prefetch(c, 'kept') === 'gated') warmQueue.unshift(c);
  warmTimer = setTimeout(pump, 800);
};
const keepReady = () => {
  if (!cfg.keepReady || !findPerf()) return;
  const top = cfg.top ?? [];
  const g = guildOf();
  const want = [ ...top.filter(v => v.g === g).slice(0, 4), ...top.slice(0, 8) ].map(v => v.c);
  for (const c of new Set(want)) if (!warmQueue.includes(c) && warmQueue.length < 10) warmQueue.push(c);
  if (!warmTimer) pump();
};
if (cfg.keepReady) {
  let lastGuild = null;
  setInterval(() => { // server switch -> keep that server's top channels ready
    const g = guildOf();
    if (g && g !== lastGuild) { lastGuild = g; keepReady(); }
  }, 3000);
  setInterval(keepReady, 300000);
}

if (cfg.prefetch || cfg.keepReady) {
  // Find Discord's message modules while idle, so the first hover doesn't pay for it; then fill the keep-ready list
  (window.requestIdleCallback ?? setTimeout)(() => { try { findPerf(); report(); keepReady(); } catch { } }, { timeout: 15000 });
}

if (cfg.prefetch) {
  document.addEventListener('mouseover', e => {
    const a = e.target?.closest?.('a[href^="/channels/"]');
    clearTimeout(hoverTimer);
    if (!a) return;
    const cid = channelIdOf(a);
    if (cid) hoverTimer = setTimeout(() => prefetch(cid), 150);
  }, { capture: true, passive: true });
}

// --- Loading screen ---
// Covers the message area (where channels, threads and DMs show) with a calm skeleton while a channel loads.
// Shown only if the channel isn't on screen within 120 ms, so instant switches show nothing. Lives outside Discord's
// React tree (fixed over the chat's box), one shimmer animation on a single layer, styles scoped to #asar-load.
const LOAD_CSS = `
#asar-load{position:fixed;z-index:2147483646;pointer-events:none;overflow:hidden;contain:strict;opacity:0;transition:opacity .16s ease;
 background:var(--background-base-lower,var(--background-primary,#1a1a1e));font-family:var(--font-primary,system-ui,sans-serif)}
#asar-load.on{opacity:1}
#asar-load .hd{display:flex;align-items:center;gap:10px;padding:24px 32px 10px}
#asar-load .hd i{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid color-mix(in srgb,var(--brand-500,#8b7bff) 28%,transparent);border-top-color:var(--brand-500,#8b7bff);animation:asar-spin .75s linear infinite}
#asar-load .hd b{font-weight:600;font-size:15px;color:var(--text-strong,var(--header-primary,#f2f3f5));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#asar-load .hd span{font-size:13px;color:var(--text-muted,#949ba4);white-space:nowrap}
#asar-load ul{list-style:none;margin:0;padding:14px 32px;display:grid;gap:26px}
#asar-load li{display:grid;grid-template-columns:40px minmax(0,1fr);gap:16px}
#asar-load .av{width:40px;height:40px;border-radius:50%}
#asar-load .tx{display:grid;gap:9px;padding-top:3px}
#asar-load .ln{height:10px;border-radius:5px}
#asar-load .ln.nm{height:11px}
#asar-load .av,#asar-load .ln{background:color-mix(in srgb,var(--text-default,var(--text-normal,#dbdee1)) 8%,transparent)}
#asar-load .ln.nm{background:color-mix(in srgb,var(--text-default,var(--text-normal,#dbdee1)) 13%,transparent)}
#asar-load .sh{position:absolute;inset:0;will-change:transform;transform:translateX(-100%);animation:asar-sweep 1.25s cubic-bezier(.4,0,.2,1) infinite;
 background:linear-gradient(100deg,transparent 35%,color-mix(in srgb,var(--text-default,#fff) 4.5%,transparent) 50%,transparent 65%)}
@keyframes asar-spin{to{transform:rotate(360deg)}}
@keyframes asar-sweep{to{transform:translateX(100%)}}`;

let loadEl = null, loadFor = null;
const rnd = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647; // stable widths per channel
const buildLoad = cid => {
  if (!document.getElementById('asar-load-css')) addStyle('asar-load-css', LOAD_CSS);
  if (!loadEl?.isConnected) {
    loadEl = document.createElement('div');
    loadEl.id = 'asar-load';
    loadEl.setAttribute('role', 'status');
    loadEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(loadEl);
  }
  const r = rnd(Number(String(cid).slice(-9)) || 7);
  let rows = '';
  for (let i = 0; i < 8; i++) {
    const lines = 1 + Math.floor(r() * 2.2);
    let tx = `<div class="ln nm" style="width:${14 + Math.round(r() * 14)}%"></div>`;
    for (let j = 0; j < lines; j++) tx += `<div class="ln" style="width:${35 + Math.round(r() * 55)}%"></div>`;
    rows += `<li><div class="av"></div><div class="tx">${tx}</div></li>`;
  }
  loadEl.innerHTML = `<div class="hd"><i></i><b></b><span>Loading messages…</span></div><ul>${rows}</ul><div class="sh"></div>`;
  let name = '', type = 0;
  try { const ch = perfMods.channels?.getChannel?.(cid); name = ch?.name ?? ''; type = ch?.type ?? 0; } catch { }
  loadEl.querySelector('b').textContent = name ? ((type === 1 || type === 3) ? name : (type >= 10 && type <= 12 ? '› ' : '#') + name) : 'Opening channel';
};

// Where the messages are drawn: Discord's chat <main>; fallback: everything right of the channel list, below the header
const chatRect = () => {
  const list = document.querySelector('ol[data-list-id="chat-messages"]');
  const box = list?.closest('main') ?? document.querySelector('main[class*="chatContent"]') ?? document.querySelector('[class*="chatContent"]');
  const b = box?.getBoundingClientRect();
  if (b && b.width > 200 && b.height > 150) return b;
  const nav = document.querySelector('a[href^="/channels/"]')?.closest('nav')?.getBoundingClientRect();
  if (!nav) return null;
  return { left: nav.right, top: nav.top + 48, width: innerWidth - nav.right, height: innerHeight - nav.top - 48 };
};

const placeLoad = () => {
  const b = loadEl && chatRect();
  if (!b) return false;
  Object.assign(loadEl.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
  return true;
};
const showLoad = cid => {
  buildLoad(cid);
  if (!placeLoad()) return;
  loadFor = cid;
  requestAnimationFrame(() => loadEl?.classList.add('on'));
};
const hideLoad = () => { loadFor = null; loadEl?.classList.remove('on'); };
addEventListener('resize', () => { if (loadFor) placeLoad(); }, { passive: true });

// A channel counts as ready when its first message is on screen, or Discord says it's loaded and empty
const isReady = cid => {
  if (document.querySelector('li[id^="chat-messages-' + cid + '-"]')) return true;
  try { const cm = perfMods.messages?.getMessages?.(cid); if (cm && cm.ready && cm.length === 0) return true; } catch { }
  return false;
};

// --- Navigation tracking (channel switch timing + loading screen) ---
// Any way of opening a channel counts: channel/thread links, DMs, server icons, jump links.
diag.switches = [];
let navId = 0;
const cidFromPath = p => /^\/channels\/(?:@me|\d+)\/(\d+)/.exec(p)?.[1];
const startNav = (cid, warm) => {
  const id = ++navId;
  hideLoad();
  const t0 = performance.now();
  const showAt = setTimeout(() => { if (id === navId && cfg.loader && !isReady(cid)) showLoad(cid); }, 120);
  const poll = () => {
    if (id !== navId) return clearTimeout(showAt); // another navigation took over
    const ms = performance.now() - t0;
    if (isReady(cid)) {
      clearTimeout(showAt);
      // let the first frame of messages paint before fading out
      requestAnimationFrame(() => requestAnimationFrame(() => { if (id === navId) hideLoad(); }));
      diag.switches.push({ ms: Math.round(ms), warm });
      if (diag.switches.length > 30) diag.switches.shift();
      return report();
    }
    if (ms < 8000) setTimeout(poll, 40);
    else hideLoad(); // never leave it up
  };
  setTimeout(poll, 0);
};

document.addEventListener('click', e => {
  const a = e.target?.closest?.('a[href^="/channels/"]');
  const cid = a && channelIdOf(a);
  if (cid) {
    clearTimeout(hoverTimer); // the click loads it now; a hover preload would only duplicate that
    const warm = prefetched.has(cid);
    if (!warm) prefetched.set(cid, Date.now());
    const gid = /^\/channels\/(@me|\d+)\//.exec(a.getAttribute('href'))?.[1];
    try { DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', { asarVisit: { c: cid, g: gid } }); } catch { }
    if (location.pathname.endsWith('/' + cid)) return; // already there
    return startNav(cid, warm);
  }
  // Not a channel link (server icon, DM, jump button...): see if the click navigated somewhere
  const before = location.pathname, id = navId;
  for (const t of [ 40, 140, 320 ]) setTimeout(() => {
    if (navId !== id || location.pathname === before) return;
    const c = cidFromPath(location.pathname);
    if (c && c !== cidFromPath(before)) startNav(c, prefetched.has(c));
  }, t);
}, { capture: true, passive: true });
addEventListener('keydown', e => { if (e.key === 'Escape') hideLoad(); }, { capture: true, passive: true });

// --- Free memory in the background ---
// After Discord has been hidden (minimized, or covered by a game) for 2 minutes, ask Discord to release memory it
// doesn't need, using its own DiscordNative.processUtils.purgeMemory (garbage collection + Chromium caches). At most
// every 30 minutes, never while you're looking at Discord.
if (cfg.memTrim) {
  let hiddenAt = document.hidden ? Date.now() : 0, trimmedAt = 0;
  diag.mem = { trims: 0, freedMB: 0 };
  document.addEventListener('visibilitychange', () => { hiddenAt = document.hidden ? Date.now() : 0; });
  const heapMB = () => (performance.memory?.usedJSHeapSize ?? 0) / 1048576;
  setInterval(() => {
    if (!hiddenAt || Date.now() - hiddenAt < 120000 || Date.now() - trimmedAt < 1800000) return;
    const purge = window.DiscordNative?.processUtils?.purgeMemory;
    if (typeof purge !== 'function') return;
    trimmedAt = Date.now();
    const before = heapMB();
    try { purge(); } catch { return; }
    setTimeout(() => {
      const freed = Math.max(0, before - heapMB());
      diag.mem.trims++;
      diag.mem.freedMB = Math.round(diag.mem.freedMB + freed);
      diag.mem.lastMB = Math.round(freed);
      report();
    }, 8000);
  }, 30000);
}

// Clicking the asar tab always opens the window, even when the tab is already selected (Discord doesn't re-render then)
document.addEventListener('click', e => {
  const icon = document.querySelector('[data-asar-icon]');
  if (!icon) return;
  let row = icon;
  while (row && row.getBoundingClientRect().width < 120) row = row.parentElement;
  const r = row?.getBoundingClientRect();
  if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) open();
}, true);

// --- DOM Optimizer: defer removal of heavy activity nodes to avoid layout thrash ---
if (cfg.domOpt) {
  const orig = Element.prototype.removeChild;
  Element.prototype.removeChild = function (child) {
    const cn = child?.className;
    if (typeof cn === 'string' && cn.indexOf('activity') !== -1) {
      setTimeout(() => { if (child.parentNode === this) orig.call(this, child); }, 100);
      return child;
    }
    return orig.call(this, child);
  };
}
})();
