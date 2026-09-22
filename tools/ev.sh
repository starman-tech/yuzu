#!/usr/bin/env bash
# ev.sh 'code JS'  → évalue dans le shell imbriqué
S=$(cd "$(dirname "$0")" && pwd); export DBUS_SESSION_BUS_ADDRESS=$(cat "$S/../.run/nested.bus")
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"
