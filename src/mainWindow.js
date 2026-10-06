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
    (window.requestIdleCallback ?? setTimeout)(() => versionLine(), { timeout: 1500 }); // settings are opening: add the version line when idle
    settingsBuilt();
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
const rootSrc = new Map(); // module id -> source, for modules that build Discord's settings
const wrapFactory = (mods, id, onDone) => {
  const f = mods[id];
  if (typeof f !== 'function' || f.__asar) return;
  let src;
  try { src = Function.prototype.toString.call(f); } catch { return; }
  if (!src.includes('$Root')) return;
  rootSrc.set(id, src);

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
const perfMods = { actions: null, messages: null, channels: null, users: null, router: null };
const perfScanned = new Set();
let perfScans = 0;
const findPerf = () => {
  const core = () => !!(perfMods.actions && perfMods.messages && perfMods.channels);
  // Optional extras (user names, settings router) are only looked for a few times; never a cost on every hover
  if (core() && ((perfMods.users && perfMods.router) || perfScans >= 3)) return true;
  const cache = getReq()?.c;
  if (!cache) return false;
  perfScans++;
  const look = v => {
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) return;
    if (!perfMods.actions && typeof v.fetchMessages === 'function' && typeof v.sendMessage === 'function') perfMods.actions = v;
    else if (v._dispatchToken !== undefined && typeof v.getName === 'function') {
      const n = v.getName();
      if (n === 'MessageStore' && !perfMods.messages) perfMods.messages = v;
      else if (n === 'ChannelStore' && !perfMods.channels) perfMods.channels = v;
      else if (n === 'UserStore' && !perfMods.users) perfMods.users = v;
    }
    else if (!perfMods.router && typeof v.openUserSettings === 'function' && 'USER_SETTINGS_MODAL_KEY' in v) perfMods.router = v;
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
    if (perfMods.actions && perfMods.messages && perfMods.channels && perfMods.users && perfMods.router) break;
  }
  diag.prefetchReady = core();
  if (perfMods.router) wrapRouter();
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
#asar-load .hd{display:flex;align-items:center;gap:12px;padding:22px 32px 8px}
#asar-load .sp{width:16px;height:16px;flex:none;border-radius:50%;will-change:transform;border:2px solid color-mix(in srgb,var(--brand-500,#8b7bff) 26%,transparent);border-top-color:var(--brand-500,#8b7bff);animation:asar-spin .75s linear infinite}
#asar-load .tt{display:grid;gap:3px;min-width:0}
#asar-load .tt b{font-weight:600;font-size:15px;color:var(--text-strong,var(--header-primary,#f2f3f5));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#asar-load .st{font-size:13px;line-height:16px;height:16px;color:var(--text-muted,#949ba4);white-space:nowrap}
#asar-load .st span{display:inline-block}
#asar-load .dots span{width:.42em;opacity:0;will-change:opacity}
#asar-load .dots span:nth-child(1){animation:asar-d1 2.4s infinite}
#asar-load .dots span:nth-child(2){animation:asar-d2 2.4s infinite}
#asar-load .dots span:nth-child(3){animation:asar-d3 2.4s infinite}
@keyframes asar-d1{0%,12%{opacity:0}12.5%,74%{opacity:1}75%,100%{opacity:0}}
@keyframes asar-d2{0%,24%{opacity:0}25%,61%{opacity:1}62%,100%{opacity:0}}
@keyframes asar-d3{0%,37%{opacity:0}37.5%,49%{opacity:1}50%,100%{opacity:0}}
#asar-load .wave span{will-change:transform,opacity;animation:asar-wave 1.3s ease-in-out infinite;animation-delay:calc(var(--i)*90ms)}
@keyframes asar-wave{0%,60%,100%{transform:none;opacity:.55}30%{transform:translateY(-3px);opacity:1}}
#asar-load .wave span.sep{animation:none;opacity:.35;padding:0 .12em}
#asar-load .type span{opacity:0;will-change:opacity;animation:asar-type 2.8s infinite;animation-delay:calc(var(--i)*65ms)}
#asar-load .type u{text-decoration:none;display:inline-block;margin-left:1px;width:1px;height:13px;vertical-align:-2px;background:currentColor;animation:asar-caret .9s steps(1) infinite}
@keyframes asar-type{0%{opacity:0}3%,70%{opacity:1}74%,100%{opacity:0}}
@keyframes asar-caret{50%{opacity:0}}
#asar-load .shim{position:relative;display:inline-block}
#asar-load .shim .win{position:absolute;left:0;top:0;height:100%;width:40%;overflow:hidden;will-change:transform;animation:asar-win 1.7s linear infinite;
 -webkit-mask-image:linear-gradient(90deg,transparent,#000 35%,#000 65%,transparent);mask-image:linear-gradient(90deg,transparent,#000 35%,#000 65%,transparent)}
#asar-load .shim .hi{position:absolute;left:0;top:0;white-space:nowrap;color:var(--text-strong,var(--header-primary,#fff));will-change:transform;animation:asar-hi 1.7s linear infinite}
@keyframes asar-win{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@keyframes asar-hi{from{transform:translateX(40%)}to{transform:translateX(-100%)}}
#asar-load.full{display:grid;place-items:center}
#asar-load.full .hd{padding:0;flex-direction:column;gap:14px;text-align:center}
#asar-load.full .sp{width:22px;height:22px}
#asar-load.full .tt{justify-items:center}
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
  const d = describe(cid);
  loadEl.className = '';
  loadEl.innerHTML = `<div class="hd"><div class="sp"></div><div class="tt"><b></b>${statusHTML(d.kind)}</div></div><ul>${rows}</ul><div class="sh"></div>`;
  loadEl.querySelector('b').textContent = d.title;
};

// What's being opened, in words: DMs are chats, not channels
const userName = id => {
  try { const u = perfMods.users?.getUser?.(id); return u?.globalName || u?.global_name || u?.username || ''; } catch { return ''; }
};
const describe = cid => {
  let ch = null;
  try { ch = perfMods.channels?.getChannel?.(cid); } catch { }
  const dmPath = location.pathname.startsWith('/channels/@me') || pendingDM === cid;
  const type = ch?.type ?? (dmPath ? 1 : 0);
  const recips = ch?.recipients ?? ch?.rawRecipients?.map(r => r.id) ?? [];
  if (type === 1) {
    const n = ch?.name || userName(recips[0]);
    return { kind: 'chat', title: n ? 'Chat with ' + n : 'Opening chat' };
  }
  if (type === 3) {
    const n = ch?.name || recips.slice(0, 3).map(userName).filter(Boolean).join(', ');
    return { kind: 'chat', title: n || 'Group chat' };
  }
  if (type >= 10 && type <= 12) return { kind: 'thread', title: ch?.name ? '› ' + ch.name : 'Opening thread' };
  return { kind: 'channel', title: ch?.name ? '#' + ch.name : 'Opening channel' };
};

// Animated status line under the title, a different style each time: cycling dots, a letter wave, typing, shimmer
let styleTurn = Math.floor(Math.random() * 4);
const letters = (word, cls) => [ ...word ].map((c, i) => `<span${c === '-' ? ' class="sep"' : ''} style="--i:${i}">${c === ' ' ? '&nbsp;' : c}</span>`).join('');
const PHRASES = {
  chat: { dots: 'Loading chat', type: 'Opening your chat', shim: 'Fetching your messages' },
  thread: { dots: 'Loading thread', type: 'Catching up', shim: 'Fetching replies' },
  channel: { dots: 'Loading messages', type: 'Catching up', shim: 'Fetching messages' },
  settings: { dots: 'Loading settings', type: 'Getting things ready', shim: 'Preparing settings' }
};
const statusHTML = kind => {
  const p = PHRASES[kind] ?? PHRASES.channel;
  const style = styleTurn++ % 4;
  if (style === 0) return `<div class="st dots">${p.dots}<span>.</span><span>.</span><span>.</span></div>`;
  if (style === 1) return `<div class="st wave">${letters('l-o-a-d-i-n-g')}</div>`;
  if (style === 2) return `<div class="st type">${letters(p.type)}<u></u></div>`;
  // Shimmer built from two counter-moving layers (transform only), so it keeps moving while Discord is busy
  return `<div class="st shim"><span>${p.shim}</span><span class="win" aria-hidden="true"><span class="hi">${p.shim}</span></span></div>`;
};
let pendingDM = null;

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
const showLoad = (cid, now = false) => {
  if (loadFor === cid && loadEl?.classList.contains('on')) return;
  buildLoad(cid);
  if (!placeLoad()) return;
  loadFor = cid;
  if (!now) return requestAnimationFrame(() => loadEl?.classList.add('on'));
  // Instant: visible in the very next frame (no fade-in), so it's on screen before Discord starts building the channel
  loadEl.style.transition = 'none';
  loadEl.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => { if (loadEl) loadEl.style.transition = ''; }));
};

// Thin progress line across the top of the chat, for channels Discord already has (building them can still take a
// moment). Shown instantly on click; a fast switch hides it before you'd notice. Animated on the compositor, so it
// keeps moving even while Discord's main thread is busy rendering.
let barEl = null;
const showBar = () => {
  if (!document.getElementById('asar-bar-css')) addStyle('asar-bar-css', `
#asar-bar{position:fixed;z-index:2147483646;height:2px;pointer-events:none;overflow:hidden;contain:strict}
#asar-bar i{position:absolute;top:0;bottom:0;width:35%;border-radius:2px;background:var(--brand-500,#8b7bff);will-change:transform;animation:asar-bar 0.9s cubic-bezier(.4,0,.2,1) infinite}
@keyframes asar-bar{from{transform:translateX(-100%)}to{transform:translateX(290%)}}
.asar-pending{background:var(--background-modifier-selected,rgba(78,80,88,.6))!important;color:var(--interactive-active,#fff)!important;border-radius:4px}`);
  if (!barEl?.isConnected) {
    barEl = document.createElement('div');
    barEl.id = 'asar-bar';
    barEl.innerHTML = '<i></i>';
    document.body.appendChild(barEl);
  }
  const b = chatRect();
  if (!b) return;
  Object.assign(barEl.style, { display: 'block', left: b.left + 'px', top: b.top + 'px', width: b.width + 'px' });
};
const hideBar = () => { if (barEl) barEl.style.display = 'none'; };

const hideLoad = () => { loadFor = null; loadEl?.classList.remove('on'); hideBar(); };
addEventListener('resize', () => { if (loadFor) placeLoad(); }, { passive: true });

// Discord already has this channel's messages (so opening it needs no download)
const inStore = cid => {
  try { const cm = perfMods.messages?.getMessages?.(cid); return !!(cm && (cm.ready || cm.hasFetched)); } catch { return false; }
};

// A channel counts as ready when its first message is on screen, or Discord says it's loaded and empty
const isReady = cid => {
  if (document.querySelector('li[id^="chat-messages-' + cid + '-"]')) return true;
  try { const cm = perfMods.messages?.getMessages?.(cid); if (cm && cm.ready && cm.length === 0) return true; } catch { }
  return false;
};

// Where a slow switch's time went, from Chromium's long-animation-frame timing: Discord's code (scripts) vs drawing
// (style + layout + paint). Kept for the last few seconds only.
const loafs = [];
try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const script = (e.scripts ?? []).reduce((a, s) => a + s.duration, 0);
      const draw = e.styleAndLayoutStart > 0 ? e.startTime + e.duration - e.styleAndLayoutStart : 0;
      loafs.push({ start: e.startTime, end: e.startTime + e.duration, script, draw });
    }
    while (loafs.length > 60) loafs.shift();
  }).observe({ type: 'long-animation-frame', buffered: false });
} catch { }
const frameCost = t0 => {
  let js = 0, draw = 0;
  for (const f of loafs) if (f.end >= t0) { js += f.script; draw += f.draw; }
  return js || draw ? { js: Math.round(js), draw: Math.round(draw) } : {};
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
  const showAt = setTimeout(() => { if (id === navId && cfg.loader && !isReady(cid) && !inStore(cid)) showLoad(cid); }, 120);
  const poll = () => {
    if (id !== navId) return clearTimeout(showAt); // another navigation took over
    const ms = performance.now() - t0;
    if (isReady(cid)) {
      clearTimeout(showAt);
      // let the first frame of messages paint before fading out; Discord's own selection is in place by now
      requestAnimationFrame(() => requestAnimationFrame(() => { if (id === navId) { hideLoad(); clearSelection(); } }));
      const cost = frameCost(t0);
      diag.switches.push({ ms: Math.round(ms), warm, ...cost });
      if (diag.switches.length > 30) diag.switches.shift();
      return report();
    }
    if (ms < 8000) setTimeout(poll, 40);
    else { hideLoad(); clearSelection(); } // never leave anything up
  };
  setTimeout(poll, 0);
};

const PASS = new WeakSet(); // clicks asar hands on to Discord after showing feedback
document.addEventListener('click', e => {
  if (PASS.has(e)) return;
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

// --- Instant switching ---
// Discord builds a channel's whole view in one go, and nothing else (not your next click, not the loading screen)
// runs until it's done. So asar takes channel clicks first: it highlights the channel and shows the loading screen
// (or the progress line if Discord already has the messages), lets that reach the screen (one frame), then hands
// the click to Discord. If you click again before that, only the newest click is handed on, so Discord never builds
// channels you've already left. While you're switching quickly, asar waits a little longer to collect clicks.
let pending = null, lastSwitchClick = 0;
const cancelPending = () => {
  if (!pending) return;
  cancelAnimationFrame(pending.raf);
  clearTimeout(pending.timer);
  pending = null;
};

// Move the sidebar selection the instant you click, in Discord's own style: the background and text colours of the
// currently selected row are copied onto the clicked row and cleared from the old one. So while Discord builds the
// channel (when nothing can redraw) the sidebar already shows one clean selection, never two. Once Discord has drawn
// the new channel, these temporary styles are removed and Discord's own state takes over.
let selPatch = [];
const setImp = (el, prop, val) => {
  selPatch.push({ el, prop, value: el.style.getPropertyValue(prop), pri: el.style.getPropertyPriority(prop) });
  el.style.setProperty(prop, val, 'important');
  selPatch[selPatch.length - 1].mine = el.style.getPropertyValue(prop);
};
const clearSelection = () => {
  for (const p of selPatch.reverse()) {
    // Only undo what's still ours; if Discord changed the style meanwhile, leave Discord's value
    if (p.el.style.getPropertyValue(p.prop) !== p.mine || p.el.style.getPropertyPriority(p.prop) !== 'important') continue;
    if (p.value) p.el.style.setProperty(p.prop, p.value, p.pri);
    else p.el.style.removeProperty(p.prop);
  }
  selPatch = [];
  document.querySelectorAll('.asar-pending').forEach(e => e.classList.remove('asar-pending'));
};
const opaque = c => c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c);
const parts = a => [ a, ...a.querySelectorAll('div,span,svg') ].slice(0, 14);
const moveSelection = newA => {
  clearSelection();
  let oldA = null;
  try { oldA = document.querySelector('a[href="' + location.pathname + '"]'); } catch { }
  if (!oldA || oldA === newA || !oldA.isConnected) { newA.classList.add('asar-pending'); return; }

  // The element in the selected row that draws Discord's selection background (the link or one of its parents)
  let carrier = null, depth = 0, el = oldA;
  for (let d = 0; d < 4 && el; d++, el = el.parentElement) {
    if (opaque(getComputedStyle(el).backgroundColor)) { carrier = el; depth = d; break; }
  }
  if (!carrier) { newA.classList.add('asar-pending'); return; }
  let target = newA;
  for (let d = 0; d < depth && target; d++) target = target.parentElement;
  if (!target || target.contains(oldA)) { newA.classList.add('asar-pending'); return; }

  // Read everything first, then write (one style pass)
  const cs = getComputedStyle(carrier);
  const bg = cs.backgroundColor, radius = cs.borderRadius;
  const oldParts = parts(oldA), newParts = parts(newA);
  const selColors = oldParts.map(e => getComputedStyle(e).color);
  // The plain (unselected, not hovered) look comes from another row in the same list; the clicked row is hovered
  const list = newA.closest('nav, ul, [role="tree"], [role="list"]') ?? document;
  const ref = [ ...list.querySelectorAll('a[href^="/channels/"]') ].slice(0, 60).find(x => x !== oldA && x !== newA && !x.matches(':hover') && x.isConnected);
  const refParts = ref ? parts(ref) : [];
  const idleColors = refParts.map(e => getComputedStyle(e).color);

  setImp(target, 'background-color', bg);
  if (radius) setImp(target, 'border-radius', radius);
  setImp(carrier, 'background-color', 'transparent');
  newParts.forEach((e, i) => { if (oldParts[i]?.tagName === e.tagName && selColors[i]) setImp(e, 'color', selColors[i]); });
  oldParts.forEach((e, i) => { if (refParts[i]?.tagName === e.tagName && idleColors[i]) setImp(e, 'color', idleColors[i]); });
};
if (cfg.instantSwitch) document.addEventListener('click', e => {
  if (PASS.has(e) || !e.isTrusted || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = e.target?.closest?.('a[href^="/channels/"]');
  const cid = a && channelIdOf(a);
  if (!cid) return;
  if (location.pathname.endsWith('/' + cid) && !pending) return; // already there

  e.preventDefault();
  e.stopImmediatePropagation();
  cancelPending();

  const now = performance.now();
  const rapid = now - lastSwitchClick < 450;
  lastSwitchClick = now;

  pendingDM = a.getAttribute('href').startsWith('/channels/@me/') ? cid : null;
  try {
    showBar(); // also loads the .asar-pending style
    moveSelection(a);
    if (cfg.loader && !inStore(cid)) { hideBar(); showLoad(cid, true); }
  } catch { }

  const target = e.target, x = e.clientX, y = e.clientY;
  const go = () => {
    if (pending?.a !== a) return;
    pending = null;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: x, clientY: y });
    PASS.add(ev);
    (target.isConnected ? target : a).dispatchEvent(ev);
  };
  pending = { a, cid };
  pending.raf = requestAnimationFrame(() => { if (pending?.a === a) pending.timer = setTimeout(go, rapid ? 110 : 0); });
  diag.instant = (diag.instant ?? 0) + 1;
}, { capture: true });

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

// --- Faster Discord settings ---
// 1. Prepare: while Discord is idle, run the code that builds Discord's settings and download the pieces it loads
//    on first open, so opening settings doesn't have to do that work while you wait.
// 2. Feedback: if Discord's openUserSettings can be wrapped, "Opening settings" appears straight away and settings
//    open one frame later (the same idea as instant switching).
// 3. Measure: how long settings take from your click until they're on screen (asar settings > Performance).
let lastInputAt = 0;
addEventListener('pointerdown', e => { if (e.isTrusted) lastInputAt = performance.now(); }, { capture: true, passive: true });
addEventListener('keydown', e => { if (e.isTrusted) lastInputAt = performance.now(); }, { capture: true, passive: true });

diag.settingsOpen = [];
let settingsT0 = 0;
const settingsBuilt = () => {
  const t0 = settingsT0 || (performance.now() - lastInputAt < 3000 ? lastInputAt : 0);
  settingsT0 = 0;
  if (!t0) return;
  const poll = () => {
    const ms = performance.now() - t0;
    if (document.querySelector('[data-asar-icon]')) {
      hideSettingsLoad();
      diag.settingsOpen.push({ ms: Math.round(ms), first: diag.settingsOpen.length === 0 });
      if (diag.settingsOpen.length > 10) diag.settingsOpen.shift();
      return report();
    }
    if (ms < 6000) setTimeout(poll, 50);
    else hideSettingsLoad();
  };
  setTimeout(poll, 0);
};

const showSettingsLoad = () => {
  if (!document.getElementById('asar-load-css')) addStyle('asar-load-css', LOAD_CSS);
  if (!loadEl?.isConnected) {
    loadEl = document.createElement('div');
    loadEl.id = 'asar-load';
    loadEl.setAttribute('role', 'status');
    document.body.appendChild(loadEl);
  }
  loadEl.className = 'full';
  loadEl.innerHTML = `<div class="hd"><div class="sp"></div><div class="tt"><b>Opening settings</b>${statusHTML('settings')}</div></div><div class="sh"></div>`;
  Object.assign(loadEl.style, { left: '0px', top: '0px', width: innerWidth + 'px', height: innerHeight + 'px', transition: 'none' });
  loadFor = 'settings';
  loadEl.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => { if (loadEl) loadEl.style.transition = ''; }));
  setTimeout(() => { if (loadFor === 'settings') hideSettingsLoad(); }, 6000);
};
const hideSettingsLoad = () => {
  if (loadFor !== 'settings') return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (loadFor !== 'settings') return;
    loadFor = null;
    loadEl?.classList.remove('on');
  }));
};

let routerWrapped = false;
const wrapRouter = () => {
  if (routerWrapped || !cfg.warmSettings) return;
  routerWrapped = true;
  const R = perfMods.router;
  const orig = R.openUserSettings;
  const w = function (...args) {
    settingsT0 = performance.now() - lastInputAt < 3000 ? lastInputAt : performance.now();
    try { showSettingsLoad(); } catch { }
    const self = this;
    requestAnimationFrame(() => setTimeout(() => orig.apply(self, args), 0));
  };
  try { R.openUserSettings = w; } catch { }
  if (R.openUserSettings !== w) try { Object.defineProperty(R, 'openUserSettings', { value: w, writable: true, configurable: true }); } catch { }
  diag.settingsFeedback = R.openUserSettings === w;
  report();
};

const warmSettings = () => {
  if (!cfg.warmSettings || document.hidden) return;
  const r = getReq();
  if (!r?.m || !rootSrc.size) return;
  const before = new Set(Object.keys(r.c));
  let modules = 0;
  for (const id of rootSrc.keys()) {
    if (r.c[id]) continue;
    try { r(id); modules++; } catch (e) { fail('warmSettings', e); }
  }
  // Pieces those modules load later (webpack .e(chunk) calls): download them now, one at a time
  const chunks = new Set();
  const scanSrc = src => { for (const m of src.matchAll(/\.e\(\s*"?([\w-]+)"?\s*\)/g)) chunks.add(m[1]); };
  for (const src of rootSrc.values()) scanSrc(src);
  let n = 0;
  for (const id of Object.keys(r.c)) {
    if (before.has(id) || n++ > 400) continue;
    try { const f = r.m[id]; if (typeof f === 'function') scanSrc(Function.prototype.toString.call(f)); } catch { }
  }
  const list = [ ...chunks ].slice(0, 60);
  diag.settingsWarm = { modules: modules + Math.max(0, Object.keys(r.c).length - before.size - modules), chunks: list.length, loaded: 0 };
  report();
  let i = 0;
  const next = () => {
    if (i >= list.length || typeof r.e !== 'function') return report();
    const c = list[i++];
    Promise.resolve().then(() => r.e(c)).then(() => { diag.settingsWarm.loaded++; }, () => { }).then(() => setTimeout(next, 150));
  };
  next();
};
if (cfg.warmSettings) setTimeout(() => (window.requestIdleCallback ?? setTimeout)(() => { try { findPerf(); warmSettings(); } catch (e) { fail('warm', e); } }, { timeout: 10000 }), 20000);

// Clicking the asar tab always opens the window, even when the tab is already selected (Discord doesn't re-render then)
document.addEventListener('click', e => {
  const icon = document.querySelector('[data-asar-icon]');
  if (!icon) return;
  // The sidebar row our icon sits in (no layout measuring, so clicks in settings stay cheap)
  const row = icon.closest('[role="tab"],[role="button"],[role="menuitem"],[role="link"],a,li,[class*="item"]') ?? icon.parentElement;
  if (row?.contains(e.target)) open();
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
