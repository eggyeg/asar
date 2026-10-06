const { get } = require('https');
const fs = require('original-fs'); // Use original-fs, not Electron's asar-patched fs
const { join } = require('path');
const { createHash } = require('crypto');

const download = (url, hops = 0) => new Promise((res, rej) => {
  if (hops > 5) return rej(new Error('Too many redirects'));

  const req = get(url, { headers: { 'User-Agent': 'asar/' + asarVersion } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      return download(new URL(r.headers.location, url).toString(), hops + 1).then(res, rej);
    }
    if (r.statusCode !== 200) {
      r.resume();
      return rej(new Error('HTTP ' + r.statusCode));
    }

    const data = [];
    r.on('data', d => data.push(d));
    r.on('end', () => res(Buffer.concat(data)));
    r.on('error', rej);
  });

  req.setTimeout(30000, () => req.destroy(new Error('Timed out')));
  req.on('error', rej);
});

const hash = b => createHash('sha256').update(b).digest('hex');

// Updates asar from the URL set in settings, defaulting to the latest build on rottenvia/asar's `build` branch
// (published by CI, no GitHub Release needed). Never pulls from upstream OpenAsar, which would silently replace this build.
const DEFAULT_URL = 'https://raw.githubusercontent.com/rottenvia/asar/build/app.asar';

const check = async url => {
  if (!/^https:\/\//.test(url)) return 'Update URL must start with https://';

  log('AsarUpdate', 'Checking', url);
  let buf;
  try {
    buf = await download(url);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return 'No build found at the update URL (HTTP 404)';
    return 'Could not reach the update server: ' + e.message;
  }

  if (buf.length < 1024 || buf.readUInt32LE(0) !== 4) return 'Downloaded file is not an asar archive';

  const target = join(__filename, '..');
  let cur;
  try { cur = fs.readFileSync(target); } catch { }
  if (cur && hash(cur) === hash(buf)) return global.asarPendingRestart ? 'Update installed - restart Discord to apply' : 'Already up to date';

  // Write to a temp file then swap in, so a failed/partial download can never leave a corrupt app.asar
  const tmp = target + '.new';
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, target);
  } catch {
    fs.writeFileSync(target, buf);
    fs.rmSync(tmp, { force: true });
  }

  global.asarPendingRestart = true;
  log('AsarUpdate', 'Updated');
  return 'Updated - restart Discord to apply';
};

// Every check is recorded so the settings window can show when it last ran and what happened
// The repository moved from eggyeg/asar to rottenvia/asar: an update URL typed in with the old name follows it
const moved = u => String(u).replace(/^(https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/)eggyeg\/asar\//i, '$1rottenvia/asar/');

module.exports = async (url = oaConfig.updateUrl || DEFAULT_URL) => {
  url = moved(url);
  let result;
  try {
    result = await check(url);
  } catch (e) {
    result = 'Update failed: ' + (e?.message ?? e);
  }

  try {
    settings.set('asarLastUpdate', { time: Date.now(), result, url });
    settings.save();
  } catch { }

  return result;
};

module.exports.DEFAULT_URL = DEFAULT_URL;
