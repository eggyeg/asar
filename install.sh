#!/bin/sh
# asar installer for Discord on Linux and macOS.
#
#   sh install.sh              install or update asar
#   sh install.sh uninstall    put stock Discord back
#
# Set ASAR_DIRS to a space-separated list of Discord "resources" folders to override detection.
set -eu

URL="${ASAR_URL:-https://raw.githubusercontent.com/rottenvia/asar/build/app.asar}"
MODE="${1:-install}"

say() { printf '  %s\n' "$*"; }

DIRS="${ASAR_DIRS:-}"
if [ -z "$DIRS" ]; then
  for d in /opt/discord*/resources /opt/Discord*/resources /usr/share/discord*/resources /usr/lib/discord*/resources \
           /usr/lib64/discord*/resources "$HOME"/.local/share/discord*/resources "$HOME"/.local/share/Discord*/resources \
           /Applications/Discord*.app/Contents/Resources "$HOME"/Applications/Discord*.app/Contents/Resources; do
    [ -f "$d/app.asar" ] && DIRS="$DIRS $d"
  done
fi

printf '\n  asar installer\n\n'

if [ -z "$DIRS" ]; then
  say "Couldn't find Discord. Flatpak and Snap installs are read-only and can't be modified."
  say "If Discord is somewhere else, run: ASAR_DIRS=/path/to/Discord/resources sh install.sh"
  exit 1
fi

TMP=""
if [ "$MODE" != "uninstall" ]; then
  TMP="$(mktemp)"
  say "Downloading asar..."
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$TMP"; else wget -qO "$TMP" "$URL"; fi
  if [ "$(head -c 4 "$TMP" | od -An -tx1 | tr -d ' \n')" != "04000000" ]; then
    say "The download isn't a valid app.asar. Try again in a minute."
    exit 1
  fi
fi

for p in Discord DiscordPTB DiscordCanary discord discord-ptb discord-canary; do
  pkill -x "$p" 2>/dev/null && say "Closed $p" || true
done
sleep 1

for d in $DIRS; do
  SUDO=""
  [ -w "$d" ] || SUDO="sudo"
  asar="$d/app.asar"
  say ""
  say "$d"

  if [ "$MODE" = "uninstall" ]; then
    if [ -f "$asar.backup" ]; then
      $SUDO cp -f "$asar.backup" "$asar" && $SUDO rm -f "$asar.backup"
      say "Restored stock Discord"
    else
      say "No backup found, left as is"
    fi
    continue
  fi

  if [ ! -f "$asar.backup" ]; then
    if grep -q asarVersion "$asar" 2>/dev/null || grep -q OpenAsar "$asar" 2>/dev/null; then
      say "Note: no stock backup (a modded app.asar is installed). Reinstall Discord if you ever want stock back."
    else
      $SUDO cp -f "$asar" "$asar.backup"
      say "Backed up Discord's app.asar"
    fi
  fi

  $SUDO cp -f "$TMP" "$asar"
  say "Installed asar"
done

[ -n "$TMP" ] && rm -f "$TMP"
say ""
if [ "$MODE" = "uninstall" ]; then say "Done. Discord is back to stock."; else say "Done. Start Discord. Open asar settings from the \"asar\" tab in Discord settings, or press Ctrl + Alt + O."; fi
say ""
