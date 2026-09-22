#!/usr/bin/env bash
# panel.sh 'code avec p (panneau)'  → exécute avec p = SidePanel du shell imbriqué
S=$(dirname "$0")
$S/ev.sh "import('resource:///org/gnome/shell/ui/main.js').then(M => { const p = M.extensionManager.lookup('$(cat "$S/../.run/nested.uuid" 2>/dev/null || echo sidepanel@fgaudioso.dev)').stateObj._panel; globalThis.__p = p; try { $1 } catch (e) { log('[test] ' + e); } }); 'queued'"
