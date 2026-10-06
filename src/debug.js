// asar debug recorder (asar settings > Debug)
//
// Off by default, and free while off: every recording call returns straight away. While on, it keeps the events of
// Discord's main process and page in memory (the page sends its own in one message every 2 s), samples CPU and memory
// every 5 s, and appends everything to a journal file every 3 s, so a crash, a freeze you had to kill, or a power
// cut still leaves a usable log (it's turned into a report the next time Discord starts).
// Stopping writes one self-explanatory text file: likely cause, environment, numbers and the full timeline.
//
// Privacy: no messages, names, links, files, tokens or account details are recorded. The page replaces server and
// channel IDs with codes salted per recording and reduces web addresses to the kind of request; paths lose your user
// folder; and the finished report is scrubbed again for anything that looks like an ID, e-mail address or token.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const { join } = require('path');

const MAX_EVENTS = 30000;
const KEEP_LOGS = 12;
const JOURNAL_MAX = 64 * 1024 * 1024;

const dir = () => join(require('./paths').getUserData(), 'asar-debug');
const journalPath = () => join(dir(), 'recording.jsonl');
const prevJournalPath = () => join(dir(), 'recording-previous.jsonl');

const newAgg = () => ({ kinds: {}, frames: { n: 0, ms: 0, by: {} }, freezes: [], stalls: [], switches: [], inputs: [], samples: [], reqs: [], flux: {}, errors: {}, gone: [], gpuGone: 0, unresponsive: 0, online: [], rtc: {}, gateway: { open: 0, closed: 0, codes: {} }, picker: [], loader: { shown: 0, estimated: 0, snapped: 0 } });

const R = {
  on: false, startedAt: 0, how: '', salt: 1, seq: 0, events: [], dropped: 0, queue: [], timers: [], agg: newAgg(),
  page: {}, env: null, journalBytes: 0, writing: Promise.resolve(), recovered: null, lastLog: null, consoleOff: null
};

// --- Recording ---
const aggregate = (C, e) => {
  const A = C.agg;
  A.kinds[e.k] = (A.kinds[e.k] ?? 0) + 1;
  switch (e.k) {
    case 'frame':
      A.frames.n++; A.frames.ms += e.ms || 0;
      for (const [ o, ms ] of Object.entries(e.own ?? {})) A.frames.by[o] = (A.frames.by[o] ?? 0) + (ms || 0);
      if (A.frames.list?.length > 4000) break;
      (A.frames.list ??= []).push({ t: e.t, ms: e.ms, own: e.own });
      break;
    case 'freeze': if (e.kind === 'gpu') A.gpuGone++; else A.freezes.push({ t: e.t, ms: e.ms || 0, kind: e.kind }); break;
    case 'win': if (e.ev === 'unresponsive') A.unresponsive++; break;
    case 'stall': A.stalls.push(e.ms); break;
    case 'switch': if (A.switches.length < 5000) A.switches.push(e); break;
    case 'input': if (A.inputs.length < 5000) A.inputs.push(e); break;
    case 'sample': if (A.samples.length < 20000) A.samples.push(e); break;
    case 'req': if (A.reqs.length < 5000) A.reqs.push(e); break;
    case 'proc-gone': A.gone.push(e); break;
    case 'online': A.online.push(e.on); break;
    case 'picker': if (A.picker.length < 2000) A.picker.push(e); break;
    case 'error': case 'console': {
      const key = (e.who ?? (e.k === 'console' ? 'console' : '?')) + ' | ' + e.msg;
      A.errors[key] = Math.max(A.errors[key] ?? 0, e.times ?? 1);
      break;
    }
    case 'loader':
      if (e.ev === 'shown') { A.loader.shown++; if (e.at === 'estimated') A.loader.estimated++; }
      if (e.ev === 'snapped onto chat') A.loader.snapped++;
      break;
    case 'flux':
      if (e.type === 'CONNECTION_OPEN') A.gateway.open++;
      if (e.type === 'CONNECTION_CLOSED') { A.gateway.closed++; A.gateway.codes[e.code] = (A.gateway.codes[e.code] ?? 0) + 1; }
      if (e.type === 'RTC_CONNECTION_STATE' && e.state) A.rtc[e.state] = (A.rtc[e.state] ?? 0) + 1;
      break;
  }
};

const ingest = (C, e) => {
  e.n = ++C.seq;
  C.events.push(e);
  if (C.events.length > MAX_EVENTS + 1000) { C.events.splice(0, 1000); C.dropped += 1000; }
  aggregate(C, e);
};

// Records one event. Returns straight away when not recording.
const ev = (k, f, src = 'app', t = Date.now()) => {
  if (!R.on) return;
  const e = { t, s: src, k, ...f };
  ingest(R, e);
  R.queue.push(e);
};

const appendJournal = (line, sync) => {
  if (R.journalBytes > JOURNAL_MAX) return;
  R.journalBytes += line.length;
  if (sync) { try { fs.appendFileSync(journalPath(), line); } catch { } return; }
  R.writing = R.writing.then(() => fs.promises.appendFile(journalPath(), line)).catch(() => { });
};
const flush = sync => {
  if (!R.queue.length) return;
  const s = R.queue.splice(0).map(x => JSON.stringify(x)).join('\n') + '\n';
  appendJournal(s, sync);
};

// Values from the page are checked and capped before they're kept
const clean = (v, depth = 0) => {
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 300);
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 80).map(x => clean(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[String(k).slice(0, 40)] = clean(v[k], depth + 1);
    return o;
  }
  return null;
};

exports.page = list => {
  if (!R.on || !Array.isArray(list)) return;
  for (const x of list.slice(0, 4000)) {
    if (!x || typeof x !== 'object' || typeof x.k !== 'string') continue;
    const e = clean(x);
    if (e.k === 'stats') { R.page.stats = e; R.queue.push({ pageStats: e }); continue; }
    const t = typeof e.t === 'number' && Math.abs(e.t - Date.now()) < 86400000 ? e.t : Date.now();
    delete e.t; delete e.k;
    ev(x.k.slice(0, 24), e, 'page', t);
  }
};

// Main-window events (rare: shown, hidden, frozen...) are watched all the time but only recorded while on
exports.watch = bw => {
  for (const name of [ 'unresponsive', 'responsive', 'show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur' ])
    bw.on(name, () => ev('win', { ev: name }));
  bw.webContents.on('render-process-gone', (e, d) => ev('proc-gone', { type: 'Discord page', reason: d?.reason, code: d?.exitCode }));
  bw.webContents.on('did-fail-load', (e, code, desc, url, main) => { if (main) ev('load-fail', { code, desc: String(desc).slice(0, 80) }); });
  bw.webContents.on('did-navigate', () => ev('win', { ev: 'Discord page loaded (start or reload)' }));
};

let appHooked = false;
const hookApp = () => {
  if (appHooked) return;
  appHooked = true;
  app.on('child-process-gone', (e, d) => { if (d.reason !== 'clean-exit') ev('proc-gone', { type: d.type, name: d.serviceName || d.name || undefined, reason: d.reason, code: d.exitCode }); });
  app.on('web-contents-created', (e, wc) => ev('win', { ev: 'new web page: ' + wc.getType() }));
  app.whenReady().then(() => {
    const { powerMonitor, screen } = require('electron');
    for (const name of [ 'suspend', 'resume', 'on-ac', 'on-battery', 'lock-screen', 'unlock-screen', 'thermal-state-change', 'speed-limit-change', 'shutdown' ])
      try { powerMonitor.on(name, (e, d) => ev('power', { ev: name, state: typeof d === 'string' || typeof d === 'number' ? d : undefined })); } catch { }
    for (const name of [ 'display-added', 'display-removed', 'display-metrics-changed' ])
      try { screen.on(name, (e, d, ch) => ev('display', { ev: name, changed: Array.isArray(ch) ? ch.join(',') : undefined, displays: screen.getAllDisplays().length })); } catch { }
  });
};
hookApp();

// Console errors from Discord's page (only while recording, scrubbed, each distinct message at most 3 times)
const consoleSeen = new Map();
const watchConsole = () => {
  const w = global.asarMainWindow;
  if (!w || w.isDestroyed() || R.consoleOff) return;
  const fn = (e, ...old) => { // Electron 35+ passes one event object; older versions (level, message, line, source)
    const [ level, message, line, source ] = old;
    const lv = e?.level ?? level;
    if (!(lv === 3 || lv === 'error')) return;
    const raw = String(e?.message ?? message ?? '');
    if (/^Uncaught /.test(raw)) return; // already recorded (scrubbed) by the page as an 'error'
    const msg = scrubText(redactUrls(raw)).slice(0, 300);
    const src = String(e?.sourceId ?? source ?? '');
    const n = (consoleSeen.get(msg) ?? 0) + 1;
    if (consoleSeen.size < 300 || consoleSeen.has(msg)) consoleSeen.set(msg, n);
    const file = whoOf(src) === 'Discord' || /asar-/.test(src) ? (src.split(/[\\/]/).pop() || '').split('?')[0].slice(0, 60) : whoOf(src);
    if (n <= 3) ev('console', { msg, at: file + ':' + (e?.lineNumber ?? line ?? ''), who: whoOf(src), times: n > 1 ? n : undefined });
  };
  w.webContents.on('console-message', fn);
  R.consoleOff = () => { try { w.webContents.off('console-message', fn); } catch { } };
};
// Web addresses in free text -> host kind and path without IDs, codes or file names (same rules as the page)
const redactUrls = t => String(t).replace(/\b(?:https?|wss?|file):\/\/[^\s'"`)]+/g, m => {
  let u;
  try { u = new URL(m); } catch { return '<link>'; }
  const h = u.host;
  if (!/(^|\.)(discord(app)?\.(com|net)|discord\.gg|discord\.media)$/.test(h)) return 'other site';
  if (/\.discord\.media$/.test(h)) return 'voice server';
  if (/^images-ext-/.test(h) || u.pathname.includes('/external/')) return h + '/external/…';
  const code = h === 'discord.com' && u.pathname.startsWith('/assets/');
  let prev = '';
  return h + u.pathname.split('/').map(seg => {
    const p = prev;
    prev = seg;
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (/^(invites?|templates?|gifts?|gift-codes|guild-template)$/.test(p)) return ':x';
    if (seg === '@me' || /^v\d{1,2}$/.test(seg) || /^[a-z][a-z_-]{0,23}$/.test(seg)) return seg;
    if (/\.([a-z0-9]{2,5})$/i.test(seg)) return code ? seg.slice(0, 60) : '*.' + seg.split('.').pop().toLowerCase();
    return ':x';
  }).join('/');
});
const whoOf = src => /asar-injected/.test(src) ? 'asar' : /asar-custom/.test(src) ? 'your custom JS' : /betterdiscord|\.plugin\.js/i.test(src) ? 'BetterDiscord' : /vencord|equicord/i.test(src) ? 'Vencord' : /discord(app)?\.com/.test(src) ? 'Discord' : src ? 'other' : 'unknown';

// CPU, memory and main-process responsiveness every 5 s
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
const utilName = s => /network/i.test(s) ? 'network' : /audio/i.test(s) ? 'audio' : /video_capture/i.test(s) ? 'video capture' : /storage/i.test(s) ? 'storage' : 'utility';
let lastCpu = null;
const sample = () => {
  if (!app.isReady()) return;
  try {
    const c = cpuTimes(), cores = os.cpus().length || 1;
    const sys = lastCpu && c.all > lastCpu.all ? Math.round((c.busy - lastCpu.busy) / (c.all - lastCpu.all) * 100) : undefined;
    lastCpu = c;
    const w = global.asarMainWindow;
    let pagePid = -1;
    try { if (w && !w.isDestroyed()) pagePid = w.webContents.getOSProcessId(); } catch { }
    const procs = {};
    let total = 0, mb = 0;
    for (const m of app.getAppMetrics()) {
      const name = m.pid === pagePid ? 'page' : m.type === 'Browser' ? 'main' : m.type === 'GPU' ? 'gpu' : m.type === 'Tab' ? 'other windows' : m.type === 'Utility' ? utilName(m.serviceName ?? m.name ?? '') : String(m.type).toLowerCase();
      const p = procs[name] ??= { cpu: 0, mb: 0 };
      const cpu = (m.cpu?.percentCPUUsage ?? 0) / cores; // share of the whole PC
      p.cpu += cpu; total += cpu;
      const ws = (m.memory?.workingSetSize ?? 0) / 1024;
      p.mb += ws; mb += ws;
    }
    for (const k in procs) { procs[k].cpu = Math.round(procs[k].cpu * 10) / 10; procs[k].mb = Math.round(procs[k].mb); }
    const lag = global.asarLagMax ?? 0;
    global.asarLagMax = 0;
    let batt;
    try { const pm = require('electron').powerMonitor; batt = pm.isOnBatteryPower?.() ?? pm.onBatteryPower; } catch { }
    if (sys == null) for (const k in procs) delete procs[k].cpu; // first sample: Chromium has no CPU numbers yet
    ev('sample', { pc: sys, discord: sys == null ? undefined : Math.round(total * 10) / 10, procs, mb: Math.round(mb), freeMB: Math.round(os.freemem() / 1048576), lag: Math.max(0, Math.round(lag)), battery: batt || undefined });
  } catch (e) { ev('note', { msg: 'sample failed: ' + e?.message }); }
};

// --- Environment ---
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o?.[k] != null && o[k] !== '') r[k] = o[k]; return r; };
const DISCORD_KEYS = [ 'enableHardwareAcceleration', 'MINIMIZE_TO_TRAY', 'OPEN_ON_STARTUP', 'START_MINIMIZED', 'SKIP_HOST_UPDATE', 'SKIP_MODULE_UPDATE', 'chromiumSwitches', 'openH264Enabled', 'IS_MAXIMIZED', 'DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING', 'offloadAdmControls', 'asarClearCaches' ];

const asarConfig = () => {
  const c = { ...(global.oaConfig ?? {}) };
  for (const k of [ 'css', 'js' ]) if (k in c) c[k] = c[k] && String(c[k]).trim() ? `set (${String(c[k]).length} characters)` : 'empty';
  if (c.updateUrl) c.updateUrl = c.updateUrl === require('./asarUpdate').DEFAULT_URL ? 'default' : 'custom';
  return c;
};

const detectMods = () => {
  const out = [];
  try {
    const src = fs.readFileSync(require.resolve('discord_desktop_core'), 'utf8');
    const m = src.match(/betterdiscord|vencord|equicord|replugged|powercord|shelter|kernel|lightcord|goosemod/gi);
    if (m) out.push('discord_desktop_core loads: ' + [ ...new Set(m.map(x => x.toLowerCase())) ].join(', '));
    else if (src.length > 300 || !/core\.asar/.test(src)) out.push(`discord_desktop_core/index.js is not stock (${src.length} bytes)`);
  } catch { }
  try {
    const res = join(__dirname, '..');
    const extra = fs.readdirSync(res).filter(f => !/^(app\.asar(\.backup|\.asar-fork|\.new)?|build_info\.json|bootstrap|default_app\.asar|app\.asar\.unpacked|app-update\.yml|.*\.pak|locales|.*\.dat|.*\.bin|.*\.json)$/i.test(f));
    if (extra.length) out.push('other files next to app.asar: ' + extra.slice(0, 10).join(', '));
  } catch { }
  return out;
};

const timeout = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));
const envSnapshot = async () => {
  const E = {};
  try {
    E.versions = { asar: global.asarVersion, discord: app.getVersion(), channel: global.releaseChannel, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
    E.os = { platform: process.platform, version: os.version?.(), release: os.release(), arch: process.arch, upHours: Math.round(os.uptime() / 3600) };
    const cpus = os.cpus();
    E.cpu = { model: cpus[0]?.model?.trim(), threads: cpus.length, mhz: cpus[0]?.speed };
    E.ram = { totalGB: Math.round(os.totalmem() / 1073741824 * 10) / 10, freeGB: Math.round(os.freemem() / 1073741824 * 10) / 10 };
    E.locale = app.getLocale?.();
    E.hwAccel = settings.get('enableHardwareAcceleration', true);
    E.safeMode = !!global.oaConfig?.safeMode;
    E.pure = !!global.asarPure;
    E.flags = global.asarFlags ?? [];
    E.discordSettings = pick(settings.store ?? {}, DISCORD_KEYS);
    E.asar = asarConfig();
    E.mods = detectMods();
    E.backup = [ 'app.asar.backup', 'app.asar.orig', '_app.asar' ].some(f => fs.existsSync(join(__dirname, '..', f)));
    E.installedIn = /[\\/]app-[\d.]+[\\/]resources/.test(__dirname) ? 'Discord app-' + (/app-([\d.]+)/.exec(__dirname)?.[1] ?? '?') : process.platform === 'darwin' ? 'Discord.app' : 'resources folder';
    E.launches = (settings.get('asarStats', []) ?? []).slice(-5).map(s => s.t + ' s (asar ' + s.v + ')');
    E.argv = process.argv.slice(1).filter((a, i, all) => all[i - 1] !== '--url' && !/^discord:/.test(a)).slice(0, 20);
    if (app.isReady()) {
      E.gpuFeatures = app.getGPUFeatureStatus();
      const g = await Promise.race([ app.getGPUInfo('basic').catch(() => null), timeout(4000, null) ]);
      E.gpu = (g?.gpuDevice ?? []).map(d => pick(d, [ 'active', 'vendorId', 'deviceId', 'vendorString', 'deviceString', 'driverVendor', 'driverVersion', 'driverDate' ]));
      const { screen, session } = require('electron');
      E.displays = screen.getAllDisplays().map(d => ({ size: d.size.width + 'x' + d.size.height, scale: d.scaleFactor, hz: d.displayFrequency, depth: d.colorDepth, internal: d.internal || undefined }));
      try { const pm = require('electron').powerMonitor; E.battery = pm.isOnBatteryPower?.() ?? pm.onBatteryPower; E.thermal = pm.getCurrentThermalState?.(); } catch { }
      try { const p = await Promise.race([ session.defaultSession.resolveProxy('https://discord.com'), timeout(2000, '?') ]); E.proxy = p === 'DIRECT' ? 'none' : String(p).split(/[\s;]/)[0] || '?'; } catch { }
      try { E.extensions = (session.defaultSession.extensions ?? session.defaultSession).getAllExtensions().map(x => x.name); } catch { }
      const w = global.asarMainWindow;
      if (w && !w.isDestroyed()) {
        const all = screen.getAllDisplays(), on = screen.getDisplayMatching(w.getBounds());
        E.window = { size: w.getSize().join('x'), maximized: w.isMaximized(), fullscreen: w.isFullScreen(), zoom: w.webContents.getZoomFactor(), display: all.findIndex(d => d.id === on.id) + 1 };
      }
    }
  } catch (e) { E.error = String(e?.message ?? e); }
  return E;
};

// --- Talking to Discord's page ---
const pageCmd = arg => {
  const w = global.asarMainWindow;
  if (!w || w.isDestroyed()) return Promise.resolve(null);
  const p = w.webContents.executeJavaScript(`window.__asarDbg ? window.__asarDbg(${JSON.stringify(arg)}) : null`, true).catch(() => null);
  return Promise.race([ p, timeout(1500, null) ]); // a frozen page can't answer; don't wait on it
};

// --- Start / stop ---
exports.isOn = () => R.on;
exports.salt = () => R.salt;
exports.ev = ev;

exports.start = how => {
  if (R.on) return exports.status();
  try {
    fs.mkdirSync(dir(), { recursive: true });
    // A journal left behind means the last recording never finished (crash / killed): keep it for recovery
    if (fs.existsSync(journalPath())) { try { fs.renameSync(journalPath(), prevJournalPath()); } catch { } setTimeout(recover, 8000).unref?.(); }
  } catch { }
  Object.assign(R, { on: true, startedAt: Date.now(), how, salt: 1 + Math.floor(Math.random() * 2147483000), seq: 0, events: [], dropped: 0, queue: [], agg: newAgg(), page: {}, env: null, journalBytes: 0 });
  consoleSeen.clear();
  appendJournal(JSON.stringify({ header: { startedAt: R.startedAt, how, version: global.asarVersion, discord: app.getVersion() } }) + '\n', true);
  ev('rec', { ev: 'start', how });
  lastCpu = null;
  global.asarLagMax = 0;
  R.timers = [ setInterval(() => flush(false), 3000), setInterval(sample, 5000) ];
  for (const t of R.timers) t.unref?.();
  const snap = () => envSnapshot().then(E => { R.env = E; R.queue.push({ env: E }); });
  if (app.isReady()) snap(); else app.whenReady().then(() => setTimeout(snap, 1500));
  watchConsole();
  pageCmd({ on: true, salt: R.salt });
  log('Debug', 'Recording started (' + how + ')');
  return exports.status();
};

// When the main window appears after the recording started (record from Discord's start)
exports.windowReady = () => { if (R.on) { watchConsole(); if (!R.env?.window) envSnapshot().then(E => { R.env = E; R.queue.push({ env: E }); }); } };

const end = why => {
  ev('rec', { ev: 'stop', why });
  R.on = false;
  for (const t of R.timers) clearInterval(t);
  R.timers = [];
  R.consoleOff?.();
  R.consoleOff = null;
};

// Stop and save. `why` ends up in the report.
exports.stop = async (why = 'stopped in asar settings') => {
  if (!R.on) return null;
  const rest = await pageCmd(false);
  if (Array.isArray(rest)) exports.page(rest);
  end(why);
  return finishFile(why);
};

// Save what's recorded so far without stopping
exports.snapshot = async () => {
  if (!R.on) return null;
  const rest = await pageCmd('flush');
  if (Array.isArray(rest)) exports.page(rest);
  flush(false);
  return writeReport({ ...R, live: true, endedAt: Date.now(), why: 'saved while still recording' }, 'snapshot');
};

// Discord is quitting / restarting: finish synchronously with what's there (the page's last 2 s may be missing)
let finished = false;
exports.finishNow = why => {
  if (!R.on || finished) return null;
  finished = true;
  end(why);
  return finishFile(why, true);
};

const finishFile = (why, sync) => {
  flush(true);
  let name = null;
  try { name = writeReport({ ...R, live: true, endedAt: Date.now(), why }); } catch (e) { log('Debug', 'Report failed', e); }
  if (name) try { fs.rmSync(journalPath(), { force: true }); } catch { }
  log('Debug', 'Recording saved', name);
  return name;
};

app.on('will-quit', () => exports.finishNow('Discord was closed'));
process.on('exit', () => exports.finishNow('Discord was closed'));

// --- Recovering a recording that never finished ---
const recover = () => {
  const p = prevJournalPath();
  let text;
  try { if (fs.statSync(p).size > JOURNAL_MAX * 1.2) throw 0; text = fs.readFileSync(p, 'utf8'); } catch { try { fs.rmSync(p, { force: true }); } catch { } return; }
  const C = { startedAt: 0, how: '?', seq: 0, events: [], dropped: 0, agg: newAgg(), page: {}, env: null };
  let last = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.header) { C.startedAt = o.header.startedAt; C.how = o.header.how; continue; }
    if (o.env) { C.env = o.env; continue; }
    if (o.pageStats) { C.page.stats = o.pageStats; continue; }
    if (typeof o.t === 'number' && typeof o.k === 'string') { ingest(C, o); last = Math.max(last, o.t); }
  }
  if (!C.startedAt) C.startedAt = C.events[0]?.t ?? Date.now();
  const why = 'Discord closed without finishing the recording (crash, hard freeze, killed, or PC turned off). Events up to about 3 s before the end are included.';
  let name = null;
  try { name = writeReport({ ...C, endedAt: last || C.startedAt, why, salt: 0 }, 'recovered'); } catch (e) { log('Debug', 'Recovery failed', e); }
  if (name) { R.recovered = name; try { fs.rmSync(p, { force: true }); } catch { } }
};
exports.init = () => {
  // No recording at startup but a journal exists: the last recording ended abruptly
  setTimeout(() => {
    try {
      if (!R.on && fs.existsSync(journalPath())) fs.renameSync(journalPath(), prevJournalPath());
      if (fs.existsSync(prevJournalPath())) recover();
    } catch { }
  }, 10000).unref?.();
};

// --- Files ---
exports.dir = dir;
exports.logs = () => {
  try {
    return fs.readdirSync(dir()).filter(f => /^asar-log-[\w-]+\.txt$/.test(f)).sort().reverse().slice(0, KEEP_LOGS)
      .map(f => { const st = fs.statSync(join(dir(), f)); return { name: f, size: st.size, at: st.mtimeMs }; });
  } catch { return []; }
};
exports.validName = n => typeof n === 'string' && /^asar-log-[\w-]+\.txt$/.test(n) && fs.existsSync(join(dir(), n));

exports.status = () => ({
  on: R.on, startedAt: R.startedAt, how: R.how, events: R.seq, dropped: R.dropped,
  onStart: !!global.oaConfig?.debugOnStart, logs: exports.logs(), recovered: R.recovered, last: R.lastLog
});

// Live view in asar settings: events after `since`, formatted like the log's timeline
exports.tail = since => {
  const out = [];
  if (R.startedAt) for (let i = R.events.length - 1; i >= 0 && out.length < 200; i--) {
    const e = R.events[i];
    if (e.n <= since) break;
    out.push(e);
  }
  // Short form for the narrow live view: seconds since start, source, what happened (in time order within a batch)
  const lines = out.reverse().sort((a, b) => a.t - b.t).map(e => scrubText(`${(Math.max(0, e.t - R.startedAt) / 1000).toFixed(1).padStart(6)}s  ${e.s === 'page' ? 'page' : 'app '}  ${describe(e)}`));
  return { on: R.on, seq: R.seq, events: R.seq, startedAt: R.startedAt, lines };
};

// Summary part of a saved log (everything before the timeline), for pasting into a chat
exports.summaryOf = name => {
  try {
    const t = fs.readFileSync(join(dir(), name), 'utf8');
    const i = t.indexOf('\nTIMELINE\n');
    return i > 0 ? t.slice(0, i) : t.slice(0, 20000);
  } catch { return null; }
};

// --- Report ---
const home = os.homedir();
let user = '';
try { user = os.userInfo().username; } catch { }
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const scrubText = s => {
  let t = redactUrls(s);
  if (home && home.length > 3) for (const h of new Set([ home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\') ])) t = t.split(h).join('~');
  if (user && user.length > 1) t = t.replace(new RegExp('([\\\\/](?:Users|home)[\\\\/]+)' + escRe(user) + '(?=$|[\\\\/])', 'gi'), '$1<user>'); // other drives' user folders
  return t
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{25,})\b/g, '<token>')
    .replace(/\b\d{16,21}\b/g, '<id>');
};

const pad = (s, n) => String(s).padEnd(n);
const sec = ms => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
const ms_ = v => v == null ? '?' : Math.round(v) + ' ms';
const med = a => { if (!a.length) return null; const s = [ ...a ].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return null; const s = [ ...a ].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const clock = t => { const d = new Date(t); return [ d.getHours(), d.getMinutes(), d.getSeconds() ].map(x => String(x).padStart(2, '0')).join(':'); };
const stamp = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + clock(t); };
const kv = o => Object.entries(o ?? {}).filter(([ , v ]) => v !== undefined && v !== null && v !== '').map(([ k, v ]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' ');
const owners = own => Object.entries(own ?? {}).sort((a, b) => b[1] - a[1]).map(([ k, v ]) => `${k} ${v} ms`).join(', ');

const describe = e => {
  try { return describeRaw(e); } catch { const x = { ...e }; for (const k of [ 't', 's', 'k', 'n' ]) delete x[k]; return kv(x); }
};
const describeRaw = e => {
  const x = { ...e };
  for (const k of [ 't', 's', 'k', 'n' ]) delete x[k];
  switch (e.k) {
    case 'rec': return e.ev === 'start' ? 'Recording started' + (e.how === 'launch' ? ' together with Discord' : '') : 'Recording ended: ' + e.why;
    case 'sample': {
      const p = Object.entries(e.procs ?? {}).sort((a, b) => b[1].cpu - a[1].cpu).filter(([ , v ]) => v.cpu >= 0.5).map(([ k, v ]) => `${k} ${v.cpu}%`).join(', ');
      return `CPU: whole PC ${e.pc ?? '?'}%, Discord ${e.discord ?? '?'}%${p ? ' (' + p + ')' : ''} · RAM: Discord ${e.mb} MB, free ${e.freeMB} MB · main process lag ${e.lag} ms${e.battery ? ' · on battery' : ''}`;
    }
    case 'freeze': return e.kind === 'gpu' ? `GRAPHICS PROCESS CRASHED (${e.reason ?? '?'}, exit ${e.exitCode ?? '?'})` : `FROZE for ${sec(e.ms)} (${e.kind === 'page' ? 'seen by asar\'s heartbeat in the page' : e.kind === 'window' ? 'Windows/Electron reported "not responding"' : e.kind})`;
    case 'stall': return `main process was stuck for ${e.ms} ms (IPC, voice, streams wait on it)`;
    case 'proc-gone': return `${e.type}${e.name ? ' (' + e.name + ')' : ''} process ended: ${e.reason} (exit code ${e.code})`;
    case 'win': return 'window: ' + e.ev;
    case 'power': return 'power: ' + e.ev + (e.state != null ? ' ' + e.state : '');
    case 'display': return `displays: ${e.ev}${e.changed ? ' (' + e.changed + ')' : ''}, ${e.displays} connected`;
    case 'picker': return `screen-share picker: ${e.sources ?? '?'} sources in ${ms_(e.ms)} · asked ${e.asked}, made ${e.made}${e.cached ? ' · answered from cache' : ''}${e.shared ? ' · shared with a request in flight' : ''}`;
    case 'update': return 'asar update check: ' + e.result;
    case 'console': return `console error (${e.who}): ${e.msg} @ ${e.at}${e.times ? ' (repeat ' + e.times + ')' : ''}`;
    case 'error': return `error (${e.who}): ${e.msg} @ ${e.at}${e.times ? ' (repeat ' + e.times + ')' : ''}`;
    case 'config': return 'asar setting changed: ' + e.changed;
    case 'safe-mode': return 'asar turned on SAFE MODE: ' + e.reason;
    case 'load-fail': return `Discord page failed to load: ${e.desc} (${e.code})`;
    case 'page': return `Discord page: ${e.route}, ${e.size} at ${e.dpr}x, ${e.dom} elements, ${e.heap} MB JS memory, ${e.guilds ?? '?'} servers` + (e.mods?.length ? ', mods: ' + e.mods.join(', ') : '') + (e.net ? `, network ${e.net.type} ~${e.net.rtt} ms / ${e.net.mbps} Mbps` : '');
    case 'switch': {
      const parts = [ `${e.c ?? '?'} (${e.ty ?? '?'}) ${e.timeout ? 'NOT READY after' : 'opened in'} ${e.ms} ms` ];
      parts.push(e.stored ? 'messages already in memory' : e.warm ? 'preloaded' : 'not preloaded');
      if (e.js != null || e.draw != null) parts.push(`Discord's code ${e.js ?? 0} ms`, `drawing ${e.draw ?? 0} ms`);
      if (e.msgs != null) parts.push(e.msgs + ' messages on screen');
      if (e.loader) parts.push('loading screen shown');
      if (e.merged) parts.push(e.merged + ' quicker click(s) merged');
      if (e.how && e.how !== 'click') parts.push('via ' + e.how);
      return 'channel switch: ' + parts.join(' · ');
    }
    case 'frame': {
      const t = e.top?.[0];
      return `slow frame ${e.ms} ms (input blocked ${e.blocked} ms): ${owners(e.own)}` + (t ? ` · biggest: ${t.who} ${t.file}${t.fn ? ' ' + t.fn + '()' : ''}${t.via ? ' from ' + t.via : ''} ${t.ms} ms${t.layout ? ' (forced layout ' + t.layout + ' ms)' : ''}` : '');
    }
    case 'input': return `slow ${e.ev} on ${e.on}: ${e.ms} ms until on screen (waiting ${e.wait} · running ${e.run} · drawing ${e.draw})`;
    case 'req': return `${e.status >= 400 ? 'FAILED ' + e.status : 'slow'} ${e.kind} request ${e.path}: ${e.ms} ms` + (e.server != null ? ` (queued ${e.queued}, server ${e.server}, download ${e.download})` : '') + (e.kb ? ` ${e.kb} KB` : '') + (e.proto ? ' ' + e.proto : '');
    case 'flux': return `Discord: ${e.type}` + (Object.keys(x).length > 1 ? ' ' + kv({ ...x, type: undefined }) : '');
    case 'flux-slow': return `Discord action ${e.type} took ${e.ms} ms`;
    case 'mem': return `JS memory ${e.heap} MB of ${e.heapMax} MB` + (e.dom ? ` · ${e.dom} page elements` : '');
    case 'mem-trim': return `background memory cleanup freed ${e.freedMB} MB (now ${e.heapMB} MB)`;
    case 'visible': return e.on ? 'Discord is visible' : 'Discord is hidden (minimized, in tray, or fully covered)';
    case 'online': return e.on ? 'network: back online' : 'network: OFFLINE';
    case 'netinfo': return `network quality changed: ${e.type ?? '?'} ~${e.rtt ?? '?'} ms / ${e.mbps ?? '?'} Mbps`;
    case 'loader': return `loading screen ${e.ev}` + (e.c ? ' for ' + e.c : '') + (e.at ? ` (position: ${e.at} ${e.box})` : '') + (e.from ? ` ${e.from} -> ${e.to}` : '');
    case 'preload': return `preloaded ${e.c ?? '?'} (${e.ty ?? '?'}, ${e.why}) in ${e.ms ?? '?'} ms${e.failed ? ' — FAILED' : ''}`;
    case 'settings': return `Discord settings opened in ${e.ms} ms${e.first ? ' (first time this session)' : ''}${e.instant ? ' with instant feedback' : ''}`;
    case 'settings-prep': return `Discord settings prepared in advance: ${kv(x)}`;
    case 'mark': return 'startup: ' + e.name;
    case 'note': return e.msg;
  }
  return kv(x);
};
const line = (e, t0) => `${(((e.t - t0) / 1000).toFixed(2) + 's').padStart(10)}  ${clock(e.t)}  ${e.s === 'page' ? 'page' : 'app '}  ${pad(e.k, 11)}${describe(e)}`;

// Findings: what went wrong, how bad, and whose it likely is
const TAGS = { asar: 'asar', discord: 'Discord', pc: 'this PC', net: 'network', gpu: 'graphics', mod: 'other mod', setting: 'setting', info: 'info' };
const analyse = C => {
  const A = C.agg, E = C.env ?? {}, P = C.page.stats ?? {}, F = [];
  const add = (sev, tag, text) => F.push({ sev, tag, text });
  const durMs = Math.max(1, (C.endedAt ?? Date.now()) - C.startedAt);
  const pageInfo = C.events.find(e => e.k === 'page');

  // Freezes, with whose code ran during them
  const fz = A.freezes;
  if (fz.length) {
    const blame = {};
    for (const f of fz) for (const fr of A.frames.list ?? []) {
      if (fr.t + fr.ms < f.t - f.ms - 1000 || fr.t > f.t + 500) continue;
      for (const [ o, ms ] of Object.entries(fr.own ?? {})) blame[o] = (blame[o] ?? 0) + ms;
    }
    const tot = Object.values(blame).reduce((a, b) => a + b, 0);
    const top = Object.entries(blame).sort((a, b) => b[1] - a[1]);
    const share = top.slice(0, 4).map(([ o, ms ]) => `${o} ${Math.round(ms / tot * 100)}%`).join(', ');
    const lead = top[0]?.[0];
    const tag = lead === 'asar' ? 'asar' : [ 'BetterDiscord', 'Vencord', 'other mod' ].includes(lead) ? 'mod' : lead === 'drawing' ? 'gpu' : 'discord';
    add(3, tag, `Discord froze ${fz.length} time${fz.length === 1 ? '' : 's'} (longest ${sec(Math.max(...fz.map(f => f.ms)))}).` + (tot ? ` During the freezes the time went to: ${share}.` : ' No slow-frame details were captured for them (the page may have been too stuck to report).'));
  }
  if (A.gpuGone) add(3, 'gpu', `The graphics process crashed ${A.gpuGone} time${A.gpuGone === 1 ? '' : 's'}. Usually the graphics driver${E.gpu?.[0]?.driverVersion ? ' (installed: ' + E.gpu[0].driverVersion + ')' : ''}; updating it, or turning off GPU boost in asar, usually helps.`);
  for (const g of A.gone.filter(x => x.type !== 'GPU')) add(g.type === 'Discord page' ? 3 : 2, g.reason === 'oom' ? 'pc' : 'discord', `${g.type}${g.name ? ' (' + g.name + ')' : ''} process ended: ${g.reason}${g.reason === 'oom' ? ' (out of memory)' : ''}.`);
  if (A.stalls.length) add(Math.max(...A.stalls) >= 3000 ? 3 : 2, 'discord', `Discord's main process got stuck ${A.stalls.length} time${A.stalls.length === 1 ? '' : 's'} (longest ${sec(Math.max(...A.stalls))}). Opening channels, voice and streams wait on it.` + (A.picker.length ? ' The screen-share picker was used during this recording.' : ''));

  // Whose code makes frames slow
  const by = A.frames.by, tot = Object.values(by).reduce((a, b) => a + b, 0);
  if (tot > 0) {
    const asarMs = by.asar ?? 0, modMs = (by.BetterDiscord ?? 0) + (by.Vencord ?? 0) + (by['other mod'] ?? 0), custom = by['your custom JS'] ?? 0;
    if (asarMs > 300 && asarMs / tot > 0.1) add(3, 'asar', `asar's own code ran for ${asarMs} ms inside slow frames (${Math.round(asarMs / tot * 100)}% of all slow-frame time). This points at asar: send this log to the asar developer.`);
    if (modMs > 300 && modMs / tot > 0.1) add(2, 'mod', `Another mod's code ran for ${modMs} ms inside slow frames (${Math.round(modMs / tot * 100)}%).`);
    if (custom > 300 && custom / tot > 0.1) add(2, 'setting', `Your custom JS (asar settings > Theming) ran for ${custom} ms inside slow frames.`);
    add(0, 'info', `Slow frames (150 ms+): ${A.frames.n}, ${sec(A.frames.ms)} in total. Time by owner: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([ o, ms ]) => `${o} ${Math.round(ms / tot * 100)}%`).join(', ')}. asar's share: ${Math.round((by.asar ?? 0) / tot * 1000) / 10}%.`);
  }

  // This PC
  const S = A.samples.filter(s => s.pc != null);
  if (S.length >= 3) {
    const busy = S.filter(s => s.pc >= 90);
    if (busy.length / S.length >= 0.2) {
      const discordShare = med(busy.map(s => s.discord));
      add(discordShare < 40 ? 3 : 2, discordShare < 40 ? 'pc' : 'discord', `The whole PC's CPU was at 90%+ for ${Math.round(busy.length / S.length * 100)}% of the recording; Discord itself used about ${discordShare}% of the CPU then.` + (discordShare < 40 ? ' Other programs (a game, browser, antivirus...) are keeping the CPU busy.' : ''));
    }
    const minFree = Math.min(...S.map(s => s.freeMB));
    const totalMB = (E.ram?.totalGB ?? 0) * 1024;
    if (minFree < 600 || (totalMB && minFree / totalMB < 0.06)) add(2, 'pc', `Free memory dropped to ${minFree} MB${totalMB ? ' of ' + Math.round(totalMB / 1024) + ' GB' : ''}. Windows then moves parts of Discord to disk, which makes switching channels slow.`);
    const maxMB = Math.max(...S.map(s => s.mb));
    if (maxMB > 3000) add(1, 'discord', `Discord used up to ${(maxMB / 1024).toFixed(1)} GB of memory.`);
    const lagMax = Math.max(...S.map(s => s.lag));
    if (lagMax >= 300 && !A.stalls.length) add(1, 'discord', `Discord's main process responded late (up to ${lagMax} ms).`);
    if (S.some(s => s.battery)) add(1, 'pc', 'The PC was running on battery; Windows may slow the CPU and GPU down to save power.');
  }
  if (E.thermal && /serious|critical/.test(E.thermal)) add(2, 'pc', 'The PC reported it is overheating (thermal state ' + E.thermal + ').');

  // Graphics
  if (E.hwAccel === false) add(2, 'setting', 'Hardware acceleration is off in Discord, so everything is drawn by the CPU. Turn it on in Discord settings > Advanced (or System).');
  const gf = E.gpuFeatures ?? {};
  if (E.hwAccel !== false && gf.gpu_compositing && !/^enabled/.test(gf.gpu_compositing)) add(2, 'gpu', `Chromium isn't using the GPU for drawing (gpu_compositing: ${gf.gpu_compositing}). The graphics driver is blocklisted or crashed earlier.`);

  // Network
  const fail = A.online.filter(x => x === false).length;
  if (fail) add(2, 'net', `The network went offline ${fail} time${fail === 1 ? '' : 's'}.`);
  if (A.gateway.closed) add(A.gateway.closed >= 3 ? 2 : 1, 'net', `Discord's live connection dropped ${A.gateway.closed} time${A.gateway.closed === 1 ? '' : 's'} (close codes: ${Object.entries(A.gateway.codes).map(([ c, n ]) => c + (n > 1 ? ' ×' + n : '')).join(', ')}).`);
  const net = P.net ?? {};
  const r429 = Object.values(net).reduce((a, v) => a + (v.r429 ?? 0), 0);
  if (r429) {
    const preloads = A.kinds.preload ?? 0;
    add(2, preloads > 20 ? 'asar' : 'discord', `Discord's servers rate-limited ${r429} request${r429 === 1 ? '' : 's'} (HTTP 429).` + (preloads ? ` asar preloaded ${preloads} channels in this recording; if this keeps happening, turn off "Keep top channels ready" and "Preload channels on hover".` : ''));
  }
  const timed = A.reqs.filter(r => r.server != null && r.status !== 429);
  if (timed.length >= 3) {
    const serverHeavy = timed.filter(r => r.server > r.ms * 0.6).length, queued = timed.filter(r => r.queued > r.ms * 0.6).length;
    if (serverHeavy >= timed.length / 2) add(2, 'net', `${timed.length} requests took 1 s or more, mostly waiting for Discord's servers to answer: your connection or Discord's servers, not this PC or asar.`);
    else if (queued >= timed.length / 2) add(2, 'pc', `${timed.length} requests took 1 s or more, mostly waiting on this PC before being sent (too many downloads at once or a busy PC).`);
    else add(1, 'net', `${timed.length} requests took 1 s or more (slow downloads, mostly images and media).`);
  }
  if (pageInfo?.net?.rtt >= 400 || (pageInfo?.net?.mbps && pageInfo.net.mbps < 1)) add(1, 'net', `Chromium estimates a slow connection: ~${pageInfo.net.rtt} ms round trip, ~${pageInfo.net.mbps} Mbps.`);

  // Channel switches and clicks
  const sw = A.switches.filter(s => !s.timeout);
  const stuck = A.switches.filter(s => s.timeout);
  if (stuck.length) add(2, 'discord', `${stuck.length} channel${stuck.length === 1 ? '' : 's'} didn't show messages within 8 s.`);
  if (sw.length) {
    const slow = sw.filter(s => s.ms >= 1500);
    const fetches = C.events.filter(e => e.k === 'flux' && e.type === 'LOAD_MESSAGES_SUCCESS' && e.fetch != null).map(e => e.fetch);
    let text = `Channel switches: ${sw.length}, median ${med(sw.map(s => s.ms))} ms, slowest ${Math.max(...sw.map(s => s.ms))} ms.`;
    if (slow.length) {
      const js = med(slow.map(s => s.js ?? 0)), draw = med(slow.map(s => s.draw ?? 0)), ms = med(slow.map(s => s.ms));
      const fetchMed = med(fetches);
      text += ` ${slow.length} took 1.5 s+ (median ${ms} ms: Discord's code ${js} ms, drawing ${draw} ms${fetchMed != null ? ', downloading messages ' + fetchMed + ' ms' : ''}).`;
      text += js > draw && js > (fetchMed ?? 0) ? ' Mostly Discord building the channel (busy channels with many embeds/images are the heaviest).' : draw > js ? ' Mostly drawing: graphics/driver or a very large window.' : fetchMed > js ? ' Mostly waiting for messages from Discord\'s servers.' : '';
      add(slow.length / sw.length > 0.3 ? 2 : 1, js >= draw ? 'discord' : 'gpu', text);
    } else add(0, 'info', text);
  }
  if (A.inputs.length) {
    const worst = Math.max(...A.inputs.map(i => i.ms));
    add(worst >= 1000 ? 2 : 1, 'discord', `${A.inputs.length} click${A.inputs.length === 1 ? '' : 's'}/key press${A.inputs.length === 1 ? '' : 'es'} took 200 ms+ to show a result (median ${med(A.inputs.map(i => i.ms))} ms, worst ${worst} ms).`);
  }

  // Errors
  const errs = Object.entries(A.errors);
  const asarErr = errs.filter(([ k ]) => k.startsWith('asar |'));
  if (asarErr.length) add(3, 'asar', `asar's code threw ${asarErr.length} different error${asarErr.length === 1 ? '' : 's'}: ${asarErr.slice(0, 2).map(([ k ]) => k.slice(7)).join(' / ')}`);

  // Mods, settings and asar state
  const mods = [ ...(pageInfo?.mods ?? []), ...(E.mods ?? []) ];
  if (mods.length) add(1, 'mod', 'Other Discord mods are installed: ' + mods.join('; ') + '. Mods can slow Discord down or conflict with asar; try without them to compare.');
  if (E.asar?.js && E.asar.js !== 'empty') add(0, 'setting', 'Custom JS is set in asar (Theming). Its code runs inside Discord.');
  if (E.safeMode) add(1, 'asar', `asar is in safe mode (${E.asar?.safeModeReason ?? 'earlier freeze'}): its optional speed-ups are off.`);
  if (E.pure) add(0, 'info', '"Test as stock Discord" was on: asar changed nothing in this recording, it only measured. Problems seen here are not caused by asar\'s changes.');
  if (pageInfo?.tab?.error) add(1, 'asar', 'asar couldn\'t add its tab to Discord settings: ' + pageInfo.tab.error);
  if (A.loader.estimated) add(0, 'info', `Loading screen: shown ${A.loader.shown} times, ${A.loader.estimated} with an estimated position, snapped onto Discord's chat box ${A.loader.snapped} times.`);
  if (C.dropped) add(0, 'info', `The recording was long: the oldest ${C.dropped} events were dropped from the timeline (totals above still count them).`);
  if (durMs < 15000) add(0, 'info', 'This recording is very short; record while the problem happens for best results.');
  return F.sort((a, b) => b.sev - a.sev);
};

const verdict = F => {
  const score = {};
  for (const f of F) if (f.sev >= 2) score[f.tag] = (score[f.tag] ?? 0) + f.sev;
  const top = Object.entries(score).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    asar: 'asar itself. Please send this file to the asar developer.',
    discord: 'Discord itself (its own code or app), not asar.',
    pc: 'this PC (other programs, memory or power), not asar.',
    net: 'the internet connection or Discord\'s servers, not asar.',
    gpu: 'graphics (driver or GPU settings), not asar\'s code.',
    mod: 'another Discord mod, not asar.',
    setting: 'a setting (see below).'
  }[top] ?? 'nothing in this recording points to a problem. If something felt slow, note the time and look it up in the timeline.';
};

const section = (title, lines) => [ '', title, '-'.repeat(title.length), ...lines ];
const LEGEND = [
  'Times are seconds since the recording started, then the PC\'s clock. "app" lines come from Discord\'s main process, "page" lines from Discord\'s window.',
  'c:xxxxxx / s:xxxxxx  a channel / server. Codes are random per recording and can\'t be turned back into IDs.',
  'sample      every 5 s: CPU use of the whole PC and of Discord (share of all cores), Discord\'s memory, free memory, and how late Discord\'s main process answered.',
  'frame       a frame that took 150 ms+ (Discord couldn\'t react or draw meanwhile), and whose code ran: Discord, asar, a mod, or drawing (style + layout + paint).',
  'input       a click or key press that took 200 ms+ until its result was on screen: waiting (main thread busy), running (event handlers), drawing.',
  'switch      a channel/DM opened by a click: time until the first message was on screen, where it went, and whether asar had preloaded it.',
  'req         a request that took 1 s+ or failed: queued (waiting on this PC), server (waiting for Discord), download.',
  'flux        Discord\'s own actions: connection opened/closed (gateway), voice state, screen-share streams, message loading (fetch = download time).',
  'freeze      Discord didn\'t respond for 3 s+. stall: Discord\'s main process didn\'t respond for 1 s+.',
  'loader      asar\'s loading screen: where it was placed (Discord\'s chat box, or an estimate), and if it moved.',
  'Sources of numbers: Chromium Long Animation Frames, Event Timing and Resource Timing APIs; Electron process metrics; Discord\'s action dispatcher.'
];

const report = C => {
  const t0 = C.startedAt, E = C.env ?? {}, A = C.agg, P = C.page.stats ?? {};
  const F = analyse(C);
  const L = [];
  const dur = (C.endedAt ?? Date.now()) - t0;
  L.push('asar debug log', '==============');
  L.push(`asar ${E.versions?.asar ?? global.asarVersion} · Discord ${E.versions?.channel ?? ''} ${E.versions?.discord ?? ''} · ${E.os?.version ?? E.os?.platform ?? process.platform} ${E.os?.release ?? ''} ${E.os?.arch ?? ''}`);
  L.push(`Recorded ${stamp(t0)} to ${clock(C.endedAt ?? Date.now())} (${Math.floor(dur / 60000)} min ${Math.round(dur / 1000) % 60} s) · ${C.how === 'launch' ? 'started together with Discord' : 'started from asar settings'} · ${C.events.length} events${C.dropped ? ` (+${C.dropped} older dropped)` : ''}`);
  L.push('Ended: ' + C.why);
  L.push('', 'This file explains what Discord and asar were doing while it was recorded. It contains no messages, names,', 'links or account details. Server and channel IDs are replaced with codes like c:3fa1c2 that only mean something here.');

  L.push(...section('SUMMARY', [ 'Most likely: ' + verdict(F), '', ...F.map(f => `${[ 'INFO', 'LOW ', 'MED ', 'HIGH' ][f.sev]}  [${TAGS[f.tag]}] ${f.text}`) ]));

  const g = (E.gpu ?? []).map(d => `${d.active ? '(active) ' : ''}${d.deviceString ?? ''} vendor ${d.vendorId?.toString?.(16) ?? '?'} device ${d.deviceId?.toString?.(16) ?? '?'}, driver ${d.driverVendor ?? ''} ${d.driverVersion ?? '?'}${d.driverDate ? ' (' + d.driverDate + ')' : ''}`);
  const pg = C.events.find(e => e.k === 'page');
  L.push(...section('THIS PC AND DISCORD', [
    `Versions:      ${kv(E.versions)}`,
    `System:        ${kv(E.os)} · locale ${E.locale ?? '?'}`,
    `CPU:           ${E.cpu?.model ?? '?'} · ${E.cpu?.threads ?? '?'} threads · ${E.cpu?.mhz ?? '?'} MHz`,
    `Memory:        ${E.ram?.totalGB ?? '?'} GB total, ${E.ram?.freeGB ?? '?'} GB free at start`,
    ...(g.length ? g.map((x, i) => (i ? '               ' : 'Graphics:      ') + x) : [ 'Graphics:      ?' ]),
    `GPU features:  ${kv(E.gpuFeatures)}`,
    `Displays:      ${(E.displays ?? []).map(d => `${d.size} @${d.hz} Hz x${d.scale}${d.internal ? ' (built-in)' : ''}`).join(' · ') || '?'}`,
    `Window:        ${kv(E.window)}${pg ? ` · page ${pg.size} at ${pg.dpr}x · ${pg.theme ?? ''}${pg.reducedMotion ? ' · reduced motion' : ''}` : ''}`,
    `Power:         ${E.battery ? 'on battery' : 'plugged in / desktop'}${E.thermal ? ' · thermal ' + E.thermal : ''}`,
    `Network:       proxy ${E.proxy ?? '?'}${pg?.net ? ` · Chromium estimate ${pg.net.type}, ~${pg.net.rtt} ms, ~${pg.net.mbps} Mbps` : ''}${pg ? ` · ${pg.online ? 'online' : 'OFFLINE'}` : ''}`,
    `Account size:  ${pg?.guilds ?? '?'} servers · page had ${pg?.dom ?? '?'} elements, ${pg?.heap ?? '?'} MB JS memory at start`,
    `Hardware acceleration (Discord): ${E.hwAccel === false ? 'OFF' : 'on'}`,
    `Discord settings: ${kv(E.discordSettings)}`,
    `Chromium flags from asar: ${(E.flags ?? []).join(' ') || '(none)'}`,
    `Launch arguments: ${(E.argv ?? []).join(' ') || '(none)'}`,
    `Installed in:  ${E.installedIn ?? '?'} · stock backup ${E.backup ? 'present' : 'missing'}`,
    `Other mods:    ${[ ...(pg?.mods ?? []), ...(E.mods ?? []) ].join('; ') || 'none found'}`,
    `Browser extensions: ${(E.extensions ?? []).join(', ') || 'none'}`,
    `Recent launches: ${(E.launches ?? []).join(', ') || '?'}`
  ]));

  let fh = [];
  if (C.live) try { fh = JSON.parse(fs.readFileSync(join(require('./paths').getUserData(), 'asar-freezes.json'), 'utf8')).slice(-8); } catch { }
  L.push(...section('ASAR', [
    `Settings:      ${kv(E.asar)}`,
    fh.length ? `Freeze history (all sessions, newest last): ${fh.map(f => `${String(f.at).slice(0, 16).replace('T', ' ')} ${f.kind} ${f.ms ? sec(f.ms) : ''}${f.reason ? ' ' + f.reason : ''}`).join(' · ')}` : 'Freeze history: none recorded',
    `Safe mode ${E.safeMode ? 'ON' : 'off'} · Test as stock Discord ${E.pure ? 'ON' : 'off'}`,
    pg ? `Found in Discord: ${kv(pg.found)} · settings tab ${pg.tab?.added ? 'added' : pg.tab?.error ? 'NOT added (' + pg.tab.error + ')' : 'not added yet when recording started (it is added when Discord settings first open)'}` : 'Discord page: no report (page not loaded or frozen).',
    pg ? `Speed-ups active in the page: ${Object.entries(pg.speedups ?? {}).filter(([ , v ]) => v).map(([ k ]) => k).join(', ') || 'none'}` : ''
  ].filter(Boolean)));

  const marks = C.live ? global.asarMarks ?? [] : [];
  if (marks.length && global.asarT0) L.push(...section('STARTUP (this launch)', marks.map(([ n, t ]) => `${pad(((t - global.asarT0) / 1000).toFixed(2) + ' s', 10)}${n}`)));

  // Numbers
  const N = [];
  const sw = A.switches.filter(s => !s.timeout);
  if (sw.length) {
    const ms = sw.map(s => s.ms), warm = sw.filter(s => s.warm || s.stored).map(s => s.ms), cold = sw.filter(s => !s.warm && !s.stored).map(s => s.ms);
    N.push(`Channel switches: ${sw.length} · median ${med(ms)} ms · 90% under ${pct(ms, 0.9)} ms · slowest ${Math.max(...ms)} ms` + (warm.length && cold.length ? ` · preloaded/in memory ${med(warm)} ms vs not ${med(cold)} ms` : ''));
    const byType = {};
    for (const s of sw) (byType[s.ty ?? '?'] ??= []).push(s.ms);
    N.push('  by type: ' + Object.entries(byType).map(([ k, v ]) => `${k} ${v.length}× median ${med(v)} ms`).join(' · '));
  }
  if (A.inputs.length) {
    const byOn = {};
    for (const i of A.inputs) (byOn[i.on] ??= []).push(i.ms);
    N.push(`Slow clicks/keys (200 ms+): ${A.inputs.length} · ` + Object.entries(byOn).map(([ k, v ]) => `${k} ${v.length}× median ${med(v)} ms`).join(' · '));
  }
  if (A.frames.n) N.push(`Slow frames (150 ms+): ${A.frames.n}, ${sec(A.frames.ms)} total · ${owners(Object.fromEntries(Object.entries(A.frames.by).map(([ k, v ]) => [ k, Math.round(v) ])))}`);
  const S = A.samples;
  if (S.length) {
    const pcs = S.filter(s => s.pc != null).map(s => s.pc), dc = S.map(s => s.discord), mbs = S.map(s => s.mb), fr = S.map(s => s.freeMB), lag = S.map(s => s.lag);
    N.push(`CPU (whole PC): median ${med(pcs) ?? '?'}%, max ${pcs.length ? Math.max(...pcs) : '?'}% · Discord: median ${med(dc)}%, max ${Math.max(...dc)}%`);
    const procs = {};
    for (const s of S) for (const [ k, v ] of Object.entries(s.procs ?? {})) { const p = procs[k] ??= { cpu: [], mb: [] }; p.cpu.push(v.cpu); p.mb.push(v.mb); }
    N.push('  Discord processes: ' + Object.entries(procs).map(([ k, v ]) => `${k} cpu ${med(v.cpu)}%/max ${Math.max(...v.cpu)}% ram ${med(v.mb)}/${Math.max(...v.mb)} MB`).join(' · '));
    N.push(`Memory: Discord median ${med(mbs)} MB, max ${Math.max(...mbs)} MB · PC free: min ${Math.min(...fr)} MB · main process lag: median ${med(lag)} ms, max ${Math.max(...lag)} ms`);
  }
  const net = Object.entries(P.net ?? {});
  if (net.length) N.push('Network by kind: ' + net.sort((a, b) => b[1].n - a[1].n).map(([ k, v ]) => `${k} ${v.n} req ${v.mb} MB avg ${v.avgMs} ms${v.slow ? ' slow ' + v.slow : ''}${v.failed ? ' failed ' + v.failed : ''}${v.r429 ? ' rate-limited ' + v.r429 : ''}${v.cached ? ' cached ' + v.cached : ''}`).join(' · '));
  if (P.flux?.length) {
    N.push('Discord actions by total time (count, total, slowest):');
    for (const [ k, n, ms, max ] of P.flux.slice(0, 15)) N.push(`  ${pad(k, 44)} ${pad(n + '×', 8)} ${pad(ms + ' ms', 10)} max ${max} ms`);
  }
  if (Object.keys(A.gateway.codes).length || A.gateway.open) N.push(`Gateway: opened ${A.gateway.open}× · closed ${A.gateway.closed}×`);
  if (Object.keys(A.rtc).length) N.push('Voice connection states: ' + kv(A.rtc));
  if (A.picker.length) N.push(`Screen-share picker: ${A.picker.length} preview requests · median ${med(A.picker.map(p => p.ms ?? 0))} ms · ${A.picker.filter(p => p.cached || p.shared).length} answered without capturing`);
  if (P.dropped) N.push(`Page events dropped (queue full): ${P.dropped}`);
  if (N.length) L.push(...section('NUMBERS', N));

  const errs = Object.entries(A.errors).sort((a, b) => b[1] - a[1]);
  const pageErrs = (P.errs ?? []).filter(([ k ]) => !A.errors[k]);
  if (errs.length || pageErrs.length) L.push(...section('ERRORS (owner | message, count)', [ ...errs, ...pageErrs ].slice(0, 40).map(([ k, n ]) => `${n}×  ${k}`)));

  const diag = global.asarDiag;
  if (diag && C.live) {
    const d = { ...diag };
    delete d.slow;
    L.push(...section('ASAR INTERNALS (this session)', [ JSON.stringify(d), `freezes: ${JSON.stringify(global.asarFreezes ? { count: global.asarFreezes.count, longest: global.asarFreezes.longest, gpu: global.asarFreezes.gpu } : null)} · main stalls: ${JSON.stringify(global.asarMainStalls ?? null)} · picker: ${JSON.stringify(global.asarPicker ?? null)}` ]));
  }

  L.push(...section('TIMELINE', [ ...[ ...C.events ].sort((a, b) => a.t - b.t || a.n - b.n).map(e => line(e, t0)) ]));
  L.push(...section('HOW TO READ THIS', LEGEND));
  return scrubText(L.join('\n')) + '\n';
};

const writeReport = (C, kind) => {
  fs.mkdirSync(dir(), { recursive: true });
  const d = new Date(C.startedAt || Date.now());
  const ts = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '_' + clock(d.getTime()).replace(/:/g, '-');
  let name = `asar-log-${ts}${kind === 'snapshot' ? '-partial' : kind === 'recovered' ? '-unfinished' : ''}.txt`;
  fs.writeFileSync(join(dir(), name), report(C));
  // Keep the newest logs only
  try {
    const all = fs.readdirSync(dir()).filter(f => /^asar-log-[\w-]+\.txt$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP_LOGS))) fs.rmSync(join(dir(), f), { force: true });
  } catch { }
  if (kind !== 'recovered') R.lastLog = name;
  return name;
};

exports.report = () => report({ ...R, live: true, endedAt: Date.now(), why: 'preview' }); // tests
