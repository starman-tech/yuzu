#!/usr/bin/env bash
# shot.sh nom  → capture PNG du shell imbriqué dans shots/nom.png
S=$(cd "$(dirname "$0")" && pwd); export DBUS_SESSION_BUS_ADDRESS=$(cat "$S/../.run/nested.bus")
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$S/shots/$1.png" >/dev/null && echo "$S/shots/$1.png"
