// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/vectorIcons.js — icônes vectorielles fidèles au pixel près.
 *
 * Les tracés ci-dessous sont copiés tels quels (mêmes commandes de chemin)
 * depuis la maquette de référence — aucune reconstruction approximative en
 * Cairo. Comme la couleur doit changer dynamiquement (accent extrait de la
 * pochette), chaque icône est écrite dans un petit fichier .svg mis en cache
 * — un fichier par couple (icône, couleur) — puis chargée via
 * Gio.FileIcon. St.Icon rasterise le SVG à la taille demandée, donc un seul
 * fichier sert à toutes les tailles.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {ensureDir, hashString} from './utils.js';

/* Tracés copiés depuis la maquette fournie, viewBox 0 0 24 24. */
const ICONS = {
    /* ═══ Barre d'en-tête — tracés copiés tels quels de la maquette ═══ */
    'hdr-add': {
        stroke: true, strokeWidth: 2.5,
        body: '<line x1="12" y1="5" x2="12" y2="19"/>'
            + '<line x1="5" y1="12" x2="19" y2="12"/>',
    },
    'hdr-edit': {
        stroke: true, strokeWidth: 2,
        body: '<path d="M12 20h9"/>'
            + '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    },
    'hdr-pin': {
        stroke: true, strokeWidth: 2,
        body: '<line x1="12" y1="17" x2="12" y2="22"/>'
            + '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 '
            + '10.68V6a3 3 0 0 0-3-3h-0a3 3 0 0 0-3 3v4.68a2 2 0 0 1-1.11 1.87l-1.78'
            + '.9A2 2 0 0 0 5 15.24Z"/>',
    },
    /* variante épinglée : stroke-width 2.2, comme .action-btn.is-pinned svg */
    'hdr-pin-on': {
        stroke: true, strokeWidth: 2.2,
        body: '<line x1="12" y1="17" x2="12" y2="22"/>'
            + '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 '
            + '10.68V6a3 3 0 0 0-3-3h-0a3 3 0 0 0-3 3v4.68a2 2 0 0 1-1.11 1.87l-1.78'
            + '.9A2 2 0 0 0 5 15.24Z"/>',
    },
    'hdr-settings': {
        stroke: true, strokeWidth: 2,
        body: '<line x1="4" y1="21" x2="4" y2="14"/>'
            + '<line x1="4" y1="10" x2="4" y2="3"/>'
            + '<line x1="12" y1="21" x2="12" y2="12"/>'
            + '<line x1="12" y1="8" x2="12" y2="3"/>'
            + '<line x1="20" y1="21" x2="20" y2="16"/>'
            + '<line x1="20" y1="12" x2="20" y2="3"/>'
            + '<line x1="1" y1="14" x2="7" y2="14"/>'
            + '<line x1="9" y1="8" x2="15" y2="8"/>'
            + '<line x1="17" y1="16" x2="23" y2="16"/>',
    },
    /* tasse de café — rester allumé capot fermé */
    'hdr-awake': {
        stroke: true, strokeWidth: 2,
        body: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/>'
            + '<path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>'
            + '<line x1="6" y1="2" x2="6" y2="4"/>'
            + '<line x1="10" y1="2" x2="10" y2="4"/>'
            + '<line x1="14" y1="2" x2="14" y2="4"/>',
    },

    'plus-circle': {
        stroke: true, strokeWidth: 1.8,
        body: '<circle cx="12" cy="12" r="10"/>'
            + '<path d="M12 8v8m-4-4h8" stroke-linecap="round"/>',
    },
    'skip-forward': {
        stroke: false,
        body: '<path d="M5 4.5v15l11-7.5L5 4.5z"/>'
            + '<rect x="17" y="4.5" width="2" height="15" rx="1"/>',
    },
    'skip-back': {
        stroke: false,
        body: '<path d="M19 4.5v15L8 12l11-7.5z"/>'
            + '<rect x="5" y="4.5" width="2" height="15" rx="1"/>',
    },
    'podcast': {
        stroke: true, strokeWidth: 2,
        body: '<circle cx="12" cy="12" r="2"/>'
            + '<path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48 0a6 6 0 0 1 0-8.49'
            + 'm11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
    },
    repeat: {
        stroke: true, strokeWidth: 2,
        body: '<polyline points="17 1 21 5 17 9"/>'
            + '<path d="M3 11V9a4 4 0 0 1 4-4h14"/>'
            + '<polyline points="7 23 3 19 7 15"/>'
            + '<path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    },
    headphones: {
        stroke: false,
        body: '<path d="M12 3a9 9 0 00-9 9v7c0 1.1.9 2 2 2h3v-8H5v-1a7 7 0 0'
            + '114 0v1h-3v8h3c1.1 0 2-.9 2-2v-7a9 9 0 00-9-9z"/>',
    },
    'pause-bars': {
        stroke: false,
        body: '<rect x="6" y="5" width="4" height="14" rx="1.5"/>'
            + '<rect x="14" y="5" width="4" height="14" rx="1.5"/>',
    },
    'play-triangle': {
        stroke: false,
        body: '<path d="M7 5v14l12-7L7 5z"/>',
    },
};

/* ══════════════════════════════════════════════════════════════════════
 * JEU D'ICÔNES MAISON
 *
 * Dessiné de zéro pour être cohérent : grille 24×24, trait de 1.9,
 * extrémités et jonctions arrondies, mêmes rayons de courbure. Les icônes
 * animées (rotation, translation) sont conçues autour du centre 12,12 pour
 * que la rotation Clutter ne les décale pas.
 * ══════════════════════════════════════════════════════════════════════ */
const OWN_STROKE = 1.9;

/* Épaisseurs imposées par la maquette de l'en-tête, par icône. */
const OWN_STROKE_OVERRIDES = {
};

const OWN_ICONS = {
    /* ═══ Tracés repris À L'IDENTIQUE de la maquette de l'en-tête ═══ */

    /* chronomètre du suivi de temps */
    'ui-clock': '<circle cx="12" cy="13" r="7.5"/>'
        + '<path d="M12 9v4l2.6 1.8M9.5 3.5h5"/>',

    /* barres de statistiques */
    'ui-chart': '<path d="M4 20h16"/>'
        + '<path d="M7 20v-5M12 20V8M17 20v-8"/>',

    /* flèche de rafraîchissement */
    'ui-refresh': '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',


    /* chevrons — éditeur de code */
    'ui-code': '<path d="M15.5 7.5 20 12l-4.5 4.5M8.5 7.5 4 12l4.5 4.5"/>',

    /* globe — navigateur */
    'ui-globe': '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/>'
        + '<path d="M12 3.5a13 13 0 0 1 3.4 8.5A13 13 0 0 1 12 20.5a13 13 0 0 1-3.4-8.5A13 13 0 0 1 12 3.5z"/>',

    /* invite de commande — terminal */
    'ui-terminal': '<path d="M5 7.5 9.5 12 5 16.5M12.5 16.5h6.5"/>',

    /* palette — création graphique */
    'ui-palette': '<path d="M12 3.5a8.5 8.5 0 0 0 0 17 1.8 1.8 0 0 0 1.4-2.9 1.8 1.8 0 0 1 1.4-2.9h1.5a4.2 4.2 0 0 0 4.2-4.2A8.5 8.5 0 0 0 12 3.5z"/>'
        + '<circle cx="8" cy="8.5" r="1.1"/><circle cx="13" cy="7" r="1.1"/><circle cx="7" cy="13" r="1.1"/>',

    /* fenêtre — application générique */
    'ui-window': '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/>'
        + '<path d="M3.5 9h17"/>',

    /* bulle — messagerie */
    'ui-chat': '<path d="M20.5 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-5A7.5 7.5 0 1 1 20.5 11.5z"/>',


    /* flèches de réordonnancement */
    'ui-up': '<path d="M12 19V5.5M6.5 11 12 5.5 17.5 11"/>',
    'ui-down': '<path d="M12 5v13.5M6.5 13 12 18.5 17.5 13"/>',

    /* ranger dans la bibliothèque — carton qui se referme */
    'ui-stow': '<path d="M4 8.5h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/>'
        + '<path d="M3 4.5h18v4H3z"/><path d="M10 12.5h4"/>',

    /* fermer / retirer */
    'ui-close': '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',

    /* poignée de glissement */
    'ui-grip': '<path d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01"/>',

    /* liste à cocher — module de tâches */
    'ui-todo': '<path d="M4 7.5l2 2 3.5-3.5"/><path d="M13 8h7"/>'
        + '<path d="M4 16.5l2 2 3.5-3.5"/><path d="M13 17h7"/>',

    /* grille d'icônes — mode « applis » */
    'hdr-grid': '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/>'
        + '<rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',

    /* flèche retour */
    'hdr-back': '<path d="M19 12H5M11 6l-6 6 6 6"/>',

    /* note de musique — lecteur */
    'ui-music': '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',

    /* soleil et nuage — météo */
    'ui-weather': '<circle cx="8" cy="9" r="3.5"/><path d="M8 2.5v1.5M8 14v1.5M1.5 9H3M13 9h1.5M3.4 4.4l1 1M11.6 4.4l-1 1"/>'
        + '<path d="M10 20.5h8.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 10 20.5z"/>',

    /* puce — système */
    'ui-cpu': '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/>'
        + '<path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9h3.5M2.5 15h3.5M18 9h3.5M18 15h3.5"/>',

    /* calendrier */
    'ui-calendar': '<rect x="3.5" y="5" width="17" height="15.5" rx="1.5"/><path d="M3.5 10h17M8 2.5v4.5M16 2.5v4.5"/>'
        + '<path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',

    /* grille d'applis — lanceur */
    'ui-apps': '<rect x="3.5" y="3.5" width="5" height="5"/><rect x="9.5" y="3.5" width="5" height="5"/><rect x="15.5" y="3.5" width="5" height="5"/>'
        + '<rect x="3.5" y="9.5" width="5" height="5"/><rect x="9.5" y="9.5" width="5" height="5"/><rect x="15.5" y="9.5" width="5" height="5"/>'
        + '<rect x="3.5" y="15.5" width="5" height="5"/><rect x="9.5" y="15.5" width="5" height="5"/><rect x="15.5" y="15.5" width="5" height="5"/>',

    /* lecture aléatoire */
    'ui-shuffle': '<path d="M16 3.5l4 4-4 4"/><path d="M4 7.5h4c2 0 3.5 1 4.5 2.5"/><path d="M16 12.5l4 4-4 4"/>'
        + '<path d="M4 16.5h4c4 0 6-3 7.5-5.5s3.5-3.5 4.5-3.5"/>',

    /* haut-parleur — volume */
    'ui-volume': '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',

    /* pause — suivi du temps */
    'ui-pause': '<path d="M8.5 5v14M15.5 5v14"/>',

    /* lecture — suivi du temps */
    'ui-play': '<path d="M7.5 5v14l11-7z"/>',

    /* balai — vider */
    'ui-clear': '<path d="M4 20h16M6.5 20l1.5-8h8l1.5 8M9 12V5.5a3 3 0 0 1 6 0V12"/>',

    // #if full
    /* envoyer : flèche vers la droite */
    'ui-send': '<path d="M4.5 12h15M13 5.5l6.5 6.5-6.5 6.5"/>',
    // #endif

    // #if full
    /* stop : carré plein en trait */
    'ui-stop': '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    // #endif

    // #if full
    /* corbeille */
    'ui-trash': '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>'
        + '<path d="M10.5 10.5v6M13.5 10.5v6"/>',
    // #endif
};

/* Les icônes maison rejoignent le même dictionnaire, toutes en trait.
 * Celles de l'en-tête portent l'épaisseur exacte de la maquette. */
for (const [name, body] of Object.entries(OWN_ICONS)) {
    ICONS[name] = {
        stroke: true,
        strokeWidth: OWN_STROKE_OVERRIDES[name] ?? OWN_STROKE,
        body,
    };
}

let cacheDir = null;

function dir() {
    cacheDir ??= ensureDir(`${GLib.get_user_cache_dir()}/sidepanel/vector-icons`);
    return cacheDir;
}

function svgFile(name, colorHex) {
    const def = ICONS[name];
    if (!def)
        throw new Error(`icône vectorielle inconnue : ${name}`);

    const path = `${dir()}/${hashString(`${name}:${colorHex}`)}.svg`;
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        const svg = def.stroke
            ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" `
              + `fill="none" stroke="${colorHex}" stroke-width="${def.strokeWidth}" `
              + `stroke-linecap="round" stroke-linejoin="round">${def.body}</svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" `
              + `fill="${colorHex}">${def.body}</svg>`;
        GLib.file_set_contents(path, svg);
    }
    return path;
}

/** Vrai si `name` est une icône vectorielle de ce fichier (et non une
 * icône du thème GNOME comme `audio-x-generic-symbolic`). */
export function hasVectorIcon(name) {
    return Boolean(name) && Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** Icône St.Icon chargée depuis le SVG exact, dans la couleur demandée. */
export function vectorIcon(name, colorHex, size = 20) {
    const file = Gio.File.new_for_path(svgFile(name, colorHex));
    return new St.Icon({gicon: Gio.FileIcon.new(file), icon_size: size});
}

/** Change la couleur (et donc le fichier source) d'une St.Icon existante. */
export function setVectorIcon(icon, name, colorHex) {
    const file = Gio.File.new_for_path(svgFile(name, colorHex));
    icon.gicon = Gio.FileIcon.new(file);
}
