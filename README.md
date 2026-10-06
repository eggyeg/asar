# asar

[![Nightly](https://github.com/rottenvia/asar/actions/workflows/nightly.yml/badge.svg)](https://github.com/rottenvia/asar/actions/workflows/nightly.yml) [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

A faster, self-contained Discord desktop `app.asar`. It's a fork of [OpenAsar](https://github.com/GooseMod/OpenAsar) (nightly 5a44615).

## Install

**Windows:** download [`asar-setup.bat`](https://github.com/rottenvia/asar/raw/main/asar-setup.bat) (right-click → Save link as) and double-click it. Or paste this into PowerShell:

```powershell
irm https://raw.githubusercontent.com/rottenvia/asar/main/install.ps1 | iex
```

The installer:
- finds Discord Stable, PTB and Canary;
- closes Discord;
- backs up Discord's original `app.asar` once;
- downloads the latest asar and checks it's a valid asar file;
- installs it into every installed Discord version;
- starts Discord again.

Run it again any time to update. **`uninstall.bat`** (or `asar-setup.bat -Uninstall`) puts stock Discord back.

**Linux / macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/rottenvia/asar/main/install.sh | sh
```

Add `-s uninstall` after `sh` to remove it. Flatpak and Snap installs are read-only and can't be modded.

After that, asar keeps itself up to date.

## What's different from OpenAsar

**Speed-ups** (Settings → Performance, each can be turned off)
- **Preload channels on hover:** when the pointer rests on a channel for 150 ms, asar asks Discord to fetch its messages, the same call Discord makes on click. It only does this for text channels Discord hasn't loaded, at most once per 500 ms and once per channel every 2 minutes. In the test client a hovered channel opened in about 60 ms, versus about 630 ms with a 600 ms network delay.
- **Keep top channels ready:** asar counts which channels you open (IDs only, stored in Discord's `settings.json`). It keeps up to 10 of them loaded: your top 4 in the current server plus your top overall. That happens at start, on server switch and every 5 minutes, one request every 0.8 s, never while Discord is hidden, and only for channels Discord doesn't already have in memory. In the test client, kept channels opened in 17 to 24 ms versus about 640 ms cold, with zero dropped frames while loading in the background.
- **Instant switching:** Discord builds a channel's whole view in one go, and nothing else runs until it's done, including your next click. asar takes channel clicks first. It highlights the channel and shows the loading screen, or a thin progress line if Discord already has the messages, lets that reach the screen (one frame), then hands the click to Discord. Clicks that arrive before that are merged, so Discord only builds the newest channel. When you switch quickly, asar waits a bit longer (110 ms) to merge more. Test client, three clicks 60 ms apart on heavy channels: built 3 channels in 1227 ms before, 2 channels in 960 ms with instant switching, with feedback on the first frame. The cost is about one frame (about 16 to 40 ms) before Discord starts building.
- **One clean selection:** on click, asar copies the look of Discord's current sidebar selection (background and text colours) onto the clicked row and clears it from the old one. The plain look comes from a row that isn't hovered. So while Discord builds the channel and the page can't redraw, the sidebar already shows exactly one selection. Afterwards asar removes only its own temporary styles and Discord's state takes over.
- **Freeze-proof animations:** every loading animation (spinner, progress line, dots, letter wave, typing, shimmer) uses only transform and opacity, so the GPU keeps it moving while Discord's page is busy. Tested by capturing frames during a 2.6 s freeze: the 1.8 wave and shimmer stopped; 1.9 keeps all of them moving.
- **Where the time goes:** each channel switch is split into Discord's code versus drawing (Chromium long-animation-frame timing) and shown in Settings → Performance. Tested and rejected: `content-visibility` on off-screen messages. It gave no consistent speed-up and broke scrolling to the newest message.
- **Loading screen:** if a channel, thread, DM or server takes longer than 120 ms, the message area shows a calm skeleton loading screen with the channel name until the messages (or an empty channel) are there. It sits outside Discord's React tree over the chat box, with one shimmer on a single layer and its own scoped styles. It never stays up longer than 8 s. Its position follows Discord's chat box: when there's no chat on screen yet (Friends page, the first chat after starting Discord) it's estimated from the page right of the channel list minus that page's header, then snapped onto Discord's chat box in the same frame Discord creates it (1.9 guessed from the channel list and could sit about 50 px too low). The status line under the title animates in one of four styles, a different one each time: cycling dots ("Loading." → "..." and back), a l-o-a-d-i-n-g letter wave, typing, or a shimmer. Labels match what you open: "Chat with Alex" for DMs, group chat names, "› thread" for threads, "#channel" for channels.
- **Faster settings:** while Discord is idle, asar runs the code that builds Discord's settings and downloads the pieces it would load on first open. It wraps Discord's `openUserSettings` (found like Vencord's SettingsRouter) so "Opening settings" appears the moment you open them, by gear, Ctrl+, or a menu, and settings open one frame later. Open time is measured and shown in Settings → Performance.
- **Free memory in the background:** after Discord has been hidden (minimized, in the tray or behind a game) for 2 minutes, asar calls Discord's own `processUtils.purgeMemory`, at most every 30 minutes and never while you're looking at Discord.
- **Warm up connections:** `session.preconnect` to Discord's API, CDN and media servers at start and on focus, so the first requests after a click skip the TLS handshake.
- **Faster screen-share picker:** Go Live previews are capped at 480×270, the size the picker shows. Identical requests in flight are shared, and repeats within 1.5 s reuse the last capture. PNG encoding in the main process for 10 sources: 873 ms at 1920×1080 versus 51 ms at 480×270.
- **Right now panel:** median channel-switch time (preloaded versus not), preload counts and picker stats for the current session. It also warns if Discord's hardware acceleration is off.

**Feel and stability**
- **No network hooks.** While any `session.webRequest` listener exists, Electron sends every request (messages, images, stream setup) through Discord's main process first. Whenever that process is busy, for example while starting or stopping a screen share, all loading waits on it. In a test with a busy main process, 40 requests took 3x longer in total with a single filtered hook registered. asar 1.3 blocks tracking and typing requests inside the page instead (they resolve instantly as 204). Custom CSS and JS are injected without removing Discord's CSP, so asar registers no hooks at all.
- **Slow loading check** (Settings → Performance): logs every request over 2 s with where the time went (*waiting for the server* versus *stalled on this PC*), plus main-process stalls and page freezes, and tells you which one is causing the slowness.
- **Test as stock Discord:** one switch turns off everything asar changes but keeps measuring, so you can compare with and without asar without reinstalling.
- **Repair caches** (Settings → Advanced): clears Discord's graphics, code and download caches on the next start. asar 1.3 also clears the graphics cache once, because earlier forced GPU flags can leave it built for the wrong settings.
- **Stock graphics flags by default.** asar 1.0 and 1.1 (and OpenAsar's "perf" preset) forced GPU features that Chromium blocklists for some drivers: `--ignore-gpu-blocklist`, zero-copy, hardware overlays and forcing the high-performance GPU. On affected PCs the GPU process hangs, so Discord freezes for 10 to 30 seconds, especially when screen sharing or opening image-heavy channels. Those flags are now an opt-in **GPU boost** preset. asar 1.2 moves existing installs back to **Stock** once.
- **Freeze watchdog.** asar records every freeze and every graphics-process crash in `asar-freezes.json`. A once-a-second heartbeat inside Discord's page catches freezes even if you don't click during them. If Discord freezes while anything optional is on (Instant UI, blur removal, GPU boost, priority, custom flags, custom CSS/JS), asar switches to **safe mode**, which turns all of it off, and shows a notification.
- **Instant UI** (on by default): turns on Discord's own reduced-motion mode through Chromium's `--force-prefers-reduced-motion`, so modals, popouts and channel switches don't animate. asar 1.1 to 1.3.0 also set `transition-duration: 1ms` on every element. Because every element defaults to `transition-property: all`, that turned each restyle into thousands of CSS transitions. Channel switches and stream start/stop froze for 15 to 35 s (benchmark: 27 s on 1.3.0 versus 1.2 s on 1.3.1 and 1.1 s on stock). Fixed in 1.3.1.
- **No blur** (on by default): removes `backdrop-filter` blur, one of the most expensive effects to composite.
- **High priority** (Windows, opt-in): raises all of Discord's processes. 1.1 raised only some of them, which starved Discord's own network process while big channels rendered.
- **Light in-page code.** In a heavy-channel benchmark, asar's code in Discord's page measured within run-to-run noise of having it off. There are no timers polling the page, and no page searches while you type or click in chat.
- **Startup time is measured every launch** and charted in Settings → Performance, next to any freezes this session.

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
- New settings window with General, Performance, Privacy, Theming, Advanced, Debug and About tabs.
- A **Restore stock Discord** button that puts back `app.asar.backup` and keeps asar as `app.asar.asar-fork`.
- Self-updates from this repo's [`build` branch](https://github.com/rottenvia/asar/tree/build) a few seconds after launch and shows a notification when it installs an update. Settings → Advanced shows when it last checked and the result. You can turn it off or point it at another URL there. asar never pulls from upstream OpenAsar, which would replace this build.

Existing OpenAsar settings (CSS, JS, preset, toggles) are migrated automatically.

## Debug logs

asar settings (**Ctrl + Alt + O**) → **Debug** records what Discord and asar are doing and saves one text file that explains a problem without anyone having to reproduce it: whether it comes from asar, Discord, the PC or the network.

- **Start recording**, do whatever is slow or broken, **Stop and save**. **Save log now** saves without stopping. Or turn on **Record from Discord's start** to record every launch from the first second (startup included) until you stop it or close Discord.
- A log starts with a **summary**: the most likely cause and every finding, tagged `[asar]`, `[Discord]`, `[this PC]`, `[network]`, `[graphics]`, `[other mod]` or `[setting]`. Then the PC and Discord (CPU, memory, graphics card and driver, GPU features, displays, versions, Discord and asar settings, Chromium flags, other mods), the startup timeline, numbers (channel switches, slow clicks, slow frames by owner, CPU and memory per Discord process, network by kind of request, Discord's busiest actions, gateway and voice states), errors, and the full timeline with a legend.
- Slow frames are split by **whose code ran**: Discord, asar, another mod (BetterDiscord, Vencord...), your custom JS, or drawing. asar's injected script is named `asar-injected.js` so Chromium can attribute it. The summary always states asar's share.
- **Crash-proof:** events are written to a journal every 3 s. If Discord crashes, freezes and gets killed, or the PC turns off, the recording becomes a log (marked "Discord closed") the next time Discord starts.
- **Private by design:** no messages, names, usernames, server or channel names, links, files, tokens or account details. Server and channel IDs become codes salted per recording (`c:3fa1c2`), web addresses are reduced to the kind of request (`discord.com/api/v9/channels/:id/messages`, attachments as `*.png`), error texts lose IDs, addresses, e-mails and quoted text, and your user folder is removed from paths. The finished file is scrubbed once more for anything that looks like an ID, e-mail or token.
- **Free when off**, cheap when on: page events are batched and sent every 2 s, CPU and memory are sampled every 5 s, Discord's modules are looked up in idle time. In the test client, the fast-switch benchmark measured the same with recording on and off (948 to 952 ms).
- Logs are in Discord's data folder under `asar-debug` (newest 12 kept). **Copy summary** copies everything above the timeline, ready to paste into a chat.

## Manual install

1. Fully quit Discord (right-click the tray icon, then Quit).
2. Open Discord's `resources` folder:
   - Windows: `%localappdata%\Discord\app-1.0.XXXX\resources` (use the newest `app-` folder)
   - Linux: `/opt/discord/resources` or `/usr/share/discord/resources` (varies by distro)
   - macOS: `/Applications/Discord.app/Contents/Resources`
3. If there's no `app.asar.backup` yet, rename Discord's `app.asar` to `app.asar.backup`. It's already there if you used OpenAsar before.
4. Copy the [new `app.asar`](https://github.com/rottenvia/asar/raw/build/app.asar) in and start Discord.

Discord host updates keep asar automatically. The updater copies it into the new `app-` folder.

## Uninstall

In asar settings (**Ctrl + Alt + O**), go to Advanced → **Restore stock Discord**. Or by hand: delete `app.asar` and rename `app.asar.backup` back to `app.asar`.

## Build

```
npm ci
npm run build   # -> dist/app.asar
```

Every push to `main` is built by GitHub Actions and smoke-tested against the real Discord Linux client (stable and canary). If both pass, the build is pushed to the [`build` branch](https://github.com/rottenvia/asar/tree/build) (where asar updates itself from) and the [`nightly` release](https://github.com/rottenvia/asar/releases/tag/nightly).

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
