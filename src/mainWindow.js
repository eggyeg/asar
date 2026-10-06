(() => {
const cfg = __ASAR_CFG__;
if (window.__asarInjected) return;
window.__asarInjected = true;

const open = () => DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', 'o');

// Globals for mods that want to detect us
window.asar = { version: cfg.version, open };
window.openasar = window.openasar ?? {};

// --- Debug recorder core (the recorder itself is at the end of this file) ---
// D() records one event while a recording is on (asar settings > Debug) and does nothing otherwise.
const dbg = { on: false, q: [], salt: 1, dropped: 0, off: [], flux: new Map(), errs: new Map(), net: {}, memN: 0 };
const epoch = () => Math.round(performance.timeOrigin + performance.now());
const D = (k, f) => {
  if (!dbg.on) return;
  if (dbg.q.length >= 4000) { dbg.q.shift(); dbg.dropped++; }
  dbg.q.push({ t: epoch(), k, ...f });
};
// Server/channel IDs -> short codes salted per recording: the same channel gets the same code within one log, and the
// code can't be turned back into the ID
const anon = (id, p = 'c') => {
  if (id == null || id === '') return undefined;
  if (id === '@me') return 'DMs';
  let x = 0x811c9dc5 ^ dbg.salt;
  for (const ch of String(id)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return p + ':' + (x >>> 0).toString(16).padStart(8, '0').slice(0, 6);
};
// A web address -> what kind of request it is, plus its path with IDs, hashes and file names removed
const redactUrl = s => {
  let u;
  try { u = new URL(String(s), location.href); } catch { return { kind: 'unknown', path: '?' }; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return { kind: 'local', path: u.protocol };
  const h = u.host;
  let kind;
  if (h === 'cdn.discordapp.com') kind = 'cdn';
  else if (/(^|\.)discord(app)?\.com$/.test(h)) kind = u.pathname.startsWith('/api/') ? 'api' : u.pathname.startsWith('/assets/') ? 'app code' : 'discord';
  else if (h === 'media.discordapp.net') kind = 'media';
  else if (/^images-ext-\d+\.discordapp\.net$/.test(h)) return { kind: 'link previews', path: h + '/external/…' };
  else if (/\.discord\.media$/.test(h)) return { kind: 'voice', path: 'voice server' };
  else if (/(^|\.)discord\.gg$/.test(h)) kind = 'gateway';
  else if (/(^|\.)discordapp\.net$/.test(h)) kind = 'discord';
  else return { kind: 'other sites', path: 'other site' };
  if (u.pathname.includes('/external/')) return { kind, path: h + '/external/…' };
  let prev = '';
  const path = u.pathname.split('/').map(seg => {
    const p = prev;
    prev = seg;
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (/^(invites?|templates?|gifts?|gift-codes|guild-template)$/.test(p)) return ':x'; // invite/gift codes
    if (seg === '@me' || /^v\d{1,2}$/.test(seg) || /^[a-z][a-z_-]{0,23}$/.test(seg)) return seg;
    const ext = /\.([a-z0-9]{2,5})$/i.exec(seg)?.[1];
    if (ext) return kind === 'app code' ? seg.slice(0, 60) : '*.' + ext.toLowerCase();
    return ':x';
  }).join('/');
  return { kind, path: h + path };
};
// Free text (error messages) with anything personal taken out
const scrub = s => String(s ?? '').slice(0, 500)
  .replace(/\b(?:https?|wss?|file):\/\/[^\s'"`)]+/g, m => redactUrl(m).path)
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
  .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{25,})\b/g, '<token>')
  .replace(/\b\d{15,21}\b/g, '<id>')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
  .replace(/(["'`])([^"'`\n]{40,})\1/g, '$1…$1')
  .slice(0, 300);
// Whose code a script is (for "is it asar, Discord, or another mod")
const ownerOf = url => {
  const u = String(url || '');
  if (!u) return 'unknown';
  if (u.includes('asar-injected')) return 'asar';
  if (u.includes('asar-custom')) return 'your custom JS';
  if (/betterdiscord|bdapi|\.plugin\.js/i.test(u)) return 'BetterDiscord';
  if (/vencord|equicord/i.test(u)) return 'Vencord';
  if (/replugged|powercord|shelter|goosemod|kernel/i.test(u)) return 'other mod';
  if (/^https:\/\/([\w-]+\.)?discord(app)?\.com\//.test(u)) return 'Discord';
  return 'other';
};
const scriptName = url => {
  const u = String(url || '');
  if (!u) return '(no file)';
  const o = ownerOf(u);
  if (o === 'other') return redactUrl(u).path;
  return u.split(/[\\/]/).pop().split('?')[0].slice(0, 60);
};

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
const fail = (where, e) => { diag.error = where + ': ' + (e?.message ?? e); D('error', { who: 'asar', msg: scrub(diag.error), at: 'asar (' + where + ')' }); report(); };

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
    const t0 = performance.now();
    const r = perfMods.actions.fetchMessages({ channelId: cid, limit: 50 });
    if (dbg.on) {
      const done = failed => D('preload', { c: anon(cid), ty: chType(cid), why: kind, ms: Math.round(performance.now() - t0), failed: failed || undefined });
      if (r?.then) r.then(() => done(false), () => done(true)); else done(false);
    }
    if (r?.catch) r.catch(() => { diag.prefetch.failed++; });
  } catch { diag.prefetch.failed++; D('preload', { c: anon(cid), why: kind, failed: true }); }
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

// Where the messages are drawn: Discord's chat <main> (message list + message box).
const realChatBox = () => {
  const list = document.querySelector('ol[data-list-id="chat-messages"]');
  const box = list?.closest('main') ?? document.querySelector('main[class*="chatContent"]') ?? document.querySelector('[class*="chatContent"]');
  const b = box?.getBoundingClientRect();
  return b && b.width > 200 && b.height > 150 ? b : null;
};

// No chat on screen yet (Friends page, Discover, the first chat after Discord starts): estimate where it will be.
// 1.9 guessed "top of the channel list + 48 px", which lands too low when the list starts below a search bar.
// Now: the last real chat box if the window is the same size, else the page right of the channel list (found by
// walking up from the element under it) minus that page's header bar.
let lastBox = null, lastLink = null;
const guessBox = () => {
  if (lastBox && lastBox.w === innerWidth && lastBox.h === innerHeight) return lastBox.r;
  const nav = (lastLink?.isConnected ? lastLink : document.querySelector('a[href^="/channels/"]'))?.closest('nav')?.getBoundingClientRect();
  if (!nav || nav.right >= innerWidth - 200) return null;
  const x = Math.min(innerWidth - 2, Math.round(nav.right + 24));
  let page = null;
  for (let el = document.elementFromPoint(x, Math.round(innerHeight / 2)), i = 0; el && el !== document.body && i < 30; el = el.parentElement, i++) {
    const r = el.getBoundingClientRect();
    if (Math.abs(r.left - nav.right) <= 3 && r.width > 200 && r.height > 150) page = r;
    else if (page) break;
  }
  if (!page) page = { left: nav.right, top: nav.top, width: innerWidth - nav.right, height: innerHeight - nav.top };
  // The page's header: the widest short element sitting on the page's top edge
  let head = 0;
  for (let el = document.elementFromPoint(x, Math.round(page.top + 3)), i = 0; el && el !== document.body && i < 30; el = el.parentElement, i++) {
    const r = el.getBoundingClientRect();
    if (r.height >= 100 || r.left < page.left - 3) break;
    if (Math.abs(r.top - page.top) <= 3 && r.width >= page.width * 0.5) head = Math.max(head, r.height);
  }
  if (head < 24) head = 48;
  return { left: page.left, top: page.top + head, width: page.width, height: page.height - head };
};
const chatRect = () => {
  const real = realChatBox();
  if (real) {
    lastBox = { w: innerWidth, h: innerHeight, r: { left: real.left, top: real.top, width: real.width, height: real.height } };
    return { b: real, real: true };
  }
  const g = guessBox();
  return g && { b: g, real: false };
};

// The loading screen and progress line follow Discord's chat box while they're up: re-measured every 100 ms, so if
// Discord creates or moves the chat box (first chat, DM with a profile panel), they snap onto it.
let placed = '', placedReal = false, barOn = false, trackT = 0;
const px = b => [ b.left, b.top, b.width, b.height ].map(Math.round);
const placeLoad = () => {
  const r = loadEl && chatRect();
  if (!r) return false;
  const [ l, t, w, h ] = px(r.b), key = l + ',' + t + ',' + w + ',' + h;
  if (key !== placed) {
    if (placed && loadFor && loadFor !== 'settings') D('loader', { ev: r.real && !placedReal ? 'snapped onto chat' : 'moved', to: key, from: placed });
    Object.assign(loadEl.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
    placed = key;
  }
  placedReal = r.real;
  return true;
};
const retrack = fast => {
  if (trackT > 0) clearTimeout(trackT); else if (trackT < 0) cancelAnimationFrame(-trackT);
  trackT = fast ? -requestAnimationFrame(track) : setTimeout(track, 100);
};
const track = () => { // every frame while the position is only an estimate, then every 100 ms
  trackT = 0;
  const loading = loadFor && loadFor !== 'settings';
  if (!loading && !barOn) return;
  if (loading) placeLoad();
  if (barOn) placeBar();
  trackT = loading && !placedReal ? -requestAnimationFrame(track) : setTimeout(track, 100);
};
const showLoad = (cid, now = false) => {
  if (loadFor === cid && loadEl?.classList.contains('on')) return;
  buildLoad(cid);
  placed = '';
  if (!placeLoad()) return;
  loadFor = cid;
  D('loader', { ev: 'shown', c: anon(cid), at: placedReal ? 'chat box' : 'estimated', box: placed });
  retrack(!placedReal);
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
  barOn = true;
  barEl.style.display = 'block';
  if (!placeBar()) { barEl.style.display = 'none'; barOn = false; return; }
  if (!trackT) retrack(false);
};
let barKey = '';
const placeBar = () => {
  const r = chatRect();
  if (!r) return false;
  const [ l, t, w ] = px(r.b), key = l + ',' + t + ',' + w;
  if (key !== barKey) { Object.assign(barEl.style, { left: l + 'px', top: t + 'px', width: w + 'px' }); barKey = key; }
  return true;
};
const hideBar = () => { barOn = false; if (barEl) barEl.style.display = 'none'; };

const hideLoad = () => {
  if (loadFor && loadFor !== 'settings' && loadEl?.classList.contains('on')) D('loader', { ev: 'hidden' });
  loadFor = null;
  loadEl?.classList.remove('on');
  hideBar();
};
addEventListener('resize', () => { if (loadFor && loadFor !== 'settings') placeLoad(); if (barOn) placeBar(); }, { passive: true });

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
const frameCost = (t0, t1 = Infinity) => {
  let js = 0, draw = 0;
  for (const f of loafs) if (f.end >= t0 && f.start <= t1) { js += f.script; draw += f.draw; }
  return js || draw ? { js: Math.round(js), draw: Math.round(draw) } : {};
};

// --- Navigation tracking (channel switch timing + loading screen) ---
// Any way of opening a channel counts: channel/thread links, DMs, server icons, jump links.
diag.switches = [];
let navId = 0;
const cidFromPath = p => /^\/channels\/(?:@me|\d+)\/(\d+)/.exec(p)?.[1];
const chType = cid => {
  try {
    const t = perfMods.channels?.getChannel?.(cid)?.type;
    return { 0: 'text channel', 1: 'DM', 3: 'group DM', 5: 'announcements', 10: 'thread', 11: 'thread', 12: 'private thread', 15: 'forum', 16: 'media channel', 2: 'voice channel', 13: 'stage' }[t] ?? (t == null ? undefined : 'type ' + t);
  } catch { }
};
const startNav = (cid, warm, how = 'click') => {
  const id = ++navId;
  hideLoad();
  const t0 = performance.now(), stored = inStore(cid), merged = mergedClicks;
  mergedClicks = 0;
  const showAt = setTimeout(() => { if (id === navId && cfg.loader && !isReady(cid) && !inStore(cid)) showLoad(cid); }, 120);
  const poll = () => {
    if (id !== navId) return clearTimeout(showAt); // another navigation took over
    const ms = performance.now() - t0;
    if (isReady(cid)) {
      clearTimeout(showAt);
      const loader = loadFor === cid, t1 = performance.now();
      // let the first frame of messages paint before fading out; Discord's own selection is in place by now
      requestAnimationFrame(() => requestAnimationFrame(() => { if (id === navId) { hideLoad(); clearSelection(); } }));
      const msgs = dbg.on ? document.querySelectorAll('li[id^="chat-messages-' + cid + '-"]').length : 0;
      // Chromium reports frame timings a moment after the frame: read the cost once they're in
      setTimeout(() => {
        const cost = frameCost(t0, t1 + 50);
        diag.switches.push({ ms: Math.round(ms), warm, ...cost });
        if (diag.switches.length > 30) diag.switches.shift();
        D('switch', { c: anon(cid), ty: chType(cid), ms: Math.round(ms), warm, stored, ...cost, loader, how, merged: merged || undefined, msgs: msgs || undefined, t: Math.round(performance.timeOrigin + t0) });
        report();
      }, 300);
      return;
    }
    if (ms < 8000) setTimeout(poll, 40);
    else { // never leave anything up
      D('switch', { c: anon(cid), ty: chType(cid), ms: Math.round(ms), warm, stored, timeout: true, how, t: Math.round(performance.timeOrigin + t0) });
      hideLoad(); clearSelection();
    }
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
    lastLink = a;
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
    if (c && c !== cidFromPath(before)) startNav(c, prefetched.has(c), 'other click');
  }, t);
}, { capture: true, passive: true });
addEventListener('keydown', e => { if (e.key === 'Escape') hideLoad(); }, { capture: true, passive: true });

// --- Instant switching ---
// Discord builds a channel's whole view in one go, and nothing else (not your next click, not the loading screen)
// runs until it's done. So asar takes channel clicks first: it highlights the channel and shows the loading screen
// (or the progress line if Discord already has the messages), lets that reach the screen (one frame), then hands
// the click to Discord. If you click again before that, only the newest click is handed on, so Discord never builds
// channels you've already left. While you're switching quickly, asar waits a little longer to collect clicks.
let pending = null, lastSwitchClick = 0, mergedClicks = 0;
const cancelPending = () => {
  if (!pending) return;
  cancelAnimationFrame(pending.raf);
  clearTimeout(pending.timer);
  pending = null;
  mergedClicks++; // a click that never reached Discord because a newer one replaced it
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
  lastLink = a;
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
      D('mem-trim', { freedMB: Math.round(freed), heapMB: Math.round(heapMB()) });
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
let settingsT0 = 0, settingsT0Used = false;
const settingsBuilt = () => {
  const t0 = settingsT0 || (performance.now() - lastInputAt < 3000 ? lastInputAt : 0);
  settingsT0Used = !!settingsT0;
  settingsT0 = 0;
  if (!t0) return;
  const poll = () => {
    const ms = performance.now() - t0;
    if (document.querySelector('[data-asar-icon]')) {
      hideSettingsLoad();
      diag.settingsOpen.push({ ms: Math.round(ms), first: diag.settingsOpen.length === 0 });
      D('settings', { ms: Math.round(ms), first: diag.settingsOpen.length === 1, instant: !!settingsT0Used, t: Math.round(performance.timeOrigin + t0) });
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
    if (i >= list.length || typeof r.e !== 'function') { D('settings-prep', diag.settingsWarm); return report(); }
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

// --- asar update popup ---
// When asar has downloaded a new build (checked by asar's main process, nothing polls in this page), a popup asks to
// restart now or later. "Later" tucks it into a small pill in Discord's top bar, left of Discord's own icons, measured
// so it never covers anything clickable; the pill brings the popup back. Animations use transform and opacity only.
const UPD_CSS = `
#asar-upd{position:fixed;inset:0;z-index:2147483645;display:grid;place-items:center;-webkit-app-region:no-drag;font-family:var(--font-primary,"gg sans",system-ui,sans-serif)}
#asar-upd .scrim{position:absolute;inset:0;background:rgb(0 0 0 / .34);-webkit-backdrop-filter:blur(5px)!important;backdrop-filter:blur(5px)!important;opacity:0;transition:opacity .22s ease}
#asar-upd.on .scrim{opacity:1}
#asar-upd .card{position:relative;box-sizing:border-box;width:min(400px,calc(100vw - 32px));border-radius:16px;padding:22px 22px 18px;
 background:var(--modal-background,var(--background-surface-high,var(--background-base-lower,#2b2d31)));color:var(--text-default,var(--text-normal,#dbdee1));
 border:1px solid var(--border-subtle,rgb(255 255 255 / .07));box-shadow:0 24px 64px rgb(0 0 0 / .45),0 2px 10px rgb(0 0 0 / .22);
 opacity:0;transform:translateY(10px) scale(.97);transition:opacity .2s ease,transform .26s cubic-bezier(.2,.9,.3,1.1);will-change:transform,opacity}
#asar-upd.on .card{opacity:1;transform:none}
#asar-upd.away{pointer-events:none}
#asar-upd.away .card{transition:opacity .3s ease,transform .34s cubic-bezier(.5,0,.2,1)}
#asar-upd .top{display:flex;gap:14px;align-items:center;margin-bottom:14px}
#asar-upd .ic{position:relative;width:46px;height:46px;flex:none;border-radius:13px;display:grid;place-items:center;color:var(--brand-500,#5865f2);background:color-mix(in srgb,var(--brand-500,#5865f2) 17%,transparent)}
#asar-upd .ic svg{width:28px;height:28px}
#asar-upd .ic b{position:absolute;right:-5px;bottom:-5px;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--status-positive,#23a55a);
 box-shadow:0 0 0 3px var(--modal-background,var(--background-surface-high,#2b2d31))}
#asar-upd .ic b svg,#asar-pill svg{width:13px;height:13px;fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
#asar-upd h2{margin:0;font-size:18px;line-height:23px;font-weight:700;color:var(--text-strong,var(--header-primary,#f2f3f5))}
#asar-upd .ver{margin-top:2px;font-size:13px;color:var(--text-muted,#949ba4);font-variant-numeric:tabular-nums}
#asar-upd .ver b{font-weight:600;color:var(--status-positive,#23a55a)}
#asar-upd .new{margin:0 0 14px;padding:11px 14px;border-radius:10px;background:var(--background-base-lowest,rgb(0 0 0 / .16))}
#asar-upd .new h3{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted,#949ba4)}
#asar-upd ul{margin:0;padding:0 0 0 17px;display:grid;gap:4px;font-size:13.5px;line-height:1.4}
#asar-upd .note{margin:0 0 16px;font-size:12px;line-height:1.4;color:var(--text-muted,#949ba4)}
#asar-upd .btns{display:flex;justify-content:flex-end;gap:8px}
#asar-upd button{font:inherit;font-size:14px;font-weight:600;border:0;border-radius:8px;padding:0 16px;height:38px;cursor:pointer;color:var(--text-strong,#f2f3f5);
 background:var(--button-secondary-background,rgb(255 255 255 / .08));transition:filter .12s ease}
#asar-upd button:hover{filter:brightness(1.18)}
#asar-upd button.go{min-width:132px;color:#fff;background:var(--brand-500,#5865f2)}
#asar-upd button:disabled{cursor:default;filter:none}
#asar-upd button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
#asar-upd .sp{display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:-1px;border-radius:50%;border:2px solid rgb(255 255 255 / .35);border-top-color:#fff;will-change:transform;animation:asar-uspin .7s linear infinite}
@keyframes asar-uspin{to{transform:rotate(360deg)}}
#asar-pill{position:fixed;z-index:2147483644;box-sizing:border-box;height:24px;display:flex;align-items:center;gap:5px;padding:0 10px 0 7px;margin:0;border:0;border-radius:12px;cursor:pointer;
 font:600 12px/1 var(--font-primary,"gg sans",system-ui,sans-serif);color:#fff;background:var(--status-positive,#23a55a);box-shadow:0 1px 4px rgb(0 0 0 / .25);
 -webkit-app-region:no-drag;opacity:0;transform:scale(.5);transition:opacity .18s ease,transform .24s cubic-bezier(.2,.9,.3,1.35),filter .12s ease;will-change:transform}
#asar-pill.on{opacity:1;transform:none}
#asar-pill:hover{filter:brightness(1.1)}
#asar-pill:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}`;
const ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3.5 13.5h9"/></svg>';
const LAYERS = '<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path opacity=".4" d="M32 26 56 38 32 50 8 38Z"/><path opacity=".7" d="M32 17 56 29 32 41 8 29Z"/><path d="M32 8 56 20 32 32 8 20Z"/></svg>';
const short = v => String(v ?? '').replace(/-[0-9a-f]{7}$/, '');

let upd = null, pill = null, pillT = 0, updKeys = null;
const ipcUpd = what => { try { DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', { asarUpd: what }); } catch { } };

// Where the pill goes: in Discord's top bar, just left of the icons on its right (inbox, help, window buttons).
// Every spot is checked so the pill never covers anything clickable; fallbacks: top centre, then bottom right.
const CLICKABLE = 'button,a,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="switch"],[contenteditable="true"]';
const clickableAt = (x, y) => {
  const el = document.elementFromPoint(x, y);
  return !!el && !el.closest('#asar-pill,#asar-upd') && !!el.closest(CLICKABLE);
};
const viewW = () => document.documentElement.clientWidth || innerWidth; // without a scrollbar, if any
const freeSpot = (x, y, w, h) => x >= 0 && y >= 0 && x + w <= viewW() && y + h <= innerHeight &&
  ![ [ 2, 2 ], [ w / 2, h / 2 ], [ w - 2, 2 ], [ 2, h - 2 ], [ w - 2, h - 2 ] ].some(([ dx, dy ]) => clickableAt(x + dx, y + dy));
const dockSpot = (w, h) => {
  let bar = null;
  const vw = viewW();
  for (let el = document.elementFromPoint(vw / 2, 3), i = 0; el && el !== document.body && i < 25; el = el.parentElement, i++) {
    const r = el.getBoundingClientRect();
    if (r.top <= 1 && r.left <= 1 && r.width >= vw - 2 && r.height >= 20 && r.height <= 72) { bar = r; break; }
  }
  if (bar) {
    const cy = bar.top + bar.height / 2;
    let left = bar.right, gap = 0;
    for (let x = bar.right - 3; x > bar.left + bar.width * 0.4; x -= 6) {
      const el = document.elementFromPoint(x, cy)?.closest?.(CLICKABLE);
      if (el && !el.closest('#asar-pill')) { left = Math.min(left, el.getBoundingClientRect().left); x = Math.min(x, left); gap = 0; }
      else if (left < bar.right && (gap += 6) > 40) break;
    }
    const x = Math.round(left - 12 - w), y = Math.round(cy - h / 2);
    if (freeSpot(x, y, w, h)) return { x, y, where: 'top bar' };
  }
  const tops = [ [ Math.round(vw / 2 - w / 2), 8, 'top centre' ], [ vw - w - 20, innerHeight - h - 84, 'bottom right' ] ];
  for (const [ x, y, where ] of tops) if (freeSpot(x, y, w, h)) return { x, y, where };
  return { x: vw - w - 20, y: innerHeight - h - 84, where: 'bottom right (forced)' };
};
const placePill = () => {
  if (!pill?.isConnected) return;
  // Measured with asar's own elements out of the way (hit tests skip pointer-events:none), at the pill's real size
  pill.style.pointerEvents = 'none';
  const s = dockSpot(pill.offsetWidth || 84, pill.offsetHeight || 24);
  pill.style.pointerEvents = '';
  Object.assign(pill.style, { left: s.x + 'px', top: s.y + 'px' });
  return s;
};
let pillResize = 0;
addEventListener('resize', () => { clearTimeout(pillResize); pillResize = setTimeout(placePill, 150); }, { passive: true });

const showPill = (animateIn = true) => {
  if (!document.getElementById('asar-upd-css')) addStyle('asar-upd-css', UPD_CSS);
  if (!pill?.isConnected) {
    pill = document.createElement('button');
    pill.id = 'asar-pill';
    pill.type = 'button';
    pill.innerHTML = ARROW + '<span>Update</span>';
    pill.onclick = () => openUpd(upd);
    document.body.appendChild(pill);
  }
  pill.title = `asar ${short(upd?.version)} is ready. Click to restart or see what's new.`;
  pill.setAttribute('aria-label', pill.title);
  const s = placePill();
  D('update', { ev: 'pill', at: s?.where });
  if (animateIn) requestAnimationFrame(() => pill?.classList.add('on'));
  clearInterval(pillT);
  pillT = setInterval(() => { if (!document.hidden) placePill(); }, 8000); // Discord's layout can change (window size, full screen)
  return s;
};
const hidePill = () => { clearInterval(pillT); pill?.remove(); pill = null; };

const closeKeys = () => { if (updKeys) removeEventListener('keydown', updKeys, true); updKeys = null; };
const openUpd = st => {
  if (!st || st.status !== 'ready') return;
  if (!document.getElementById('asar-upd-css')) addStyle('asar-upd-css', UPD_CSS);
  hidePill();
  document.getElementById('asar-upd')?.remove();
  const m = document.createElement('div');
  m.id = 'asar-upd';
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  m.setAttribute('aria-labelledby', 'asar-upd-title');
  m.innerHTML = `<div class="scrim"></div><div class="card"><div class="top"><div class="ic">${LAYERS}<b>${ARROW}</b></div><div><h2 id="asar-upd-title">asar update ready</h2><div class="ver"></div></div></div>` +
    `<div class="new"><h3>What's new</h3><ul></ul></div><p class="note">Restarting takes a few seconds. Calls and streams will disconnect.</p>` +
    `<div class="btns"><button type="button" class="later">Later</button><button type="button" class="go">Restart now</button></div></div>`;
  const ver = m.querySelector('.ver'), nb = document.createElement('b');
  nb.textContent = short(st.version) || 'new version';
  ver.append(`${short(st.current)}  →  `, nb);
  const ul = m.querySelector('ul');
  for (const n of (st.notes ?? []).slice(0, 5)) { const li = document.createElement('li'); li.textContent = n; ul.append(li); }
  if (!ul.childElementCount) m.querySelector('.new').remove();
  m.querySelector('.later').onclick = later;
  m.querySelector('.scrim').onclick = later;
  m.querySelector('.go').onclick = restart;
  document.body.appendChild(m);
  requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('on')));
  m.querySelector('.go').focus({ preventScroll: true });
  // While it's open, keys belong to the popup (Escape = Later), not to Discord's shortcuts
  closeKeys();
  updKeys = e => {
    if (!document.getElementById('asar-upd')) return closeKeys();
    if (e.key === 'Escape') { e.preventDefault(); later(); }
    if (e.key === 'Tab') { e.preventDefault(); const b = [ ...m.querySelectorAll('button:not(:disabled)') ]; b[(b.indexOf(document.activeElement) + 1) % b.length]?.focus(); }
    e.stopPropagation();
  };
  addEventListener('keydown', updKeys, true);
  D('update', { ev: 'popup', version: short(st.version) });
};

// "Later": the card shrinks into the pill
const later = () => {
  const m = document.getElementById('asar-upd');
  if (!m || m.classList.contains('away')) return;
  closeKeys();
  ipcUpd('later');
  if (upd) upd.dismissed = true;
  const card = m.querySelector('.card').getBoundingClientRect();
  m.classList.add('away'); // out of the way of the pill's placement
  showPill(false);
  const p = pill.getBoundingClientRect();
  const dx = p.left + p.width / 2 - (card.left + card.width / 2), dy = p.top + p.height / 2 - (card.top + card.height / 2);
  m.classList.add('away');
  m.classList.remove('on');
  m.querySelector('.card').style.transform = `translate(${dx}px,${dy}px) scale(${Math.max(0.05, p.width / card.width)})`;
  setTimeout(() => { m.remove(); pill?.classList.add('on'); }, 300);
  D('update', { ev: 'later' });
};

const restart = () => {
  const m = document.getElementById('asar-upd');
  if (!m) return;
  for (const b of m.querySelectorAll('button')) b.disabled = true;
  m.querySelector('.go').innerHTML = '<span class="sp"></span>Restarting…';
  D('update', { ev: 'restart' });
  dbgFlush();
  setTimeout(() => ipcUpd('restart'), 60); // let "Restarting…" reach the screen first
};

// From asar's main process: a build is ready (popup, or the pill if you said "later" before), or nothing is pending
const onUpd = st => {
  upd = st;
  if (!st || st.status !== 'ready') { document.getElementById('asar-upd')?.remove(); closeKeys(); hidePill(); return; }
  if (st.dismissed) { if (!document.getElementById('asar-upd')) showPill(); }
  else openUpd(st);
};
Object.defineProperty(window, '__asarUpd', { configurable: true, value: st => { try { onUpd(st); } catch (e) { fail('update popup', e); } } });
if (cfg.update?.status === 'ready') setTimeout(() => window.__asarUpd(cfg.update), 3000); // after Discord has settled

// --- Debug recorder (asar settings > Debug) ---
// Installed only while a recording is on and removed when it stops. Page events go to asar's main process in one
// message every 2 s. Only timings, counts and kinds of things are recorded: no names, messages, links or account
// details are read, IDs are replaced by anon() codes and error texts go through scrub().
const routeKind = () => {
  const p = location.pathname;
  if (p === '/channels/@me') return 'Friends / DM home';
  if (/^\/channels\/@me\/\d+/.test(p)) return 'DM';
  if (/^\/channels\/\d+\/\d+\/threads\//.test(p)) return 'thread';
  if (/^\/channels\/\d+\/\d+/.test(p)) return 'server channel';
  if (/^\/channels\/\d+/.test(p)) return 'server';
  return (/^\/([a-z-]{2,24})/.exec(p)?.[1] ?? 'other') + ' page';
};
const MODS = [ [ 'BetterDiscord', 'BdApi' ], [ 'Vencord', 'Vencord' ], [ 'Equicord', 'Equicord' ], [ 'Replugged', 'replugged' ], [ 'Powercord', 'powercord' ], [ 'shelter', 'shelter' ], [ 'GooseMod', 'goosemod' ], [ 'Kernel', 'kernel' ] ];
const modsOnPage = () => MODS.filter(([ , g ]) => { try { return window[g] != null; } catch { return false; } }).map(([ n ]) => n);
const netinfo = () => {
  const c = navigator.connection;
  return c ? { type: c.effectiveType, rtt: c.rtt, mbps: c.downlink, saveData: c.saveData || undefined } : undefined;
};
const heapMB = () => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined;

// Finds module exports by shape (Discord's action dispatcher, server store), in small slices of idle time so starting a
// recording never stutters even with Discord's ~30k modules
const idle = fn => (window.requestIdleCallback ?? setTimeout)(fn, { timeout: 1000 });
const scanFor = (tests, done) => {
  const c = getReq()?.c, names = Object.keys(tests), found = {};
  if (!c || !names.length) return done(found);
  const ids = Object.keys(c);
  let i = 0;
  const step = dl => {
    const end = performance.now() + Math.max(4, Math.min(10, dl?.timeRemaining?.() ?? 8));
    for (; i < ids.length && performance.now() < end; i++) {
      const ex = c[ids[i]]?.exports;
      if (ex == null || (typeof ex !== 'object' && typeof ex !== 'function')) continue;
      for (const n of names) {
        if (found[n]) continue;
        try {
          if (tests[n](ex)) { found[n] = ex; continue; }
          for (const k of Object.keys(ex)) { const v = ex[k]; if (v && (typeof v === 'object' || typeof v === 'function') && tests[n](v)) { found[n] = v; break; } }
        } catch { }
      }
      if (names.every(n => found[n])) { i = ids.length; break; }
    }
    if (i < ids.length) idle(step); else done(found);
  };
  idle(step);
};
const isDispatcher = v => typeof v.dispatch === 'function' && typeof v.subscribe === 'function' && typeof v.unsubscribe === 'function' &&
  (typeof v.isDispatching === 'function' || typeof v.addInterceptor === 'function' || '_actionHandlers' in v);
const isGuildStore = v => v._dispatchToken !== undefined && typeof v.getName === 'function' && v.getName() === 'GuildStore';

// Discord's actions (gateway, voice, streams, message loading): each one's count and time, and details for the ones
// that explain problems. The wrapper is installed once and costs one check per action while not recording.
const loadT = new Map();
const since = id => { const t = loadT.get(id); loadT.delete(id); return t ? Math.round(performance.now() - t) : undefined; };
const nums = o => {
  if (!o || typeof o !== 'object') return {};
  const r = {};
  for (const k of Object.keys(o).slice(0, 12)) if (typeof o[k] === 'number' || typeof o[k] === 'boolean') r[k] = o[k];
  return r;
};
const FLUX = {
  CONNECTION_OPEN: () => ({}),
  CONNECTION_RESUMED: () => ({}),
  CONNECTION_INTERRUPTED: () => ({}),
  CONNECTION_CLOSED: a => ({ code: a.code }),
  RTC_CONNECTION_STATE: a => ({ state: String(a.state ?? '').slice(0, 30), ctx: String(a.context ?? '').slice(0, 20) || undefined }),
  VOICE_CHANNEL_SELECT: a => ({ joined: !!a.channelId }),
  STREAM_CREATE: () => ({}), STREAM_START: () => ({}), STREAM_STOP: () => ({}), STREAM_DELETE: () => ({}), STREAM_WATCH: () => ({}), STREAM_CLOSE: () => ({}),
  MEDIA_ENGINE_SET_GO_LIVE_SOURCE: a => nums(a.settings?.qualityOptions),
  CHANNEL_SELECT: a => ({ server: a.guildId ? anon(a.guildId, 's') : 'DMs', c: anon(a.channelId) }),
  LOAD_MESSAGES: a => { loadT.set(a.channelId, performance.now()); return { c: anon(a.channelId) }; },
  LOAD_MESSAGES_SUCCESS: a => ({ c: anon(a.channelId), msgs: Array.isArray(a.messages) ? a.messages.length : undefined, fetch: since(a.channelId) }),
  LOAD_MESSAGES_FAILURE: a => ({ c: anon(a.channelId), fetch: since(a.channelId) })
};
let fluxHooked = false;
const hookFlux = () => {
  if (fluxHooked) return true;
  const Dp = perfMods.dispatcher;
  if (!Dp) return false;
  const orig = Dp.dispatch;
  const w = function (a) {
    if (!dbg.on) return orig.apply(this, arguments);
    const t = performance.now();
    try { return orig.apply(this, arguments); }
    finally {
      try {
        const ms = performance.now() - t, type = /^[A-Z0-9_]{2,64}$/.test(a?.type) ? a.type : 'OTHER';
        const s = dbg.flux.get(type);
        if (s) { s[0]++; s[1] += ms; if (ms > s[2]) s[2] = ms; } else dbg.flux.set(type, [ 1, ms, ms ]);
        const f = FLUX[type];
        if (f || ms >= 50) D(f ? 'flux' : 'flux-slow', { type, ms: ms >= 5 ? Math.round(ms) : undefined, ...(f ? f(a) : {}) });
      } catch { }
    }
  };
  try { Dp.dispatch = w; } catch { }
  if (Dp.dispatch !== w) try { Object.defineProperty(Dp, 'dispatch', { value: w, writable: true, configurable: true }); } catch { }
  return fluxHooked = Dp.dispatch === w;
};

const errSeen = (msg, src, line) => {
  const m = scrub(msg), who = ownerOf(src);
  const key = who + ' | ' + m;
  const n = (dbg.errs.get(key) ?? 0) + 1;
  if (dbg.errs.size < 300 || dbg.errs.has(key)) dbg.errs.set(key, n);
  if (n <= 3) D('error', { msg: m, who, at: scriptName(src) + (line ? ':' + line : ''), times: n > 1 ? n : undefined });
};
const stackSrc = st => /\((\S+?):(\d+):\d+\)|at (\S+?):(\d+):\d+/.exec(String(st ?? '').split('\n').slice(1, 3).join('\n')) ?? [];

const targetKind = el => {
  try {
    if (!el?.closest) return el?.nodeName?.toLowerCase?.() ?? 'gone';
    if (el.closest('a[href^="/channels/"]')) return 'channel link';
    if (el.closest('[data-list-item-id^="guildsnav"], [data-list-id="guildsnav"]')) return 'server list';
    if (el.closest('[role="textbox"], textarea, input')) return 'text box';
    if (el.closest('[data-list-id="chat-messages"]')) return 'messages';
    if (el.closest('[role="dialog"]')) return 'popup';
    if (el.closest('nav, [class*="sidebar"]')) return 'sidebar';
    if (el.closest('button, [role="button"]')) return 'button';
    return el.nodeName.toLowerCase();
  } catch { return '?'; }
};

const dbgStats = () => ({
  flux: [ ...dbg.flux ].sort((a, b) => b[1][1] - a[1][1]).slice(0, 60).map(([ k, [ n, ms, max ] ]) => [ k, n, Math.round(ms), Math.round(max) ]),
  errs: [ ...dbg.errs ].sort((a, b) => b[1] - a[1]).slice(0, 80),
  net: Object.fromEntries(Object.entries(dbg.net).map(([ k, v ]) => [ k, { n: v.n, mb: Math.round(v.kb / 102.4) / 10, avgMs: Math.round(v.ms / v.n), slow: v.slow, failed: v.err, r429: v.r429, cached: v.cached } ])),
  dropped: dbg.dropped,
  heap: heapMB(),
  dom: document.getElementsByTagName('*').length
});

const dbgFlush = () => {
  if (!dbg.q.length) return;
  try { DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', { asarDbg: dbg.q.splice(0) }); } catch { }
};

const dbgStart = salt => {
  if (dbg.on) return;
  Object.assign(dbg, { on: true, q: [], salt: salt | 0 || 1, dropped: 0, flux: new Map(), errs: new Map(), net: {}, memN: 0 });
  const offs = dbg.off = [];
  const obs = (type, fn, opts) => {
    try {
      const o = new PerformanceObserver(l => { if (dbg.on) for (const e of l.getEntries()) try { fn(e); } catch { } });
      o.observe({ type, buffered: false, ...opts });
      offs.push(() => o.disconnect());
    } catch { }
  };
  const on = (tgt, ev, fn, o) => { tgt.addEventListener(ev, fn, o); offs.push(() => tgt.removeEventListener(ev, fn, o)); };
  const every = (fn, ms) => { const t = setInterval(fn, ms); offs.push(() => clearInterval(t)); };
  const r = n => Math.round(n);

  // Slow frames (150 ms+): how long, and whose code ran (Discord, asar, a mod) vs drawing
  obs('long-animation-frame', e => {
    if (e.duration < 150) return;
    const own = {};
    let js = 0;
    for (const s of e.scripts ?? []) { const o = ownerOf(s.sourceURL); own[o] = (own[o] ?? 0) + s.duration; js += s.duration; }
    const draw = e.styleAndLayoutStart > 0 ? e.startTime + e.duration - e.styleAndLayoutStart : 0;
    if (draw >= 1) own.drawing = draw;
    const rest = e.duration - js - draw;
    if (rest >= 5) own['not attributed'] = rest;
    for (const k in own) own[k] = r(own[k]);
    const top = [ ...(e.scripts ?? []) ].sort((a, b) => b.duration - a.duration).slice(0, 3).map(s => ({
      who: ownerOf(s.sourceURL), file: scriptName(s.sourceURL), fn: String(s.sourceFunctionName || '').slice(0, 40) || undefined,
      via: scrub(s.invoker).slice(0, 70) || undefined, ms: r(s.duration), layout: r(s.forcedStyleAndLayoutDuration ?? 0) || undefined
    }));
    D('frame', { ms: r(e.duration), blocked: r(e.blockingDuration ?? 0), own, top, t: r(performance.timeOrigin + e.startTime) });
  });

  // Slow clicks and key presses (200 ms+ until the result was on screen), one line per interaction
  const seenInput = new Set();
  obs('event', e => {
    if (e.duration < 200 || !e.interactionId || seenInput.has(e.interactionId)) return;
    seenInput.add(e.interactionId);
    if (seenInput.size > 200) seenInput.delete(seenInput.values().next().value);
    D('input', { ev: e.name, on: targetKind(e.target), ms: r(e.duration), wait: r(e.processingStart - e.startTime), run: r(e.processingEnd - e.processingStart),
      draw: r(Math.max(0, e.startTime + e.duration - e.processingEnd)), t: r(performance.timeOrigin + e.startTime) });
  }, { durationThreshold: 104 });

  // Network: totals per kind of request; each slow (1 s+) or failed request on its own
  obs('resource', e => {
    const u = redactUrl(e.name);
    const n = dbg.net[u.kind] ??= { n: 0, kb: 0, ms: 0, slow: 0, err: 0, r429: 0, cached: 0 };
    const st = e.responseStatus ?? 0;
    n.n++; n.kb += (e.transferSize || 0) / 1024; n.ms += e.duration;
    if (e.transferSize === 0 && e.decodedBodySize > 0) n.cached++;
    if (st >= 400) n.err++;
    if (st === 429) n.r429++;
    if (e.duration >= 1000) n.slow++;
    if (e.duration < 1000 && st < 400) return;
    const q = e.requestStart > 0;
    D('req', { kind: u.kind, path: u.path, ms: r(e.duration), status: st || undefined, queued: q ? r(e.requestStart - e.startTime) : undefined,
      server: q ? r(e.responseStart - e.requestStart) : undefined, download: q ? r(e.responseEnd - e.responseStart) : undefined,
      kb: r((e.transferSize || 0) / 1024), proto: e.nextHopProtocol || undefined, t: r(performance.timeOrigin + e.startTime) });
  });

  on(window, 'error', e => errSeen(e.message, e.filename, e.lineno));
  on(window, 'unhandledrejection', e => { const [ , a, b, c, d ] = stackSrc(e.reason?.stack); errSeen('Unhandled promise rejection: ' + (e.reason?.message ?? e.reason), a ?? c, b ?? d); });
  on(document, 'visibilitychange', () => D('visible', { on: !document.hidden }));
  on(window, 'online', () => D('online', { on: true }));
  on(window, 'offline', () => D('online', { on: false }));
  if (navigator.connection) on(navigator.connection, 'change', () => D('netinfo', netinfo()));

  every(dbgFlush, 2000);
  every(() => { dbg.memN++; D('mem', { heap: heapMB(), heapMax: performance.memory ? r(performance.memory.jsHeapSizeLimit / 1048576) : undefined, dom: dbg.memN % 4 === 1 ? document.getElementsByTagName('*').length : undefined }); }, 15000);
  every(() => D('stats', dbgStats()), 60000);

  // Discord's modules: looked up when idle so starting a recording never stutters
  idle(() => {
    try { findPerf(); } catch { }
    const want = {};
    if (!perfMods.dispatcher) want.dispatcher = isDispatcher;
    if (!perfMods.guilds) want.guilds = isGuildStore;
    scanFor(want, found => { Object.assign(perfMods, found); if (dbg.on) pageInfo(); });
  });
  const pageInfo = () => {
    let guilds;
    try { hookFlux(); const g = perfMods.guilds; guilds = g?.getGuildCount?.() ?? Object.keys(g?.getGuilds?.() ?? {}).length; } catch { }
    D('page', {
      ua: navigator.userAgent.slice(0, 200), release: String(window.GLOBAL_ENV?.RELEASE_CHANNEL ?? '').slice(0, 20) || undefined,
      route: routeKind(), size: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, memGB: navigator.deviceMemory,
      net: netinfo(), online: navigator.onLine, dom: document.getElementsByTagName('*').length, heap: heapMB(), guilds, mods: modsOnPage(),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, theme: /theme-\w+/.exec(document.documentElement.className)?.[0],
      found: { messages: !!perfMods.messages, channels: !!perfMods.channels, fetch: !!perfMods.actions, users: !!perfMods.users, settings: !!perfMods.router, actions: fluxHooked, servers: !!perfMods.guilds },
      tab: { added: diag.patched, builds: diag.builds, error: diag.error ?? undefined },
      speedups: Object.fromEntries([ 'prefetch', 'keepReady', 'instantSwitch', 'loader', 'warmSettings', 'memTrim', 'noBlur', 'noTrack', 'noTyping', 'domOpt', 'pure' ].map(k => [ k, !!cfg[k] ]))
    });
  };
};

const dbgStop = () => {
  dbg.on = false;
  for (const f of dbg.off.splice(0)) try { f(); } catch { }
};

// Called by asar's main process: {on, salt} starts, 'flush' hands over what's queued, false stops (returning the rest)
Object.defineProperty(window, '__asarDbg', {
  configurable: true,
  value: arg => {
    if (arg && typeof arg === 'object' && arg.on) { dbgStart(arg.salt); return true; }
    if (!dbg.on) return [];
    D('stats', dbgStats());
    const out = dbg.q.splice(0);
    if (arg === false) dbgStop();
    return out;
  }
});
if (cfg.debug) dbgStart(cfg.debug.salt);

// Startup marks for debug logs: when Discord's UI and first messages appeared (checked 5x a second, at most 2 min)
if (!window.__asarMarked) {
  window.__asarMarked = true;
  const mark = n => { try { DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', { asarMark: [ n, epoch() ] }); } catch { } };
  let ui = false, n = 0;
  const poll = () => {
    if (!ui && document.querySelector('[data-list-id="guildsnav"], a[href^="/channels/"]')) { ui = true; mark('Discord UI visible'); }
    if (ui && document.querySelector('li[id^="chat-messages-"]')) return mark('first messages visible');
    if (++n < 600) setTimeout(poll, 200);
  };
  setTimeout(poll, 0);
}

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
