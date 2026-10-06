// asar's own updater
//
// Checking is nearly free: asar asks for a ~300 byte version.json next to the build with the ETag it got last time,
// so GitHub answers "304 Not Modified" (no body) until a new build is published. That runs in Discord's main process
// (never in its page), at start, every 20 minutes and when you come back to Discord after 5+ minutes.
// A new build is downloaded in the background, checked (asar header + SHA-256 from version.json) and kept next to
// app.asar as app.asar.update. Discord's running app.asar is never touched: the update is put in place when you
// restart from the popup, when Discord quits, or during the splash of the next start.
const { app } = require('electron');
const fs = require('original-fs'); // Use original-fs, not Electron's asar-patched fs
const { join } = require('path');
const { createHash } = require('crypto');

const DEFAULT_URL = 'https://raw.githubusercontent.com/rottenvia/asar/build/app.asar';
const INTERVAL = Math.max(5000, Number(process.env.ASAR_UPDATE_INTERVAL) || 20 * 60 * 1000);
const FOCUS_AFTER = Math.min(INTERVAL, 5 * 60 * 1000);

// The repository moved from eggyeg/asar to rottenvia/asar: an update URL typed in with the old name follows it
const moved = u => String(u).replace(/^(https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/)eggyeg\/asar\//i, '$1rottenvia/asar/');
const asarUrl = () => moved(oaConfig.updateUrl || DEFAULT_URL);
const allowed = u => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u); // http only for local testing
const versionUrl = u => /app\.asar(\?.*)?$/.test(u) ? u.replace(/app\.asar(\?.*)?$/, 'version.json') : null;

const target = join(__filename, '..'); // the app.asar this file runs from
const pendingPath = target + '.update';

const hash = b => createHash('sha256').update(b).digest('hex');
const isAsar = b => b && b.length > 1024 && b.readUInt32LE(0) === 4;
const versionIn = b => /asarVersion\s*=\s*["']([\w.+-]{1,40})["']/.exec(b.toString('latin1'))?.[1] ?? null;
const debug = () => { try { return require('./debug'); } catch { return null; } };

let own = null;
const ownHash = () => {
  if (own) return own;
  try { own = hash(fs.readFileSync(target)); } catch { own = 'unknown'; }
  return own;
};
const pendingHash = () => { try { const b = fs.readFileSync(pendingPath); return isAsar(b) ? hash(b) : null; } catch { return null; } };

// What the popup and the settings window show
const S = global.asarUpd = { status: 'idle', current: asarVersion, version: null, notes: [], progress: 0, checkedAt: 0, error: null, dismissed: false };
const pageState = () => ({ status: S.status, current: S.current, version: S.version, notes: S.notes, progress: S.progress, dismissed: S.dismissed });
exports.state = pageState;

// --- HTTP ---
const get = (url, { headers = {}, timeout = 20000, max = 64 * 1024 * 1024, onProgress } = {}, hops = 0) => new Promise((res, rej) => {
  if (hops > 5) return rej(new Error('Too many redirects'));
  const lib = url.startsWith('http://') ? require('http') : require('https');
  const req = lib.get(url, { headers: { 'User-Agent': 'asar/' + asarVersion, ...headers } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.statusCode !== 304 && r.headers.location) {
      r.resume();
      const next = new URL(r.headers.location, url).toString();
      if (!allowed(next)) return rej(new Error('Redirected to an address that isn\'t allowed'));
      return get(next, { headers, timeout, max, onProgress }, hops + 1).then(res, rej);
    }
    if (r.statusCode !== 200) { r.resume(); return res({ status: r.statusCode, headers: r.headers, body: null }); }
    const total = Number(r.headers['content-length']) || 0, data = [];
    let got = 0;
    r.on('data', d => {
      got += d.length;
      if (got > max) return req.destroy(new Error('Download too large'));
      data.push(d);
      if (onProgress && total) onProgress(got / total);
    });
    r.on('end', () => res({ status: 200, headers: r.headers, body: Buffer.concat(data) }));
    r.on('error', rej);
  });
  req.setTimeout(timeout, () => req.destroy(new Error('Timed out')));
  req.on('error', rej);
});

const readInfo = b => {
  try {
    const j = JSON.parse(b.toString('utf8'));
    if (!/^[0-9a-f]{64}$/.test(j.sha256)) return null;
    return {
      version: String(j.version ?? '').slice(0, 40) || null,
      sha256: j.sha256,
      size: Number(j.size) || 0,
      notes: (Array.isArray(j.notes) ? j.notes : []).slice(0, 6).map(n => String(n).slice(0, 160))
    };
  } catch { return null; }
};

// version.json, asked with the ETag from last time so an unchanged file costs a 304 and no body
const fetchInfo = async (vurl, timeout) => {
  const cache = settings.get('asarUpdInfo');
  const same = cache && cache.url === vurl && cache.info;
  const r = await get(vurl, { headers: same && cache.etag ? { 'If-None-Match': cache.etag } : {}, timeout, max: 65536 });
  if (r.status === 304 && same) return { info: cache.info, fresh: false };
  if (r.status === 200) {
    const info = readInfo(r.body);
    if (!info) throw new Error('version.json is not valid');
    settings.set('asarUpdInfo', { url: vurl, etag: r.headers.etag ?? null, info });
    return { info, fresh: true };
  }
  if (r.status === 404) return { info: null };
  throw new Error('HTTP ' + r.status);
};

// Download the build, check it, keep it as app.asar.update
const stage = async (url, info, onProgress) => {
  const r = await get(url, { timeout: 60000, onProgress });
  if (r.status === 404) throw new Error('No build found at the update URL (HTTP 404)');
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const buf = r.body;
  if (!isAsar(buf)) throw new Error('Downloaded file is not an asar archive');
  const h = hash(buf);
  if (info?.sha256 && h !== info.sha256) throw new Error('Download was damaged (checksum mismatch). It will be tried again later.');
  if (h === ownHash()) return null; // it's what's running
  const tmp = pendingPath + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, pendingPath);
  return { version: info?.version ?? versionIn(buf), notes: info?.notes ?? [], sha256: h };
};

const record = result => {
  try { settings.set('asarLastUpdate', { time: Date.now(), result, url: asarUrl() }); settings.save(); } catch { }
  debug()?.ev('update', { result });
};

// --- Telling Discord's page ---
let toPage = null;
exports.onState = fn => { toPage = fn; };
const notify = () => { try { toPage?.(pageState()); } catch { } };

const ready = up => {
  const changed = S.version !== up.version || S.status !== 'ready';
  Object.assign(S, { status: 'ready', version: up.version, notes: up.notes ?? [], progress: 1, error: null });
  if (changed) {
    S.dismissed = false;
    record('Update ready: ' + (up.version ?? 'new build') + ' (restart to use it)');
    notify();
  }
};

// --- Checking ---
let busy = null;
// why: 'start' | 'timer' | 'focus' | 'manual'. Builds published without a version.json (custom update URLs) are only
// downloaded on 'start' and 'manual', never by the timer.
const check = why => busy ??= (async () => {
  S.checkedAt = Date.now();
  const url = asarUrl();
  if (!allowed(url)) { S.error = 'Update URL must start with https://'; return S.error; }
  try {
    const vurl = versionUrl(url);
    const got = vurl ? await fetchInfo(vurl, why === 'manual' ? 15000 : 10000) : { info: null };
    const info = got.info;
    if (info) {
      if (info.sha256 === ownHash()) {
        if (S.status !== 'ready') S.status = 'idle';
        if (why === 'manual' || why === 'start') record('Already up to date');
        return 'Already up to date';
      }
      if (S.status === 'ready' && info.sha256 === pendingHash()) return 'Update ready: ' + S.version + ' (restart Discord to use it)';
      if (S.status !== 'ready') S.status = 'downloading';
      S.progress = 0;
      const up = await stage(url, info, p => { S.progress = p; });
      if (!up) { S.status = 'idle'; return 'Already up to date'; }
      ready(up);
      return 'Update ready: ' + up.version + ' (restart Discord to use it)';
    }
    if (why === 'timer' || why === 'focus') return 'No version.json; checked at start only';
    const up = await stage(url, null);
    if (!up) { record('Already up to date'); return 'Already up to date'; }
    ready(up);
    return 'Update ready: ' + (up.version ?? 'new build') + ' (restart Discord to use it)';
  } catch (e) {
    if (S.status === 'downloading') S.status = 'idle';
    S.error = String(e?.message ?? e);
    const r = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|Timed out/.test(S.error) ? 'Could not reach the update server: ' + S.error : 'Update failed: ' + S.error;
    if (why === 'manual' || why === 'start') record(r);
    return r;
  }
})().finally(() => { busy = null; });

exports.check = check;
exports.checkNow = () => check('manual');

// Every 20 minutes, and when Discord gets focus after 5+ minutes. Nothing runs in Discord's page for this.
let scheduled = false;
exports.schedule = win => {
  if (scheduled || oaConfig.autoupdate === false) return;
  scheduled = true;
  check('start'); // usually a 304 (the splash already asked): downloads what the splash found but didn't install
  setInterval(() => check('timer'), INTERVAL).unref?.();
  win?.on?.('focus', () => { if (Date.now() - S.checkedAt > FOCUS_AFTER) check('focus'); });
};

// --- Installing ---
// Put app.asar.update in place. Only done right before Discord exits or restarts (or at the very start, followed by a
// restart), because Discord keeps reading files from the running app.asar.
const apply = () => {
  let buf;
  try { buf = fs.readFileSync(pendingPath); } catch { return false; }
  if (!isAsar(buf)) { try { fs.rmSync(pendingPath, { force: true }); } catch { } return false; }
  try {
    fs.renameSync(pendingPath, target);
  } catch { // Windows: the running app.asar can't be replaced, but it can be overwritten
    try { fs.writeFileSync(target, buf); fs.rmSync(pendingPath, { force: true }); } catch (e) { log('AsarUpdate', 'Install failed', e?.message); return false; }
  }
  record('Updated to ' + (versionIn(buf) ?? 'new build'));
  return true;
};
exports.apply = apply;

// "Restart now" in the popup or settings
exports.restart = () => {
  apply();
  try { require('./debug').finishNow('Discord restarted to install an asar update'); } catch { }
  if (!process.env.ASAR_NO_RELAUNCH) app.relaunch();
  app.exit(0);
};

exports.dismiss = () => { S.dismissed = true; };

// Discord is quitting: next start runs the new version
app.on('will-quit', () => { if (S.status === 'ready') apply(); });

// --- At start, during the splash ---
// An update downloaded last time (or found now) is installed before Discord's core loads, then Discord restarts once.
// Guarded so a build that can't be installed never causes a restart loop.
exports.boot = () => {
  if (oaConfig.autoupdate === false || process.env.ASAR_SMOKE) return Promise.resolve(null);
  const p = pendingHash();
  if (p && p !== ownHash()) return Promise.resolve({ pending: true });
  if (p) try { fs.rmSync(pendingPath, { force: true }); } catch { }
  const url = asarUrl(), vurl = versionUrl(url);
  if (!vurl || !allowed(url)) return Promise.resolve(null);
  S.checkedAt = Date.now();
  return fetchInfo(vurl, 4000).then(({ info }) => info && info.sha256 !== ownHash() ? { info } : null, () => null);
};

const guardOk = sha => {
  const g = settings.get('asarBootInstall');
  return !(g && g.sha === sha && g.n >= 2 && Date.now() - g.at < 30 * 60 * 1000);
};

// Download (if needed) and install with progress on the splash, then restart. Resolves false if it didn't restart.
exports.installAtBoot = async (found, progress) => {
  try {
    let sha = found.pending ? pendingHash() : found.info.sha256;
    if (!guardOk(sha)) return false;
    if (!found.pending) {
      progress({ phase: 'download', version: found.info.version, progress: 0 });
      const up = await stage(asarUrl(), found.info, p => progress({ phase: 'download', version: found.info.version, progress: p }));
      if (!up) return false;
      sha = up.sha256;
    }
    let version = null;
    try { version = versionIn(fs.readFileSync(pendingPath)); } catch { }
    progress({ phase: 'install', version, progress: 1 });
    const g = settings.get('asarBootInstall');
    settings.set('asarBootInstall', { sha, n: g?.sha === sha ? g.n + 1 : 1, at: Date.now() });
    settings.save();
    if (!apply()) return false;
    let now;
    try { now = hash(fs.readFileSync(target)); } catch { }
    if (now !== sha) return false;
    progress({ phase: 'restart', version, progress: 1 });
    await new Promise(r => setTimeout(r, 450)); // let the splash show "Restarting" for a moment
    try { require('./debug').finishNow('Discord restarted to install an asar update'); } catch { }
    if (!process.env.ASAR_NO_RELAUNCH) app.relaunch();
    app.exit(0);
    return true;
  } catch (e) {
    log('AsarUpdate', 'Install at start failed', e?.message);
    return false;
  }
};

exports.DEFAULT_URL = DEFAULT_URL;
exports.moved = moved;
