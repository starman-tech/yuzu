#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Construit dist/sidepanel@fgaudioso.dev-v<version>.zip, installable avec
#   gnome-extensions install --force dist/<zip>
# Seuls les fichiers nécessaires à l'exécution sont inclus.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="sidepanel@fgaudioso.dev"
EXT="$ROOT/$UUID"

"$ROOT/tools/lint.sh" >/dev/null || { echo "✗ tools/lint.sh échoue : corrige avant de construire" >&2; exit 1; }

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version-name"])' "$EXT/metadata.json")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -a "$EXT/." "$STAGE/"
glib-compile-schemas "$STAGE/schemas/"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$UUID-v$VERSION.zip"
rm -f "$OUT"
python3 - "$STAGE" "$OUT" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(stage):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(base, name)
            z.write(path, os.path.relpath(path, stage))
PY
echo "✓ ${OUT#"$ROOT"/} ($(du -h "$OUT" | cut -f1))"
