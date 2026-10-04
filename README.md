# asar

[![Nightly](https://github.com/eggyeg/asar/actions/workflows/nightly.yml/badge.svg)](https://github.com/eggyeg/asar/actions/workflows/nightly.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

A faster, self-contained Discord desktop `app.asar`. It's a fork of [OpenAsar](https://github.com/GooseMod/OpenAsar) (nightly 5a44615).

## Install

**Windows:** download [`install.bat`](https://github.com/eggyeg/asar/raw/main/install.bat) (right-click → Save link as) and double-click it. Or paste this into PowerShell:

```powershell
irm https://raw.githubusercontent.com/eggyeg/asar/main/install.ps1 | iex
```

The installer:
- finds Discord Stable, PTB and Canary;
- closes Discord;
- backs up Discord's original `app.asar` once;
- downloads the latest asar and checks it's a valid asar file;
- installs it into every installed Discord version;
- starts Discord again.

Run it again any time to update. **`uninstall.bat`** (or `install.bat -Uninstall`) puts stock Discord back.

**Linux / macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/eggyeg/asar/main/install.sh | sh
```

Add `-s uninstall` after `sh` to remove it. Flatpak and Snap installs are read-only and can't be modded.

After that, asar keeps itself up to date.

## What's different from OpenAsar

**Feel**
- **Instant UI** (on by default): Discord's animations for modals, popouts and channel switches are turned off. asar does this through Chromium's reduced-motion setting, which Discord already respects, plus near-zero CSS transitions.
- **No blur** (on by default): removes `backdrop-filter` blur, one of the most expensive effects to composite.
- **High priority** (Windows, on by default): Discord's main, renderer and GPU processes run at *above normal* priority, so other busy apps don't starve it.
- **No idle work:** there are no timers polling Discord's page. OpenAsar searched the settings DOM every 800 ms forever, and asar 1.0 did a text scan every second whenever it couldn't find the entry.
- **Startup time is measured every launch** and shown in Settings → Performance as a chart of your last 10 launches.

All three toggles are in asar settings → Performance.

**Fixes**
- **Settings UI no longer breaks.** OpenAsar downloaded its splash and settings UI from `cdn.openasar.dev` every time. asar bundles both inside `app.asar` and loads them from disk. They work offline and a remote change can't break them.
- **Real "asar" tab in Discord's settings.** Discord's 2025+ settings are built from a layout tree (root key `$Root`). asar adds its own section to that tree through Discord's webpack modules, the same way Vencord and BetterDiscord add theirs. It doesn't depend on class names or your Discord language. Clicking the tab, even when it's already selected, opens asar settings. If the layout tree ever changes, asar falls back to a clickable line under Discord's version info.
- **Ctrl + Alt + O** (Cmd + Option + O on macOS) opens settings from anywhere in Discord. It matches the physical O key, so it works on any keyboard layout (on Ukrainian or Russian layouts that key types `щ`).
- **Nothing pops up at launch.** Discord opens normally. The asar settings window only appears when you open it, and it stays attached to Discord's window.
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

## Manual install

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
