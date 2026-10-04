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
// We find it through Discord's webpack module cache and add an "asar" section, the same way Vencord and
// BetterDiscord add theirs. This doesn't depend on class names or the UI language.
// Nothing runs on a timer: lookups happen a few times after load and after clicks/keypresses until patched.
let wreq, root, types, React, patched = false;
const scanned = new Set();

const getReq = () => {
  if (wreq) return wreq;
  const chunk = window.webpackChunkdiscord_app ?? window[Object.keys(window).find(k => k.startsWith('webpackChunk'))];
  if (!chunk?.push) return;
  chunk.push([ [ Symbol('asar') ], {}, r => { wreq = r; } ]);
  chunk.pop();
  return wreq;
};

const check = v => {
  if (!v || (typeof v !== 'object' && typeof v !== 'function')) return;
  if (!root && v.key === '$Root' && typeof v.buildLayout === 'function') root = v;
  else if (!types && typeof v.SIDEBAR_ITEM === 'number' && typeof v.SECTION === 'number' && typeof v.PANEL === 'number' && typeof v.CUSTOM === 'number') types = v;
  else if (!React && typeof v.createElement === 'function' && typeof v.useEffect === 'function' && typeof v.Fragment !== 'undefined') React = v;
};

const scan = () => {
  const cache = getReq()?.c;
  if (!cache) return;

  for (const id in cache) {
    if (root && types && React) return;
    if (scanned.has(id)) continue;

    const ex = cache[id]?.exports;
    if (ex == null) continue;

    try {
      check(ex);
      if (typeof ex === 'object' || typeof ex === 'function') for (const k of Object.keys(ex)) check(ex[k]);
      scanned.add(id);
    } catch { } // export not initialised yet (TDZ); look again next scan
  }
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

const buildSection = () => {
  const T = types;
  const custom = { key: 'asar_custom', type: T.CUSTOM, Component: Panel, useSearchTerms: () => [ 'asar', 'openasar' ] };
  const category = { key: 'asar_category', type: T.CATEGORY ?? 5, buildLayout: () => [ custom ] };
  const panel = { key: 'asar_panel', type: T.PANEL, useTitle: () => 'asar', buildLayout: () => [ category ] };
  const item = { key: 'asar_main', type: T.SIDEBAR_ITEM, useTitle: () => 'asar', icon: () => React.createElement(Icon), buildLayout: () => [ panel ] };

  return { key: 'asar_section', type: T.SECTION, useTitle: () => 'asar', buildLayout: () => [ item ] };
};

const patchSettings = () => {
  if (patched) return true;
  scan();
  if (!root || !types || !React) return false;

  const orig = root.buildLayout;
  const wrapped = function (...args) {
    const layout = orig.apply(this, args);
    try {
      if (Array.isArray(layout) && !layout.some(s => s?.key === 'asar_section')) {
        let i = layout.findIndex(s => s?.key === 'games_and_apps_section');
        if (i === -1) i = layout.findIndex(s => s?.key === 'utility_section') - 1;
        layout.splice(i < 0 ? layout.length : i + 1, 0, buildSection());
      }
    } catch { }
    return layout;
  };

  try { root.buildLayout = wrapped; } catch { }
  if (root.buildLayout !== wrapped) try { Object.defineProperty(root, 'buildLayout', { value: wrapped, configurable: true, writable: true }); } catch { }

  patched = root.buildLayout === wrapped;
  if (patched) cleanup();
  return patched;
};

// Fallback when the layout tree can't be patched: a clickable "asar" line next to Discord's build info
// (the "Stable 123456 (abc1234)" lines at the bottom of the settings sidebar). Language independent.
let lastFallback = 0;
const domFallback = () => {
  if (document.getElementById('asar-ver') || Date.now() - lastFallback < 2000) return;
  lastFallback = Date.now();
  const x = document.evaluate('//*[not(*)][starts-with(normalize-space(.),"Stable ") or starts-with(normalize-space(.),"PTB ") or starts-with(normalize-space(.),"Canary ")][contains(.,"(")]', document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  if (!x) return;

  const ver = x.cloneNode(false);
  ver.id = 'asar-ver';
  ver.textContent = 'asar ' + cfg.version + ' — open settings';
  Object.assign(ver.style, { display: 'block', cursor: 'pointer', textDecoration: 'underline' });
  ver.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); open(); }, true);
  x.insertAdjacentElement('afterend', ver);
};

// Discord may load its settings code lazily (the first time you open settings). Hook chunk loading so the settings
// root is patched the moment its module runs, before it renders - otherwise the tab would only show on the 2nd open.
let unhook = () => { };
const hookChunks = () => {
  const chunk = window.webpackChunkdiscord_app;
  if (!chunk?.push || chunk.__asarHooked) return;

  const orig = chunk.push;
  const hooked = function (data) {
    try {
      const mods = data?.[1];
      if (!patched && mods && typeof mods === 'object') for (const id in mods) {
        const f = mods[id];
        if (typeof f !== 'function' || !Function.prototype.toString.call(f).includes('$Root')) continue;
        mods[id] = function () {
          const r = f.apply(this, arguments);
          try { patchSettings(); } catch { }
          return r;
        };
      }
    } catch { }
    return orig.apply(this, arguments);
  };

  chunk.push = hooked;
  chunk.__asarHooked = true;
  unhook = () => { if (chunk.push === hooked) chunk.push = orig; chunk.__asarHooked = false; };
};

let timer;
const attempt = () => {
  try { if (patchSettings()) return; } catch { }
  try { domFallback(); } catch { }
};
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(attempt, 250);
};
const cleanup = () => {
  unhook();
  document.removeEventListener('click', schedule, true);
  document.removeEventListener('keyup', schedule, true);
};

if (cfg.entry) {
  try { getReq(); hookChunks(); } catch { }
  for (const t of [ 1500, 5000, 15000, 40000 ]) setTimeout(attempt, t);
  document.addEventListener('click', schedule, true);
  document.addEventListener('keyup', schedule, true);
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
