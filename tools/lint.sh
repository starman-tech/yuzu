#!/usr/bin/env bash
# Vérifications statiques, en local comme en CI. Aucun shell GNOME requis.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/sidepanel@fgaudioso.dev"
fail=0
step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

step "Syntaxe JavaScript (ESM)"
while IFS= read -r -d '' f; do
    if ! node --experimental-default-type=module --check "$f" 2>/tmp/sp-lint.$$; then
        echo "✗ ${f#"$ROOT"/}"; sed 's/^/    /' /tmp/sp-lint.$$; fail=1
    fi
done < <(find "$EXT" "$ROOT/docs" -name '*.js' -print0)
rm -f /tmp/sp-lint.$$
[ $fail -eq 0 ] && echo "ok"

step "Identifiants utilisés sans import"
(cd "$EXT" && python3 "$ROOT/tools/check-imports.py") || fail=1

step "Schéma GSettings"
tmp="$(mktemp -d)"
if glib-compile-schemas --strict --targetdir="$tmp" "$EXT/schemas"; then echo "ok"; else fail=1; fi
rm -rf "$tmp"

step "metadata.json"
python3 - "$EXT/metadata.json" <<'PY' || fail=1
import json, sys
d = json.load(open(sys.argv[1]))
missing = [k for k in ('uuid', 'name', 'description', 'shell-version', 'url') if not d.get(k)]
if missing:
    sys.exit(f"champs manquants ou vides : {', '.join(missing)}")
print(f"ok — {d['name']} {d.get('version-name', d.get('version'))}, GNOME {', '.join(d['shell-version'])}")
PY

echo
if [ $fail -eq 0 ]; then echo "✓ tout est bon"; else echo "✗ des vérifications ont échoué"; fi
exit $fail
