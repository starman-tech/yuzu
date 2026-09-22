#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Construit le zip d'une édition, installable avec
#   gnome-extensions install --force dist/<zip>
#
#   tools/build.sh           version complète (GitHub)
#   tools/build.sh --ego     version extensions.gnome.org : sans catalogue à
#                            chaud ni assistant, modules du catalogue embarqués
#                            (dépôt sidepanel-modules à côté de celui-ci, ou
#                            SIDEPANEL_MODULES=chemin)
# Seuls les fichiers nécessaires à l'exécution sont inclus.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="sidepanel@fgaudioso.dev"
EXT="$ROOT/$UUID"
EDITION=full
[ "${1:-}" = "--ego" ] && EDITION=ego
CATALOG="${SIDEPANEL_MODULES:-$ROOT/../sidepanel-modules}"

"$ROOT/tools/lint.sh" >/dev/null || { echo "✗ tools/lint.sh échoue : corrige avant de construire" >&2; exit 1; }

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version-name"])' "$EXT/metadata.json")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -a "$EXT/." "$STAGE/"
rm -f "$STAGE/schemas/gschemas.compiled"
python3 "$ROOT/tools/edition.py" "$EDITION" "$STAGE" "$CATALOG"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"

# le résultat doit rester du JavaScript valide et compilable
while IFS= read -r -d '' f; do
    node --experimental-default-type=module --check "$f" 2>/dev/null \
        || { echo "✗ ${f#"$STAGE"/} invalide après préparation de l'édition $EDITION" >&2; exit 1; }
done < <(find "$STAGE" -name '*.js' -print0)
glib-compile-schemas --strict --targetdir="$(mktemp -d)" "$STAGE/schemas/"
if [ "$EDITION" = full ]; then
    glib-compile-schemas "$STAGE/schemas/"   # GNOME ≥ 44 compile seul ; utile aux installations manuelles
fi
UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$STAGE/metadata.json")"

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$UUID-v$VERSION.zip"
[ "$EDITION" = ego ] && { mkdir -p "$ROOT/dist/ego"; OUT="$ROOT/dist/ego/$UUID.zip"; }
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
