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

// --- Theme sync: mirror Discord's colors into the splash / asar settings windows ---
// Reads both the pre-2025 variable names and the refreshed-UI names, so it keeps working across Discord redesigns.
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
setTimeout(safeSync, 5000);
setInterval(safeSync, 60000);
document.addEventListener('visibilitychange', () => document.hidden && safeSync());

// --- Settings entry injection ---
// OpenAsar relied on a couple of hashed class names and crashed (null.cloneNode) when Discord redesigned settings,
// so the entry vanished. This tries several strategies, never throws, and the Ctrl/Cmd+Alt+O hotkey always works.
const ADV_SELECTORS = [
  '[data-list-item-id="settings-sidebar___advanced_sidebar_item"]',
  '[data-settings-sidebar-item="advanced_panel"]',
  '[data-tab-id="Advanced"]',
  '[aria-controls="advanced-tab"]'
];

const findAdvanced = () => {
  for (const s of ADV_SELECTORS) {
    const el = document.querySelector(s);
    if (el) return el;
  }

  // Text fallback, only scanning navigation-like containers (cheap)
  const nav = document.querySelectorAll('nav [role="tab"], nav [role="button"], [role="tablist"] [role="tab"], [class*="sidebar"] [class*="item"]');
  for (const el of nav) if (el.textContent.trim() === 'Advanced' && el.childElementCount < 6) return el;
};

const setLabel = (root, from, to) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, done = false;
  while ((n = walker.nextNode())) {
    if (!done && n.nodeValue.trim() === from) { n.nodeValue = to; done = true; }
  }
  if (!done) root.textContent = to;
};

const injectEntry = () => {
  if (document.getElementById('asar-item')) return;

  const adv = findAdvanced();
  if (!adv) return;

  const item = adv.cloneNode(true);
  item.id = 'asar-item';
  item.removeAttribute('data-list-item-id');
  item.removeAttribute('aria-selected');
  item.removeAttribute('aria-controls');
  for (const el of [ item, ...item.querySelectorAll('[class]') ]) for (const c of [ ...el.classList ]) if (/selected/i.test(c)) el.classList.remove(c);
  setLabel(item, 'Advanced', 'asar');

  item.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    open();
  }, true);

  adv.insertAdjacentElement('afterend', item);

  // Version line at the bottom of the sidebar
  if (document.getElementById('asar-ver')) return;
  const info = document.querySelector('[class*="sidebar"] [class*="compactInfo"], [class*="sidebar"] [class*="versionInfo"]');
  const line = info?.children?.[0] ?? info;
  if (!line) return;

  const ver = line.cloneNode(false);
  ver.id = 'asar-ver';
  ver.textContent = 'asar ' + cfg.version;
  ver.style.cursor = 'pointer';
  ver.style.display = 'block';
  ver.onclick = open;
  (info.children?.length ? info : info.parentElement).appendChild(ver);
};

if (cfg.entry) setInterval(() => {
  try { injectEntry(); } catch { }
}, 1000);

// --- Custom CSS ---
if (cfg.css) {
  const el = document.createElement('style');
  el.id = 'asar-css';
  el.textContent = cfg.css;
  (document.head ?? document.documentElement).appendChild(el);
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
