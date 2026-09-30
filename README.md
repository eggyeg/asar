# asar

[![Nightly](https://github.com/eggyeg/asar/actions/workflows/nightly.yml/badge.svg)](https://github.com/eggyeg/asar/actions/workflows/nightly.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

A faster, self-contained Discord desktop `app.asar`. It's a fork of [OpenAsar](https://github.com/GooseMod/OpenAsar) (nightly 5a44615).

**[Download the latest app.asar](https://github.com/eggyeg/asar/raw/build/app.asar)**

## What's different from OpenAsar

**Fixes**
- **Settings UI no longer breaks.** OpenAsar downloaded its splash and settings UI from `cdn.openasar.dev` every time. asar bundles both inside `app.asar` and loads them from disk. They work offline and a remote change can't break them.
- **The settings entry survives Discord redesigns.** OpenAsar found Discord's "Advanced" item by hashed class names. When Discord's settings redesign removed them, it threw (`null.cloneNode`) and the entry disappeared. asar tries several strategies and never throws. **Ctrl + Alt + O** (Cmd + Option + O on macOS) always opens settings.
- **Opening Discord again brings the window back.** Launching Discord while it's minimized or in the tray now restores and focuses the existing window. The settings window also un-minimizes when you reopen it.
- **Settings save reliably.** OpenAsar dropped a settings save if `settings.json` had changed on disk, so its first-run window could reopen on every launch. asar merges its changes into the file on disk and writes atomically.
- IPC handlers are registered once. OpenAsar added a new set every time the settings window opened.
- asar's own update is written to a temp file and then swapped in, so a failed download can't corrupt `app.asar`.
- `CalculateNativeWinOcclusion` is off by default. That Chromium feature is a known cause of blank or frozen Electron windows after restoring from minimized on Windows.

**Optimizations**
- The V8 compile cache (`module.enableCompileCache`, Electron 33+) caches compiled bytecode for Discord's core. Launches after the first one skip re-parsing it.
- Splash and settings windows load with zero network requests.
- The injected main-window script is built once per launch. OpenAsar re-read and re-templated it on every page load.
- Theme sync runs every 60s instead of every 10s, plus when Discord is hidden. It reads both the old and the redesigned Discord color variables.
- Chromium flags are merged and de-duplicated properly. Flag values containing `=` are handled, and so is `--js-flags`.
- Presets: **Performance** (GPU raster, zero-copy, no background throttling), **Balanced**, **Battery**.
- Every JS/HTML file is minified with esbuild and html-minifier.
- Tracking block now also covers Sentry (`*.sentry.io`, `/error-reporting-proxy/`), both v7 and v8 clients.

**UI**
- New splash with a determinate progress bar, a retry countdown, and Skip/Quit buttons that appear if updates stall.
- New settings window with General, Performance, Privacy, Theming, Advanced and About tabs.
- A **Restore stock Discord** button that puts back `app.asar.backup` and keeps asar as `app.asar.asar-fork`.
- Self-updates from this repo's [`build` branch](https://github.com/eggyeg/asar/tree/build) a few seconds after launch and shows a notification when it installs an update. Settings → Advanced shows when it last checked and the result. You can turn it off or point it at another URL there. asar never pulls from upstream OpenAsar, which would replace this build.

Existing OpenAsar settings (CSS, JS, preset, toggles) are migrated automatically.

## Install

1. Fully quit Discord (right-click the tray icon, then Quit).
2. Open Discord's `resources` folder:
   - Windows: `%localappdata%\Discord\app-1.0.XXXX\resources` (use the newest `app-` folder)
   - Linux: `/opt/discord/resources` or `/usr/share/discord/resources` (varies by distro)
   - macOS: `/Applications/Discord.app/Contents/Resources`
3. If there's no `app.asar.backup` yet, rename Discord's `app.asar` to `app.asar.backup`. It's already there if you used OpenAsar before.
4. Copy the [new `app.asar`](https://github.com/eggyeg/asar/raw/build/app.asar) in and start Discord.

Discord host updates keep asar automatically. The updater copies it into the new `app-` folder.

## Uninstall

In asar settings (**Ctrl + Alt + O**), go to Advanced → **Restore stock Discord**. Or by hand: delete `app.asar` and rename `app.asar.backup` back to `app.asar`.

## Build

```
npm ci
npm run build   # -> dist/app.asar
```

Every push to `main` is built by GitHub Actions and smoke-tested against the real Discord Linux client (stable and canary). If both pass, the build is pushed to the [`build` branch](https://github.com/eggyeg/asar/tree/build) (where asar updates itself from) and the [`nightly` release](https://github.com/eggyeg/asar/releases/tag/nightly).

To check which build you're on, open asar settings → About. The version ends with the commit it was built from, e.g. `1.0.0-abc1234`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ASAR_QUICKSTART=1` | Skip the splash wait (same as the Quickstart toggle) |
| `ASAR_NOSTART=1` | Run the updater but don't start Discord's core |
| `ASAR_SMOKE=1` | Print `ASAR_SMOKE_OK` and exit once Discord has fully started (used by CI) |

The older `OPENASAR_*` names still work.

## License

AGPL-3.0, same as OpenAsar. Credit to [GooseMod/OpenAsar](https://github.com/GooseMod/OpenAsar) and its contributors.
