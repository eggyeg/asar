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
// popouts, modals and overlays. Animations are turned off separately via --force-prefers-reduced-motion in the main process.
const perfCSS = [
  cfg.noBlur && '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
  cfg.instant && '*,*::before,*::after{transition-duration:1ms!important;transition-delay:0s!important;scroll-behavior:auto!important}'
].filter(Boolean).join('');

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
