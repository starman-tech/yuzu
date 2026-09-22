#!/usr/bin/env bash
# Shell GNOME imbriqué ISOLÉ pour tester l'extension sans toucher à la session
# courante : configuration, données, cache et dconf vivent dans .run/sandbox.
# L'extension y est installée depuis les sources à chaque lancement.
#
#   tools/nested.sh            → lance (Ctrl+C pour quitter)
#   tools/nested.sh --reset    → repart d'un bac à sable vide
#   tools/nested.sh --ego      → teste le zip extensions.gnome.org (tools/build.sh --ego)
#
# --unsafe-mode autorise org.gnome.Shell.Eval, utilisé par ev.sh / panel.sh /
# shot.sh ; l'adresse du bus imbriqué est écrite dans .run/nested.bus.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="yuzu-plus@starman-tech.github.io"
RUN="$ROOT/.run"
SANDBOX="$RUN/sandbox"

EGO=0
for arg in "$@"; do
    case "$arg" in
        --reset) rm -rf "$SANDBOX" ;;
        --ego) EGO=1 ;;
    esac
done
mkdir -p "$SANDBOX"/{config,data,cache}
rm -rf "$SANDBOX/data/gnome-shell/extensions"

if [ $EGO = 1 ]; then
    "$ROOT/tools/build.sh" --ego >/dev/null
    ZIP="$(ls "$ROOT"/dist/ego/*.zip | head -1)"
    UUID="$(basename "$ZIP" .zip)"
    DEST="$SANDBOX/data/gnome-shell/extensions/$UUID"
    mkdir -p "$DEST"
    python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$ZIP" "$DEST"
else
    DEST="$SANDBOX/data/gnome-shell/extensions/$UUID"
    mkdir -p "$DEST"
    rsync -a --delete "$ROOT/$UUID/" "$DEST/"
fi
glib-compile-schemas "$DEST/schemas/"
echo "$UUID" > "$RUN/nested.uuid"

# GNOME 49 remplace --nested par --devkit
MODE=--nested
gnome-shell --help 2>&1 | grep -q -- '--devkit' && MODE=--devkit

exec env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" PATH=/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" \
  DISPLAY="${DISPLAY:-:0}" XAUTHORITY="${XAUTHORITY:-}" \
  XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data" XDG_CACHE_HOME="$SANDBOX/cache" \
  XDG_DATA_DIRS=/usr/local/share:/usr/share XDG_CONFIG_DIRS=/etc/xdg XDG_SESSION_TYPE=wayland \
  LANG="${LANG:-C.UTF-8}" MUTTER_DEBUG_DUMMY_MODE_SPECS="${SIZE:-1400x900}" \
  dbus-run-session -- sh -c '
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$0/nested.bus"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$1\"]"
    before=$(ls "$XDG_RUNTIME_DIR" | grep -E "^wayland-[0-9]+$")
    gnome-shell "$2" --wayland --unsafe-mode &
    shell=$!
    # les applis activées par D-Bus (dont les préférences) doivent s ouvrir
    # dans le shell imbriqué, pas sur l écran hôte
    for _ in $(seq 1 50); do
        sock=$(ls "$XDG_RUNTIME_DIR" | grep -E "^wayland-[0-9]+$" | grep -vxF "$before" | head -1)
        [ -n "$sock" ] && break
        sleep 0.2
    done
    [ -n "$sock" ] && dbus-update-activation-environment WAYLAND_DISPLAY="$sock" && echo "$sock" > "$0/nested.wayland"
    trap "kill $shell 2>/dev/null" INT TERM
    wait $shell' "$RUN" "$UUID" "$MODE"
