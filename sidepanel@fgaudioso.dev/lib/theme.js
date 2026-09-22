// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/theme.js — SYSTÈME DE STYLE
 *
 * Ce fichier est partagé entre le processus du shell et celui des
 * préférences : il ne doit importer AUCUNE bibliothèque GI.
 *
 * Direction artistique : NÉO-BRUTALISME PIXEL, sombre.
 *   • aplats opaques, aucun verre, aucun flou, aucun dégradé décoratif
 *   • contours épais (3 px) et ombres portées DURES (décalage, zéro flou)
 *   • coins quasi carrés (4–6 px), blocs empilés comme des cartouches
 *   • typographie monospace, titres en capitales
 *   • un seul accent : orange, sur base bleu nuit, texte beige
 *
 * Palette :
 *   Space Cadet  #1E223D  base
 *   Gargoyle Gas #E6D5B7  texte, contours
 *   Orange       #F54F1B  accent, ombre du panneau
 *
 * Jetons d'un thème :
 *   radius / cardRadius   arrondis (px) — petits, c'est voulu
 *   strokeWidth           épaisseur des contours (px)
 *   shadow                ombre dure du panneau (syntaxe box-shadow St) ou null
 *   shadowOffset          décalage (px logiques) de l'ombre dure des cartes
 *   cardShadow            couleur de l'ombre dure des cartes
 *   base                  fond opaque du panneau [r, g, b] en 0..1
 *   tint / stroke         fond CSS et contour du panneau
 *   cardTint / cardStroke fond et contour des blocs (picker, bibliothèque, barre d'édition)
 *   text / textDim / textMuted
 *   accent / accentInk    couleur d'action et encre posée dessus
 *   danger                erreurs
 *   blobs / blobAlpha / speed   formes du fond animé (voir glass.js)
 *   grid                  quadrillage pixel sur le fond (true/false)
 *   gloss                 reflets « verre » du fond (0 = aucun)
 *   grain                 micro-bruit (0..1)
 *   fontUI / fontMono     familles de polices (noms NUS : St refuse les guillemets)
 *   module                palette des cartes : 'dark', 'light' ou un objet (voir MODULE)
 *   iconRest / iconLit / iconActive   icônes de l'en-tête : repos, survol, sur bloc orange
 */

/* Palette de référence. */
export const PALETTE = {
    navy: '#1E223D',        // Space Cadet
    navyDeep: '#12152A',    // ombres, encre sur accent
    navyLight: '#2A2F52',   // surface des cartes
    navyLine: '#3B4170',    // séparateurs discrets
    beige: '#E6D5B7',       // Gargoyle Gas
    beigeDim: '#B8AA8F',    // texte secondaire, icônes au repos
    beigeDeep: '#8F846F',   // texte atténué
    orange: '#F54F1B',      // Orange
    orangeDeep: '#C93F12',
    orangeSoft: '#FF7A4D',
    red: '#FF3B3B',         // danger
};

/* ⚠️ St refuse une liste de familles ENTRE GUILLEMETS (« Couldn't parse
 * family in font property ») et ignore alors toute la propriété. Les noms
 * restent donc nus ; les espaces dans un nom sont acceptés. */
const FONT_MONO = 'JetBrains Mono, Ubuntu Mono, DejaVu Sans Mono, monospace';

export const THEMES = {
    brutal: {
        label: 'Brutal Dark (nuit / orange)',
        iconRest: PALETTE.beigeDim,
        iconLit: PALETTE.beige,
        iconActive: PALETTE.navyDeep,
        fontUI: FONT_MONO,
        fontDisplay: FONT_MONO,
        fontMono: FONT_MONO,
        radius: 6,
        cardRadius: 4,
        strokeWidth: 3,
        shadow: `8px 8px 0px 0px ${PALETTE.orange}`,
        shadowOffset: 4,
        cardShadow: PALETTE.navyDeep,
        blurSigma: 0,
        blurBrightness: 1,
        base: [0.118, 0.133, 0.239],
        tint: PALETTE.navy,
        stroke: PALETTE.beige,
        innerStroke: PALETTE.navyLine,
        cardTint: PALETTE.navyLight,
        cardStroke: PALETTE.beige,
        text: PALETTE.beige,
        textDim: PALETTE.beigeDim,
        textMuted: PALETTE.beigeDeep,
        accent: PALETTE.orange,
        accentInk: PALETTE.navyDeep,
        danger: PALETTE.red,
        blobs: [[0.96, 0.31, 0.11], [0.90, 0.84, 0.72], [0.23, 0.25, 0.44]],
        blobAlpha: 0.22,
        speed: 0.8,
        grid: true,
        gloss: 0,
        grain: 0,
    },

    'brutal-light': {
        label: 'Brutal Light (beige / orange)',
        module: 'light',
        iconRest: '#5A5E78',
        iconLit: PALETTE.navy,
        iconActive: PALETTE.navyDeep,
        fontUI: FONT_MONO,
        fontDisplay: FONT_MONO,
        fontMono: FONT_MONO,
        radius: 6,
        cardRadius: 4,
        strokeWidth: 3,
        shadow: `8px 8px 0px 0px ${PALETTE.navy}`,
        shadowOffset: 4,
        cardShadow: PALETTE.navy,
        blurSigma: 0,
        blurBrightness: 1,
        base: [0.902, 0.835, 0.718],
        tint: PALETTE.beige,
        stroke: PALETTE.navy,
        innerStroke: 'rgba(30, 34, 61, 0.18)',
        cardTint: '#F3E9D6',
        cardStroke: PALETTE.navy,
        text: PALETTE.navy,
        textDim: 'rgba(30, 34, 61, 0.70)',
        textMuted: 'rgba(30, 34, 61, 0.50)',
        accent: PALETTE.orange,
        accentInk: PALETTE.navyDeep,
        danger: PALETTE.red,
        blobs: [[0.96, 0.31, 0.11], [0.12, 0.13, 0.24], [1.0, 1.0, 1.0]],
        blobAlpha: 0.16,
        speed: 0.7,
        grid: true,
        gloss: 0,
        grain: 0,
    },
};

export const DEFAULT_THEME = 'brutal';

/* Formes du fond animé. Défini ici (et pas dans glass.js) parce que prefs.js
 * tourne dans un processus sans St ni Shell et doit pouvoir lire cette liste. */
export const SHAPES = ['pixel', 'liquid', 'orbs', 'waves', 'geometric'];

export const SHAPE_LABELS = {
    pixel: 'Pixel (blocs qui dérivent)',
    liquid: 'Liquide (halos organiques)',
    orbs: 'Sphères',
    waves: 'Vagues',
    geometric: 'Géométrique',
};

export function getTheme(id) {
    return THEMES[id] ?? THEMES[DEFAULT_THEME];
}

export function themeList() {
    return Object.entries(THEMES).map(([id, t]) => ({id, label: t.label}));
}

/* ------------------------------------------------- fabriques de styles */

export function panelStyle(t) {
    return `
        font-family: ${t.fontUI};
        border-radius: ${t.radius}px;
        background-color: ${t.tint};
        border: ${t.strokeWidth}px solid ${t.stroke};
        ${t.shadow ? `box-shadow: ${t.shadow};` : ''}
        color: ${t.text};`;
}

/** Bloc à contour épais et ombre dure (picker, bibliothèque, état vide…). */
export function cardStyle(t, {padding = 0, radius = null, shadow = true} = {}) {
    const off = t.shadowOffset ?? 0;
    return `
        border-radius: ${radius ?? t.cardRadius}px;
        background-color: ${t.cardTint};
        border: ${t.strokeWidth}px solid ${t.cardStroke};
        ${shadow && off > 0 ? `box-shadow: ${off}px ${off}px 0px 0px ${t.cardShadow};` : ''}
        padding: ${padding}px;
        color: ${t.text};`;
}

/** Étiquette technique monospace en capitales (« #F54F1B »). */
export function labelStyle(t, {size = 10, color = null} = {}) {
    return `
        font-family: ${t.fontMono};
        font-size: ${size}px;
        font-weight: bold;
        letter-spacing: 1px;
        color: ${color ?? t.textDim};`;
}

/* ------------------------------------------------- surfaces des modules
 *
 * Les modules intégrés sont dessinés sur leur propre maquette (facteur k)
 * mais partagent ce jeu de constantes pour rester cohérents. Tout est
 * opaque : le contour épais et l'ombre dure sont posés par ModuleCard
 * (lib/card.js), les modules ne dessinent que leur surface. */
const MODULE_DARK = {
    surface: PALETTE.navyLight,
    surfaceStrong: PALETTE.navyDeep,
    stroke: PALETTE.beige,
    strokeSoft: PALETTE.navyLine,
    inset: PALETTE.navy,
    insetHover: '#343A63',
    text: PALETTE.beige,
    textDim: PALETTE.beigeDim,
    textMuted: PALETTE.beigeDeep,
    accent: PALETTE.orange,
    accentInk: PALETTE.navyDeep,
    positive: PALETTE.orange,
    positiveBg: 'rgba(245, 79, 27, 0.18)',
    negative: PALETTE.beige,
    negativeBg: 'rgba(230, 213, 183, 0.14)',
    shadow: PALETTE.navyDeep,
    radius: 4,        // px logiques AVANT facteur k : les modules font px(MODULE.radius)
    strokeWidth: 2,   // contour interne des sous-blocs (le contour externe est celui de la carte)
};

const MODULE_LIGHT = {
    ...MODULE_DARK,
    surface: '#F3E9D6',
    surfaceStrong: '#E6D5B7',
    stroke: PALETTE.navy,
    strokeSoft: 'rgba(30, 34, 61, 0.22)',
    inset: '#EADFC8',
    insetHover: '#E0D2B6',
    text: PALETTE.navy,
    textDim: 'rgba(30, 34, 61, 0.72)',
    textMuted: 'rgba(30, 34, 61, 0.52)',
    accentInk: PALETTE.navyDeep,
    positive: PALETTE.orangeDeep,
    positiveBg: 'rgba(245, 79, 27, 0.14)',
    negative: PALETTE.navy,
    negativeBg: 'rgba(30, 34, 61, 0.08)',
    shadow: PALETTE.navy,
};

/* Objet VIVANT : les modules le lisent au moment de construire leurs
 * acteurs, et le panneau le recale sur le thème actif (applyModulePalette)
 * puis reconstruit les cartes à chaque changement de thème. Ne jamais
 * recopier ses valeurs dans une constante de niveau module : elles
 * resteraient figées sur le premier thème chargé. */
export const MODULE = {...MODULE_DARK};

/* Surfaces qui restent sombres quel que soit le thème, parce qu'elles sont
 * posées sur une image (le lecteur, pochette en plein fond). */
export const MODULE_ON_ART = Object.freeze({...MODULE_DARK});

/** `theme.module` : 'dark' (défaut), 'light', ou un objet complet pour un
 * thème personnalisé (clés de MODULE_DARK, les absentes restent sombres). */
export function applyModulePalette(theme) {
    const wanted = theme?.module;
    const palette = wanted === 'light' ? MODULE_LIGHT
        : wanted && typeof wanted === 'object' ? {...MODULE_DARK, ...wanted}
            : MODULE_DARK;
    Object.assign(MODULE, palette);
}
