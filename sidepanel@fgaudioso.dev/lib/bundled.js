// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/bundled.js — modules du catalogue embarqués dans l'extension.
 *
 * Vide dans la version complète : elle installe ces modules à la demande
 * depuis le catalogue. tools/build.sh --ego réécrit ce fichier pour la
 * version extensions.gnome.org, qui livre les modules dans son zip (le
 * chargement de code téléchargé y est interdit). */

export const BUNDLED = [];
