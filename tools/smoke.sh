#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Test de fumée dans le shell imbriqué lancé par tools/nested.sh : ouvre le
# panneau, change de thème, de largeur et de vue, entre et sort du mode
# édition, désactive puis réactive l'extension, et échoue si le journal
# contient une erreur JS ou St/GLib critique pendant ce parcours.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/.run/nested.log"
[ -s "$ROOT/.run/nested.bus" ] || { echo "✗ lance d'abord tools/nested.sh" >&2; exit 1; }

UUID="sidepanel@fgaudioso.dev"
ev() { "$ROOT/tools/ev.sh" "$1"; }
panel() {   # exécute du JS avec p = panneau, puis attend
    ev "import('resource:///org/gnome/shell/ui/main.js').then(M => { M.overview.hide(); const p = M.extensionManager.lookup('$UUID').stateObj._panel; try { $1 } catch (e) { globalThis.__smokeErr = String(e); } }); 'q'" >/dev/null
    sleep "${2:-2}"
}
result() { ev "$1" | sed -E "s/^\(true, '\"?//; s/\"?'\)$//"; }

start=$(wc -l < "$LOG")
step() { printf '→ %s\n' "$1"; }

step "ouverture";               panel "p.open(); p._pinned = true;"
step "thème clair";             panel "p._settings.set_string('theme', 'brutal-light');" 3
step "largeur 360";             panel "p._settings.set_int('panel-width', 360);" 3
step "vue grille";              panel "p.open(); p.setViewMode('grid');"
step "vue cartes";              panel "p.setViewMode('stack');"
step "mode édition";            panel "p.setEditMode(true);" 1; panel "p.setEditMode(false);" 1
step "retour aux réglages";     panel "p._settings.reset('theme'); p._settings.reset('panel-width');" 3
step "largeur réelle";          panel "p.open(); p._pinned = true;" 3
panel "import('gi://St').then(({default: St}) => { const s = St.ThemeContext.get_for_stage(global.stage).scale_factor; const f = p._cards[0]?._frame; globalThis.__smokeW = f ? (Math.floor(f.width / s) - 2 * (p._theme.strokeWidth ?? 1)) + ' / ' + p.moduleWidth() : 'aucune carte'; });" 1
echo "  cadre intérieur / moduleWidth : $(result 'globalThis.__smokeW')"
step "désactivation / réactivation"
ev "import('resource:///org/gnome/shell/ui/main.js').then(async M => { await M.extensionManager.disableExtension('$UUID'); await M.extensionManager.enableExtension('$UUID'); globalThis.__smokeState = M.extensionManager.lookup('$UUID').state; }); 'q'" >/dev/null
sleep 4
state="$(result 'globalThis.__smokeState')"
echo "  état : $state (1 = actif)"

errors="$(tail -n +"$((start + 1))" "$LOG" | grep -E "JS ERROR|disposed|TypeError|ReferenceError|Unhandled promise|\[sidepanel\].*(erreur|error)|St-CRITICAL|GLib-GObject-CRITICAL|Gjs-CRITICAL" )"
thrown="$(result 'globalThis.__smokeErr ?? ""')"
if [ -n "$errors" ] || [ -n "$thrown" ] || [ "$state" != 1 ]; then
    echo; echo "✗ problèmes :"; [ -n "$thrown" ] && echo "  $thrown"; echo "$errors" | head -20
    exit 1
fi
echo; echo "✓ aucun problème dans le journal"
