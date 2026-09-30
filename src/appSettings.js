const fs = require('fs');

class Settings {
  constructor(path) {
    this.path = path;
    this.store = this.read() ?? {};
    this.dirty = new Set();
    this.mod = this.getMod();
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { }
  }

  getMod() {
    try { return fs.statSync(this.path).mtimeMs; } catch { }
  }

  get(k, d) {
    return this.store[k] ?? d;
  }

  set(k, v) {
    this.store[k] = v;
    this.dirty.add(k);
  }

  save() {
    try {
      // OpenAsar silently dropped the save if the file changed on disk, which lost settings
      // (eg: the first-run config window re-opening every launch). Merge our changes into the disk copy instead.
      const m = this.getMod();
      if (this.mod && m && m !== this.mod) {
        const disk = this.read();
        if (disk) {
          for (const k of this.dirty) disk[k] = this.store[k];
          this.store = disk;
        }
      }

      const data = JSON.stringify(this.store, null, 2);
      const tmp = this.path + '.tmp';
      try { // Atomic write so a crash mid-save can't corrupt settings.json
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, this.path);
      } catch {
        fs.writeFileSync(this.path, data);
      }

      this.dirty.clear();
      this.mod = this.getMod();
    } catch (e) {
      log('Settings', e);
    }
  }
}

let inst;
exports.getSettings = () => inst = inst ?? new Settings(require('path').join(require('./paths').getUserData(), 'settings.json'));
