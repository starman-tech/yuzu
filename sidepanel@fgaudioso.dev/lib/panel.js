// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/panel.js — le panneau flottant en verre. */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ModuleCard} from './card.js';
import {LiquidBackground, applyBackdropBlur} from './glass.js';
// #if full
import {ModuleRegistry, userModuleDir} from './registry.js';
// #else
//: import {ModuleRegistry} from './registry.js';
// #endif
import {
    MODULE, applyModulePalette, cardStyle, getTheme, labelStyle, panelStyle,
} from './theme.js';
import {hasVectorIcon, vectorIcon} from './vectorIcons.js';
import {
    makeActionButton, makeAddButton, makePill, makeRow, popIn, setIconPalette,
    slideIn, slideOut,
} from './widgets.js';
import {
    cacheDir, clamp, configFile, fetchBytes, newSession, scaleFactor, sourceRemove, timeoutAdd,
} from './utils.js';

/* API offerte aux modules (ctx.api), documentée dans docs/MODULES.md.
 * Incrémenter à chaque ajout ; ne jamais retirer ni changer une signature. */
const MODULE_API = 1;

const STRUCTURAL = ['panel-width', 'panel-margin', 'edge-width', 'module-order',
    'module-hidden', 'player-width', 'player-height', 'card-spacing', 'view-mode'];

/* Mode « applis » : colonnes de la grille de tuiles et taille du bloc d'icône. */
const GRID_COLUMNS = 3;
const TILE_ICON = 52;
const RESTYLE = ['theme', 'backdrop-blur', 'bg-shape', 'bg-speed', 'bg-intensity', 'bg-colors'];

/* Marges internes du panneau, en px logiques. Une seule source de vérité :
 * les mêmes valeurs servent au padding CSS de la colonne et au calcul de la
 * largeur distribuée aux modules — sinon les deux divergent et les cartes
 * débordent.
 *
 * Le padding DROIT est plus faible que le gauche à dessein : la barre de
 * défilement occupe déjà sa propre largeur dans l'allocation, et s'ajoute
 * donc visuellement à ce padding. Les deux côtés paraissent ainsi
 * équilibrés, sans creuser un écart inutile vers le bord de l'écran. */
const PADDING_LEFT = 14;
const PADDING_RIGHT = 4;
const SCROLLBAR_WIDTH = 10;   // largeur réelle prise par la St.ScrollBar

/* Respiration verticale minimale : sans elle le panneau occupe toute la
 * hauteur utile et paraît écrasé contre les bords. */
const VERTICAL_BREATHING = 28;

/* En-tête : « + » (24) · titre · N boutons d'action. Les valeurs suivent
 * le CSS (.sp-header-bar : 14 px de chaque côté ; titre 14 px, espacé de
 * 2 px). TITLE_WIDTH est une borne haute du titre « PANNEAU ». */
const HEADER_PADDING = 28;
const HEADER_ADD = 24;
const HEADER_LEFT_GAP = 12;
const HEADER_ACTION_GAP = 4;
const TITLE_WIDTH = 86;

/** Taille des boutons et présence du titre pour une largeur de panneau :
 * d'abord réduire les boutons (jusqu'à 28 px), puis masquer le titre, et
 * seulement ensuite descendre sous 28 px. Rien ne doit déborder. */
export function headerLayout(panelWidth, strokeWidth, buttons) {
    const avail = panelWidth - 2 * strokeWidth - HEADER_PADDING;
    const gaps = (buttons - 1) * HEADER_ACTION_GAP;
    for (const size of [32, 30, 28]) {
        if (HEADER_ADD + HEADER_LEFT_GAP + TITLE_WIDTH + buttons * size + gaps <= avail)
            return {size, showTitle: true};
    }
    const size = Math.floor((avail - HEADER_ADD - HEADER_LEFT_GAP - gaps) / buttons);
    return {size: clamp(size, 22, 32), showTitle: false};
}

export class SidePanel {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._registry = new ModuleRegistry();
        this._cards = [];
        this._isOpen = false;
        this._pinned = false;
        this._editMode = false;
        this._hideTimer = 0;
        this._grab = null;
        this._stageClickId = 0;
        this._signals = [];

        this._theme = getTheme(this._settings.get_string('theme'));
        applyModulePalette(this._theme);

        this._build();
        // #if full
        this._loadImportedModules();
        // #endif

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'theme')
                this._switchTheme();
            else if (RESTYLE.includes(key))
                this._applyTheme();
            else if (STRUCTURAL.includes(key))
                this._rebuild();
            else if (key === 'toggle-panel')
                this._rebindShortcut();
            // #if full
            else if (key === 'module-paths')
                this._loadImportedModules({show: true});
            // #endif
            else if (key === 'keep-awake')
                this._awakeButton?.spSetActive(this._settings.get_boolean(key), {animate: true});
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._relayout());
        /* Un dock qui apparaît, se masque ou change de taille modifie la
         * zone de travail sans toucher aux moniteurs ni à la barre du
         * haut : sans cette écoute, le panneau resterait sous le dock. */
        this._workAreaId = global.display.connect('workareas-changed',
            () => this._relayout());
        this._panelBoxId = Main.layoutManager.panelBox.connect('notify::height',
            () => this._relayout());
        this._bindShortcut();
    }

    /* ------------------------------------------------------------ UI */

    _build() {
        const t = this._theme;
        setIconPalette(t);

        /* --- bande de déclenchement au bord --- */
        this._edge = new St.Bin({
            style_class: 'sp-edge',
            reactive: true,
            track_hover: true,
            width: this._settings.get_int('edge-width') * scaleFactor(),
        });
        this._edgeHandle = new St.Widget({
            width: 6 * scaleFactor(),
            height: 72 * scaleFactor(),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 110,
        });
        this._edgeHandle.set_pivot_point(1.0, 0.5);
        this._edge.set_child(this._edgeHandle);

        /* --- racine en verre --- */
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            can_focus: true,
        });
        /* variantes claires de stylesheet.css (.sp-light …) */
        if (t.module === 'light')
            this._actor.add_style_class_name('sp-light');

        /* Le flou GPU est rectangulaire : on l'insère en retrait pour que ses
         * angles droits passent sous l'arrondi du panneau. */
        this._blurLayer = new St.Widget({x_expand: true, y_expand: true, reactive: false});
        this._actor.add_child(this._blurLayer);

        this._background = new LiquidBackground(t, this._backgroundParams());
        this._actor.add_child(this._background);

        const column = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});

        /* ═══ EN-TÊTE — reproduction fidèle de la maquette ═══
         * .header-left (gap 12) : bouton « + » de 24 px puis le titre.
         * .header-actions (gap 4) : trois boutons carrés de 32 px. */
        this._header = new St.BoxLayout({
            style_class: 'sp-header-bar',
            x_expand: true,
        });
        const HEADER_BUTTONS = 5;
        const {size: btn, showTitle} = headerLayout(this._settings.get_int('panel-width'),
            t.strokeWidth ?? 1, HEADER_BUTTONS);
        this._headerShowsTitle = showTitle;

        const headerLeft = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${HEADER_LEFT_GAP}px;`,
        });

        this._addButton = makeAddButton({
            size: 24, iconSize: 14,
            tooltip: 'Ajouter un module',
            onClick: () => this._togglePicker(),
        });

        /* mode applis : « retour » remplace le « + » quand un module est ouvert */
        this._backButton = makeActionButton({
            icon: 'hdr-back',
            size: HEADER_ADD, // remplace le « + » : même encombrement
            tooltip: 'Retour à la grille',
            onClick: () => this._closeFocus(),
        });
        this._backButton.hide();

        this._titleLabel = new St.Label({
            text: 'PANNEAU',
            style_class: 'sp-header-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        /* Le titre ne doit jamais être tronqué en « Panne… » : on coupe
         * l'ellipse et on lui interdit de se comprimer. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = false;

        headerLeft.add_child(this._backButton);
        headerLeft.add_child(this._addButton);
        headerLeft.add_child(this._titleLabel);
        if (!showTitle)
            this._titleLabel.hide();

        const headerActions = new St.BoxLayout({
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${HEADER_ACTION_GAP}px;`,
        });

        /* Le verrou lui-même vit dans KeepAwake (extension.js) : le
         * bouton ne fait que basculer la clé, et survit ainsi aux
         * reconstructions du panneau. */
        this._awakeButton = makeActionButton({
            icon: 'hdr-awake',
            size: btn,
            tooltip: 'Rester allumé capot fermé',
            onClick: () => this._settings.set_boolean('keep-awake',
                !this._settings.get_boolean('keep-awake')),
        });
        this._awakeButton.spSetActive(this._settings.get_boolean('keep-awake'));

        this._viewButton = makeActionButton({
            icon: 'hdr-grid',
            size: btn,
            tooltip: 'Grille d\'icônes / cartes empilées',
            onClick: () => this.setViewMode(this._isGrid() ? 'stack' : 'grid'),
        });
        this._viewButton.spSetActive(this._isGrid());

        this._editButton = makeActionButton({
            icon: 'hdr-edit',
            size: btn,
            tooltip: 'Modifier',
            onClick: () => this.setEditMode(!this._editMode),
        });
        this._pinButton = makeActionButton({
            icon: 'hdr-pin',
            size: btn,
            tooltip: 'Épingler',
            onClick: () => this.setPinned(!this._pinned),
        });
        this._prefsButton = makeActionButton({
            icon: 'hdr-settings',
            size: btn,
            tooltip: 'Paramètres',
            onClick: () => {
                this.close(true);
                this._openPreferences();
            },
        });

        headerActions.add_child(this._viewButton);
        headerActions.add_child(this._awakeButton);
        headerActions.add_child(this._editButton);
        headerActions.add_child(this._pinButton);
        headerActions.add_child(this._prefsButton);


        this._header.add_child(headerLeft);
        this._header.add_child(headerActions);
        column.add_child(this._header);

        /* règle franche sous l'en-tête : sépare la barre d'outils des cartes */
        this._headerRule = new St.Widget({style_class: 'sp-header-rule', x_expand: true});
        column.add_child(this._headerRule);

        /* Zone défilante : elle contient TOUT le contenu variable — cartes,
         * sélecteur d'import et bibliothèque. Le sélecteur et la
         * bibliothèque étaient auparavant ajoutés à la colonne, donc
         * épinglés en bas du panneau en permanence : un bandeau fixe que
         * rien ne justifiait. Ils défilent maintenant avec le reste. */
        this._stack = new St.BoxLayout({vertical: true, x_expand: true});
        this._stack.set_x_align(Clutter.ActorAlign.FILL);

        this._scrollContent = new St.BoxLayout({vertical: true, x_expand: true});
        this._scrollContent.add_child(this._stack);

        /* mode applis : grille de tuiles et module ouvert SUPERPOSÉS dans
         * un BinLayout, pour que l'un s'efface pendant que l'autre arrive
         * (un fondu croisé est impossible s'ils s'empilent verticalement) */
        this._viewStage = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._grid = new St.BoxLayout({
            vertical: true, x_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START,
        });
        this._grid.hide();
        this._focus = new St.BoxLayout({
            vertical: true, x_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START,
        });
        this._focus.hide();
        this._viewStage.add_child(this._grid);
        this._viewStage.add_child(this._focus);
        this._scrollContent.add_child(this._viewStage);
        this._gridCards = new Map();
        this._focusedId = null;

        /* état vide : aucun module affiché */
        this._emptyState = new St.BoxLayout({vertical: true, x_expand: true});
        this._emptyTitle = new St.Label({text: 'AUCUN MODULE', x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = new St.Label({
            text: 'Clique sur ＋ pour ajouter un module,\nou ouvre la bibliothèque.',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyHint.clutter_text.line_wrap = true;
        this._emptyHint.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        this._emptyState.add_child(this._emptyTitle);
        this._emptyState.add_child(this._emptyHint);
        this._emptyState.hide();
        this._scrollContent.add_child(this._emptyState);

        this._scroll = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.set_child(this._scrollContent);
        column.add_child(this._scroll);

        /* sélecteur d'import */
        this._picker = new St.BoxLayout({vertical: true, x_expand: true});
        this._picker.hide();
        this._addButton?.spSetOpen(false);
        this._scrollContent.add_child(this._picker);

        /* bibliothèque des modules rangés */
        this._library = new St.BoxLayout({vertical: true, x_expand: true});
        this._libraryLabel = new St.Label({text: 'BIBLIOTHÈQUE'});
        this._libraryChips = new St.BoxLayout({x_expand: true});
        this._library.add_child(this._libraryLabel);
        this._library.add_child(this._libraryChips);
        this._library.hide();
        this._scrollContent.add_child(this._library);

        this._actor.add_child(column);
        this._column = column;

        Main.layoutManager.addChrome(this._edge, {
            affectsInputRegion: true, affectsStruts: false, trackFullscreen: true,
        });
        Main.layoutManager.addChrome(this._actor, {
            affectsInputRegion: true, affectsStruts: false, trackFullscreen: true,
        });

        this._connect(this._edge, 'notify::hover', () => {
            /* la poignée s'allume sous le curseur, même si l'ouverture au
             * survol est désactivée : elle signale la zone du raccourci */
            this._edgeHandle.remove_all_transitions();
            this._edgeHandle.ease({
                opacity: this._edge.hover ? 255 : 110,
                scale_x: this._edge.hover ? 1.6 : 1,
                scale_y: this._edge.hover ? 1.15 : 1,
                duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            });
            if (this._edge.hover && this._settings.get_boolean('show-on-hover'))
                this.open();
        });
        this._connect(this._actor, 'notify::hover', () => {
            if (this._actor.hover)
                this._cancelHide();
            else
                this._scheduleHide();
        });
        this._connect(this._actor, 'key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                if (this._grab)
                    this.leaveEditMode();
                else if (this._focusedId)
                    this._closeFocus();
                else
                    this.close(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._applyTheme();
        this._buildCards();
        this._calibrateWidth();
        this._relayout();

        this._actor.hide();
        this._actor.translation_x = this._closedOffset();
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    /* --------------------------------------------------------- thème */

    /* Les modules intégrés lisent MODULE au moment de construire leurs
     * acteurs : un simple restylage laisserait leurs cartes aux couleurs de
     * l'ancien thème (cartes sombres dans un panneau clair). On recale la
     * palette, puis on reconstruit tout. */
    _switchTheme() {
        this._theme = getTheme(this._settings.get_string('theme'));
        applyModulePalette(this._theme);
        this._rebuild();
    }

    _applyTheme() {
        const t = getTheme(this._settings.get_string('theme'));
        this._theme = t;

        const inset = Math.round(t.radius * 0.42);
        this._blurLayer.set_style(`margin: ${inset}px; border-radius: ${t.radius}px;`);
        const blurred = applyBackdropBlur(this._blurLayer, t,
            this._settings.get_boolean('backdrop-blur'));
        this._background.setTheme(t);
        this._background.setParams(this._backgroundParams());
        this._background.setBlurAvailable(blurred);

        this._actor.set_style(panelStyle(t));
        this._column.set_style(
            `padding: ${PADDING_LEFT}px ${PADDING_RIGHT}px; spacing: 0px;`);

        this._headerRule.set_style(`background-color: ${t.stroke};`);
        this._titleLabel.set_style(`${labelStyle(t, {size: 13, color: t.text})} letter-spacing: 2px;`);

        /* poignée du bord : bloc orange cerné de beige, coins carrés */
        this._edgeHandle.set_style(
            `background-color: ${t.accent}; border: 2px solid ${t.stroke}; border-right-width: 0px;`);

        /* les blocs du bas réservent, comme les cartes, la place de leur
         * ombre dure à droite et en bas */
        const off = (t.shadowOffset ?? 0) * scaleFactor();
        for (const block of [this._picker, this._library, this._emptyState]) {
            block.margin_right = off;
            block.margin_bottom = off;
        }
        this._picker.set_style(`${cardStyle(t, {padding: 12})} margin-top: 10px; spacing: 8px;`);
        this._library.set_style(`${cardStyle(t, {padding: 12})} margin-top: 10px;`);
        this._libraryLabel.set_style(`${labelStyle(t)} padding-bottom: 8px;`);
        this._libraryChips.set_style('spacing: 8px;');

        this._emptyState.set_style(`${cardStyle(t, {padding: 22})} spacing: 6px;`);
        this._emptyTitle.set_style(labelStyle(t, {size: 11, color: t.accent}));
        this._emptyHint.set_style(`color: ${t.textDim}; font-size: 11px;`);

        /* Pas de padding-right ici : la barre de défilement prend déjà
         * sa largeur dans l'allocation. En ajouter un revenait à la
         * compter deux fois, et les cartes débordaient d'autant. */
        this._stack.set_style(
            `spacing: ${this._settings.get_int('card-spacing')}px; padding: 2px 0;`);
        this._grid.set_style('spacing: 6px; padding: 2px 0;');
        this._focus.set_style('padding: 2px 0;');

        this._cards.forEach(card => card.setTheme(t));
        this._gridCards.forEach(card => card.setTheme(t));
        this._renderLibrary();
    }

    /* ------------------------------------------------- mode « applis » */

    _isGrid() {
        return this._settings.get_string('view-mode') === 'grid';
    }

    setViewMode(mode) {
        if (mode !== 'grid' && mode !== 'stack')
            return;
        if (mode === this._settings.get_string('view-mode'))
            return;
        /* la clé est STRUCTURAL : le panneau se reconstruit tout seul */
        this._settings.set_string('view-mode', mode);
    }

    /** Icône d'un descripteur : tracé vectoriel maison, sinon icône du thème. */
    _moduleIcon(descriptor, size, color) {
        const name = descriptor.icon ?? '';
        if (hasVectorIcon(name))
            return vectorIcon(name, color, size);
        return new St.Icon({icon_name: name || 'application-x-executable-symbolic', icon_size: size});
    }

    /** Les modules activés et non rangés, dans l'ordre de `module-order`. */
    _gridDescriptors() {
        const hidden = this._settings.get_strv('module-hidden');
        return this._settings.get_strv('module-order')
            .filter(id => !hidden.includes(id))
            .map(id => this._registry.get(id))
            .filter(Boolean);
    }

    /** Largeur d'une colonne de la grille, en px d'acteur. */
    _tileWidth() {
        const t = this._theme;
        const s = scaleFactor();
        const avail = this.moduleWidth() + (t.shadowOffset ?? 0) + 2 * (t.strokeWidth ?? 1);
        const gap = 8;
        return Math.floor((avail - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS) * s;
    }

    _buildGrid() {
        this._grid.destroy_all_children();
        this._tiles = [];
        const descriptors = this._gridDescriptors();
        let row = null;
        descriptors.forEach((descriptor, index) => {
            if (index % GRID_COLUMNS === 0) {
                row = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
                this._grid.add_child(row);
            }
            const tile = this._makeTile(descriptor);
            row.add_child(tile);
            this._tiles.push(tile);
        });
        this._grid.show();
        this._focus.hide();
    }

    _makeTile(descriptor) {
        const s = scaleFactor();
        const tile = new St.Button({
            style_class: 'sp-tile',
            can_focus: true,
            width: this._tileWidth(),
        });
        tile.set_accessible_name(`Ouvrir ${descriptor.title ?? descriptor.id}`);
        tile.set_pivot_point(0.5, 0.5);

        const box = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing: 8px;'});
        const iconBin = new St.Bin({
            style_class: 'sp-tile-icon',
            width: TILE_ICON * s,
            height: TILE_ICON * s,
            x_align: Clutter.ActorAlign.CENTER,
        });
        iconBin.set_pivot_point(0.5, 0.5);
        const icon = this._moduleIcon(descriptor, 26, this._theme.text);
        icon.set_pivot_point(0.5, 0.5);
        iconBin.set_child(icon);
        /* Pas de letter-spacing sur ce libellé : St mesure le texte sans,
         * Pango l'applique ensuite, et le texte laissé à sa largeur
         * naturelle débordait d'un pixel et s'ellipsait (« LECTEU… »). */
        const label = new St.Label({
            text: (descriptor.short ?? descriptor.title ?? descriptor.id).toUpperCase(),
            style_class: 'sp-tile-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_wrap = false;
        box.add_child(iconBin);
        box.add_child(label);
        tile.set_child(box);

        tile._spIcon = icon;
        tile._spIconBin = iconBin;
        tile._spId = descriptor.id;

        tile.connect('notify::hover', () => {
            /* le bloc d'icône se soulève légèrement, l'icône grossit */
            iconBin.remove_all_transitions();
            iconBin.ease({
                translation_y: tile.hover ? -2 * s : 0,
                duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUART,
            });
            icon.remove_all_transitions();
            icon.ease({
                scale_x: tile.hover ? 1.12 : 1, scale_y: tile.hover ? 1.12 : 1,
                duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        });
        tile.connect('button-press-event', () => {
            iconBin.remove_all_transitions();
            iconBin.ease({translation_x: 3 * s, translation_y: 3 * s, duration: 60,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return Clutter.EVENT_PROPAGATE;
        });
        const release = () => {
            iconBin.remove_all_transitions();
            iconBin.ease({translation_x: 0, translation_y: tile.hover ? -2 * s : 0, duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return Clutter.EVENT_PROPAGATE;
        };
        tile.connect('button-release-event', release);
        tile.connect('leave-event', release);
        tile.connect('clicked', () => this._openTile(descriptor.id, tile));
        return tile;
    }

    /** Carte d'un module en mode applis : construite à la demande, gardée
     * jusqu'à la prochaine reconstruction du panneau. */
    _gridCard(id) {
        if (this._gridCards.has(id))
            return this._gridCards.get(id);
        const descriptor = this._registry.get(id);
        if (!descriptor)
            return null;
        let card;
        try {
            const instance = descriptor.build(this._moduleContext());
            if (!instance?.actor)
                throw new Error('build() doit renvoyer un objet avec une propriété actor');
            card = new ModuleCard(descriptor, instance, this._theme);
        } catch (e) {
            console.error(`[sidepanel] module ${id} : ${e}`);
            card = this._errorCard(id, e, () => this._closeFocus());
            card.moduleId = id;
        }
        this._gridCards.set(id, card);
        return card;
    }

    _destroyGridCards() {
        this._focusedId = null;
        this._focus?.remove_all_children();
        this._gridCards.forEach(card => card.destroy());
        this._gridCards.clear();
    }

    /* Chorégraphie d'ouverture, façon lanceur de téléphone. Tout se
     * chevauche : la tuile grossit et s'efface, ses voisines reculent, la
     * carte arrive en fondu + zoom pendant que le panneau change de hauteur
     * EN GLISSANT (jamais par saut). */
    _openTile(id, tile) {
        if (this._focusedId || this._transitioning)
            return;
        const card = this._gridCard(id);
        if (!card)
            return;
        const s = scaleFactor();
        const descriptor = this._registry.get(id);
        this._focusedId = id;
        this._transitioning = true;
        this._cancelHide();

        /* 1. tuile cliquée : zoom + fondu ; les autres reculent */
        for (const other of this._tiles ?? []) {
            other.remove_all_transitions();
            other.set_pivot_point(0.5, 0.5);
            other.ease(other === tile
                ? {scale_x: 1.35, scale_y: 1.35, opacity: 0, duration: 340,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC}
                : {scale_x: 0.88, scale_y: 0.88, opacity: 0, duration: 300,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }

        /* 2. la carte arrive en même temps, un cran plus tard */
        this._focus.remove_all_children();
        this._focus.add_child(card);
        this._focus.remove_all_transitions();
        this._focus.show();
        this._focus.opacity = 0;
        this._focus.set_pivot_point(0.5, 0.0);
        this._focus.set_scale(0.94, 0.94);
        this._focus.translation_y = 22 * s;
        this._focus.ease({
            opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1,
            delay: 60, duration: 560, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._transitioning = false;
            },
        });
        card.onPanelOpened?.();

        /* 3. le panneau glisse vers sa nouvelle hauteur (celle de la carte
         * seule : la grille encore visible ne doit pas compter) */
        this._relayout({animate: true, ignore: this._grid});
        timeoutAdd(320, () => {
            if (this._focusedId === id) {
                this._grid.hide();
                for (const other of this._tiles ?? []) {
                    other.set_scale(1, 1);
                    other.opacity = 255;
                }
            }
            return GLib.SOURCE_REMOVE;
        });

        /* 4. l'en-tête bascule : retour + titre du module */
        this._addButton.hide();
        this._backButton.show();
        popIn(this._backButton, 0, {distance: -8, duration: 400});
        this._titleLabel.text = (descriptor?.short ?? descriptor?.title ?? id).toUpperCase();
        popIn(this._titleLabel, 60, {distance: 10, duration: 440});
    }

    _closeFocus() {
        if (!this._focusedId || this._transitioning)
            return;
        const s = scaleFactor();
        const id = this._focusedId;
        const card = this._gridCards.get(id);
        this._focusedId = null;
        this._transitioning = true;
        card?.onPanelClosed?.();
        this.leaveEditMode();

        /* la carte redescend en s'effaçant… */
        this._focus.remove_all_transitions();
        this._focus.set_pivot_point(0.5, 0.0);
        this._focus.ease({
            opacity: 0, translation_y: 14 * s, scale_x: 0.96, scale_y: 0.96,
            duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._focus.hide();
                this._focus.translation_y = 0;
                this._focus.set_scale(1, 1);
                this._focus.remove_all_children();
            },
        });

        /* …pendant que les tuiles reviennent en cascade */
        this._grid.show();
        this._grid.opacity = 255;
        (this._tiles ?? []).forEach((tile, i) => {
            tile.remove_all_transitions();
            tile.set_pivot_point(0.5, 0.5);
            tile.opacity = 0;
            tile.set_scale(0.9, 0.9);
            tile.ease({
                opacity: 255, scale_x: 1, scale_y: 1,
                delay: 140 + i * 24, duration: 480, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    this._transitioning = false;
                },
            });
        });
        this._relayout({animate: true, ignore: this._focus});

        this._backButton.hide();
        this._addButton.show();
        popIn(this._addButton, 0, {distance: -8, duration: 400});
        this._titleLabel.text = 'PANNEAU';
        popIn(this._titleLabel, 60, {distance: 10, duration: 440});
    }

    _updateEmptyState() {
        if (!this._emptyState)
            return;
        const empty = this._stack.get_n_children() === 0;
        if (empty && !this._emptyState.visible)
            slideIn(this._emptyState);
        else if (!empty)
            this._emptyState.hide();
    }

    _backgroundParams() {
        const speed = this._settings.get_double('bg-speed');
        const intensity = this._settings.get_double('bg-intensity');
        return {
            shape: this._settings.get_string('bg-shape'),
            speed: speed > 0 ? speed : null,
            intensity: intensity >= 0 ? intensity : null,
            colors: this._settings.get_strv('bg-colors'),
        };
    }

    /* -------------------------------------------------------- modules */

    // #if full
    /* Appelé au démarrage puis à chaque changement de `module-paths` — les
     * préférences y écrivent quand on installe un module du catalogue. Seuls
     * les chemins pas encore importés sont chargés. */
    async _loadImportedModules({show = false} = {}) {
        const paths = this._settings.get_strv('module-paths')
            .filter(p => !this._registry.isLoaded(p));
        if (paths.length === 0)
            return;
        const loaded = await this._registry.loadAll(paths);
        if (loaded.length === 0 || !this._settings)
            return;
        /* un fichier ajouté depuis les préférences : elles ne peuvent pas
         * connaître son id (seul le shell l'importe), la carte est donc
         * ajoutée ici */
        if (show) {
            const order = this._settings.get_strv('module-order');
            const fresh = loaded.filter(id => !order.includes(id));
            if (fresh.length > 0) {
                this._settings.set_strv('module-order', [...order, ...fresh]);
                return; // module-order est structurel : reconstruction complète
            }
        }
        if (this._stack)
            this._rebuildCards();
    }
    // #endif

    /** Largeur réellement disponible pour une carte, en px LOGIQUES.
     *
     * Les modules lisaient jusqu'ici `player-width` directement dans les
     * réglages, sans rapport avec la place réelle : les cartes en
     * x_expand débordaient sous la barre de défilement, et la carte du
     * lecteur (largeur fixe) n'était pas alignée sur les autres. Le
     * panneau est le seul à connaître cette valeur, c'est donc lui qui la
     * calcule et la distribue via ctx. */
    moduleWidth() {
        const panelWidth = this._settings.get_int('panel-width');
        /* ModuleCard réserve l'ombre dure (marge droite) et pose un contour
         * épais des deux côtés : les deux se retranchent de la largeur
         * distribuée au module. */
        const t = this._theme;
        const chrome = (t.shadowOffset ?? 0) + 2 * (t.strokeWidth ?? 1);
        return Math.max(120,
            panelWidth - PADDING_LEFT - PADDING_RIGHT - SCROLLBAR_WIDTH - chrome
            + (this._widthFix ?? 0));
    }

    /* La formule ci-dessus ne connaît pas tout (barre de défilement
     * superposée ou non, bordure du panneau, arrondis d'échelle) : un module
     * à largeur fixe comme le lecteur laissait des bandes de chaque côté.
     * Une fois le premier cadre alloué, on mesure sa largeur intérieure
     * réelle ; en cas d'écart, on corrige et on reconstruit, une seule fois
     * par disposition (après correction, l'écart est nul). */
    _calibrateWidth() {
        const frame = this._cards[0]?._frame;
        if (!frame || (this._calibrations ?? 0) >= 3)
            return;
        const id = frame.connect('notify::width', () => {
            if (frame.width <= 0)
                return;
            frame.disconnect(id);
            const s = scaleFactor();
            const inner = Math.floor(frame.width / s - 2 * (this._theme.strokeWidth ?? 1));
            const delta = inner - this.moduleWidth();
            if (delta === 0 || Math.abs(delta) > 80)
                return;
            this._widthFix = (this._widthFix ?? 0) + delta;
            this._calibrations = (this._calibrations ?? 0) + 1;
            /* pas de reconstruction pendant une allocation */
            this._calibrateId = sourceRemove(this._calibrateId);
            this._calibrateId = timeoutAdd(0, () => {
                this._calibrateId = 0;
                if (this._stack)
                    this._rebuildCards();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _moduleContext() {
        return {
            St, Clutter, GLib, Gio,
            api: MODULE_API,
            theme: this._theme,
            palette: MODULE,
            settings: this._settings,
            panel: this,
            extension: this._extension,
            moduleWidth: this.moduleWidth(),
            style: {labelStyle, cardStyle},
            utils: {
                timeoutAdd, sourceRemove, scaleFactor,
                configFile, cacheDir, newSession, fetchBytes,
                /** Lit un JSON ; `fallback` si absent ou invalide. */
                readJson(path, fallback = null) {
                    try {
                        const [ok, bytes] = GLib.file_get_contents(path);
                        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : fallback;
                    } catch (_e) {
                        return fallback;
                    }
                },
                writeJson(path, value) {
                    GLib.file_set_contents(path, JSON.stringify(value, null, 2));
                },
            },
        };
    }

    _buildCards() {
        if (this._isGrid()) {
            this._stack.hide();
            this._buildGrid();
            this._renderLibrary();
            this._emptyState.hide();
            return;
        }
        this._stack.show();
        this._grid.hide();
        this._focus.hide();

        const order = this._settings.get_strv('module-order');
        const hidden = this._settings.get_strv('module-hidden');

        for (const id of order) {
            if (hidden.includes(id))
                continue;
            const descriptor = this._registry.get(id);
            if (!descriptor)
                continue;
            try {
                const instance = descriptor.build(this._moduleContext());
                if (!instance?.actor)
                    throw new Error('build() doit renvoyer un objet avec une propriété actor');
                const card = new ModuleCard(descriptor, instance, this._theme);
                card.connect('move-requested', (_c, delta) => this._moveModule(id, delta));
                card.connect('drag-begin', () => this._beginDrag(card));
                card.connect('stow-requested', () => this._stowModule(id));
                card.connect('remove-requested', () => this._removeModule(id));
                card.setEditMode(this._editMode);
                this._stack.add_child(card);
                this._cards.push(card);
            } catch (e) {
                console.error(`[sidepanel] module ${id} : ${e}`);
                this._stack.add_child(this._errorCard(id, e));
            }
        }
        this._renderLibrary();
        this._updateEmptyState();
    }

    _errorCard(id, error, onRemove = null) {
        const t = this._theme;
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        box.set_style(`${cardStyle(t, {padding: 12})} border-color: ${t.danger}; spacing: 6px;`);

        const header = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
        const badge = new St.Label({text: 'ERREUR', y_align: Clutter.ActorAlign.CENTER});
        badge.set_style(`${labelStyle(t, {size: 9, color: t.accentInk})} `
            + `background-color: ${t.danger}; border-radius: 6px; padding: 2px 6px;`);
        const title = new St.Label({
            text: id,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        title.set_style(`color: ${t.text}; font-weight: bold; font-size: 12px;`);

        /* Sans ce bouton, un module défectueux restait affiché pour
         * toujours : il ne se construit pas, donc il n'a ni carte ni barre
         * d'édition, et rien ne permettait de le retirer depuis le
         * panneau. */
        const removeBtn = makePill('Retirer', t,
            () => (onRemove ?? (() => this._removeModule(id)))(), {variant: 'danger'});
        removeBtn.set_y_align(Clutter.ActorAlign.CENTER);

        header.add_child(badge);
        header.add_child(title);
        header.add_child(removeBtn);

        const detail = new St.Label({text: String(error)});
        detail.clutter_text.line_wrap = true;
        detail.set_style(`${labelStyle(t, {size: 10})} font-weight: normal; letter-spacing: 0;`);

        box.add_child(header);
        box.add_child(detail);
        return box;
    }

    _rebuildCards() {
        this._cards = [];
        this._stack.destroy_all_children();
        this._destroyGridCards();
        this._buildCards();
        /* reconstruites panneau ouvert (module installé depuis les
         * préférences, par exemple) : sans cet appel, leurs timers ne
         * démarreraient qu'à la prochaine ouverture */
        if (this._isOpen)
            this._cards.forEach(c => c.onPanelOpened());
        this._calibrateWidth();
        /* la hauteur épouse le contenu : elle doit être recalculée dès que
         * l'ensemble des cartes change */
        this._relayout();
    }

    /* --------------------------------------------- glisser-déposer */

    _beginDrag(card) {
        if (this._dragCard)
            return;
        this._dragCard = card;
        card.set_pivot_point(0.5, 0.5);
        card.ease({opacity: 190, scale_x: 1.02, scale_y: 1.02, duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._dragMotionId = this._actor.connect('motion-event', (_a, ev) => {
            this._updateDrag(ev);
            return Clutter.EVENT_STOP;
        });
        this._dragReleaseId = this._actor.connect('button-release-event', () => {
            this._endDrag();
            return Clutter.EVENT_STOP;
        });
        this._dragLeaveId = this._actor.connect('leave-event', () => {
            this._endDrag();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _updateDrag(event) {
        if (!this._dragCard)
            return;
        const [, y] = event.get_coords();
        const cards = this._stack.get_children();
        const current = cards.indexOf(this._dragCard);
        for (let i = 0; i < cards.length; i++) {
            if (i === current)
                continue;
            const [, cy] = cards[i].get_transformed_position();
            const [, ch] = cards[i].get_transformed_size();
            const middle = cy + ch / 2;
            if ((i < current && y < middle) || (i > current && y > middle)) {
                this._stack.set_child_at_index(this._dragCard, i);
                return;
            }
        }
    }

    _endDrag() {
        const card = this._dragCard;
        this._dragCard = null;
        if (this._dragMotionId) {
            this._actor.disconnect(this._dragMotionId);
            this._dragMotionId = 0;
        }
        if (this._dragReleaseId) {
            this._actor.disconnect(this._dragReleaseId);
            this._dragReleaseId = 0;
        }
        if (this._dragLeaveId) {
            this._actor.disconnect(this._dragLeaveId);
            this._dragLeaveId = 0;
        }
        if (!card)
            return;
        card.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_BACK});

        const visible = this._stack.get_children()
            .map(c => c.moduleId)
            .filter(Boolean);
        const hidden = this._settings.get_strv('module-hidden');
        this._settings.set_strv('module-order', [...visible, ...hidden]);
    }

    _moveModule(id, delta) {
        const order = this._settings.get_strv('module-order');
        const index = order.indexOf(id);
        const target = clamp(index + delta, 0, order.length - 1);
        if (index < 0 || index === target)
            return;
        order.splice(index, 1);
        order.splice(target, 0, id);
        this._settings.set_strv('module-order', order);
    }

    _stowModule(id) {
        const hidden = this._settings.get_strv('module-hidden');
        if (!hidden.includes(id)) {
            hidden.push(id);
            this._settings.set_strv('module-hidden', hidden);
        }
    }

    _restoreModule(id) {
        this._settings.set_strv('module-hidden',
            this._settings.get_strv('module-hidden').filter(x => x !== id));
    }

    _removeModule(id) {
        // #if full
        const descriptor = this._registry.get(id);
        // #endif
        this._settings.set_strv('module-order',
            this._settings.get_strv('module-order').filter(x => x !== id));
        this._settings.set_strv('module-hidden',
            this._settings.get_strv('module-hidden').filter(x => x !== id));
        // #if full
        if (descriptor && !descriptor.builtin) {
            this._settings.set_strv('module-paths',
                this._settings.get_strv('module-paths').filter(p => p !== descriptor.source));
        }
        // #endif
    }

    _renderLibrary() {
        if (!this._libraryChips)
            return;
        this._libraryChips.destroy_all_children();
        const hidden = this._settings.get_strv('module-hidden');
        const show = hidden.length > 0;
        if (show && !this._library.visible)
            slideIn(this._library);
        else if (!show)
            this._library.hide();

        hidden.forEach((id, index) => {
            const descriptor = this._registry.get(id);
            const chip = makePill(descriptor?.title ?? id, this._theme,
                () => this._restoreModule(id));
            chip.set_accessible_name('Remettre dans le panneau');
            this._libraryChips.add_child(chip);
            popIn(chip, index * 40, {distance: 8, duration: 300});
        });
    }

    /* ------------------------------------------------------- import + */

    _hidePicker() {
        this._addButton?.spSetOpen(false);
        if (this._picker.visible)
            slideOut(this._picker);
    }

    _pickerSection(text) {
        const label = new St.Label({text});
        label.set_style(`${labelStyle(this._theme)} padding: 4px 2px 2px 2px;`);
        return label;
    }

    _togglePicker() {
        if (this._picker.visible) {
            this._hidePicker();
            return;
        }
        this._picker.destroy_all_children();
        const t = this._theme;

        const order = this._settings.get_strv('module-order');
        // #if full
        const loadedPaths = this._settings.get_strv('module-paths');
        const files = this._registry.listFiles().filter(p => !loadedPaths.includes(p));
        // #else
        //: const files = [];
        // #endif
        const known = this._registry.all().filter(d => !order.includes(d.id));

        /* en-tête du volet : titre + chemin monospace + fermer */
        const head = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
        const headText = new St.BoxLayout({vertical: true, x_expand: true});
        const title = new St.Label({text: 'AJOUTER UN MODULE'});
        title.set_style(labelStyle(t, {size: 11, color: t.accent}));
        headText.add_child(title);
        // #if full
        const path = new St.Label({text: userModuleDir().replace(GLib.get_home_dir(), '~')});
        path.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        path.set_style(`${labelStyle(t, {size: 9})} font-weight: normal; letter-spacing: 0;`);
        headText.add_child(path);
        // #endif
        const closeBtn = makePill('✕', t, () => this._hidePicker());
        closeBtn.set_accessible_name('Fermer');
        closeBtn.set_y_align(Clutter.ActorAlign.START);
        head.add_child(headText);
        head.add_child(closeBtn);
        this._picker.add_child(head);

        // #if full
        /* scripts non encore chargés */
        if (files.length > 0) {
            this._picker.add_child(this._pickerSection('SCRIPTS DISPONIBLES'));
            for (const file of files) {
                this._picker.add_child(makeRow(GLib.path_get_basename(file),
                    () => this._importFile(file), {mono: true}));
            }
        }
        // #endif

        /* modules déjà connus mais absents du panneau */
        if (known.length > 0) {
            this._picker.add_child(this._pickerSection('MODULES DISPONIBLES'));
            for (const descriptor of known) {
                this._picker.add_child(makeRow(descriptor.title ?? descriptor.id,
                    () => this._addToPanel(descriptor.id)));
            }
        }

        if (files.length === 0 && known.length === 0) {
            const empty = new St.Label({
                // #if full
                text: 'Aucun module en attente. Ouvre le catalogue pour en installer '
                    + 'en un clic, ou dépose un .js dans le dossier.',
                // #else
                //: text: 'Tous les modules sont déjà dans le panneau.',
                // #endif
            });
            empty.clutter_text.line_wrap = true;
            empty.set_style(`color: ${t.textDim}; font-size: 11px; padding: 6px 2px;`);
            this._picker.add_child(empty);
        }

        const actions = new St.BoxLayout({x_expand: true, style: 'spacing: 6px; padding-top: 4px;'});
        // #if full
        const catalogBtn = makePill('Catalogue', t, () => this._openPrefsPage('catalog'), {variant: 'accent'});
        const browseBtn = makePill('Fichier…', t, () => this._openPrefsPage('modules'));
        const openBtn = makePill('Dossier', t,
            () => Gio.AppInfo.launch_default_for_uri(`file://${userModuleDir()}`, null));
        actions.add_child(catalogBtn);
        actions.add_child(browseBtn);
        actions.add_child(openBtn);
        // #else
        //: actions.add_child(makePill('Préférences', t, () => this._openPrefsPage('modules'), {variant: 'accent'}));
        // #endif
        this._picker.add_child(actions);

        this._addButton?.spSetOpen(true);
        slideIn(this._picker);
        this._picker.get_children().forEach((child, index) => {
            if (index > 0)
                popIn(child, 30 + index * 25, {distance: 6, duration: 280});
        });
    }

    // #if full
    async _importFile(path) {
        try {
            const id = await this._registry.loadFile(path);
            const paths = this._settings.get_strv('module-paths');
            if (!paths.includes(path)) {
                paths.push(path);
                this._settings.set_strv('module-paths', paths);
            }
            this._addToPanel(id);
        } catch (e) {
            const card = this._errorCard(GLib.path_get_basename(path), e, () => card.destroy());
            this._picker.add_child(card);
            slideIn(card);
        }
    }
    // #endif

    _addToPanel(id) {
        const order = this._settings.get_strv('module-order');
        if (!order.includes(id)) {
            order.push(id);
            this._settings.set_strv('module-order', order);
        }
        this._restoreModule(id);
        this._hidePicker();
    }

    /* Les préférences tournent dans leur propre processus : `prefs-page`
     * leur indique la page à afficher. */
    _openPrefsPage(page) {
        this._hidePicker();
        this.close(true);
        this._settings.set_string('prefs-page', page);
        this._openPreferences();
    }

    /* openPreferences() renvoie une promesse (D-Bus vers le processus des
     * préférences) : un rejet non intercepté ne laisserait aucune trace utile. */
    _openPreferences() {
        try {
            Promise.resolve(this._extension.openPreferences())
                .catch(e => console.error(`[sidepanel] ouverture des préférences : ${e}`));
        } catch (e) {
            console.error(`[sidepanel] ouverture des préférences : ${e}`);
        }
    }

    /* ------------------------------------------------------ géométrie */

    /* Les réglages sont en px logiques (comme le CSS). Les tailles fixées
     * en JS ne sont PAS mises à l'échelle automatiquement par GNOME, alors
     * que les px du CSS le sont : on convertit donc ici, sinon le contenu
     * déborde d'un facteur 2 sur un écran HiDPI. */
    _closedOffset() {
        const s = scaleFactor();
        return (this._settings.get_int('panel-width')
            + this._settings.get_int('panel-margin') + 40) * s;
    }

    /* Appelée par un module dont la hauteur vient de changer (carte qui se
     * déplie au survol) : le panneau épouse son contenu, il doit donc se
     * recalculer. */
    requestRelayout() {
        this._relayout({animate: this._isOpen});
    }

    /** Hauteur naturelle de la colonne, en ignorant un acteur (utile
     * pendant un fondu croisé : on vise la hauteur d'arrivée). */
    _naturalHeight(width, ignore = null) {
        const wasVisible = ignore?.visible;
        if (ignore)
            ignore.hide();
        const [, natural] = this._column.get_preferred_height(width);
        if (ignore && wasVisible)
            ignore.show();
        return natural;
    }

    /**
     * animate : la taille et la position glissent (EASE_OUT_QUART) au lieu
     *           de sauter — indispensable pour tout changement de contenu
     *           panneau ouvert.
     * ignore  : acteur exclu de la mesure (voir _naturalHeight).
     */
    _relayout({animate = false, ignore = null} = {}) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._actor)
            return;

        const s = scaleFactor();
        const margin = this._settings.get_int('panel-margin') * s;
        const width = this._settings.get_int('panel-width') * s;

        /* La ZONE DE TRAVAIL, pas la hauteur brute de l'écran : elle exclut
         * déjà la barre du haut ET tout dock réservant de l'espace en bas
         * (dash-to-panel, ubuntu-dock…). L'ancien calcul ne soustrayait que
         * la barre du haut, si bien que le panneau passait sous le dock. */
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        /* Une respiration verticale minimale, indépendante de la marge
         * latérale : sans elle le panneau s'étirait sur toute la hauteur
         * utile et paraissait écrasé entre la barre du haut et le dock. */
        const vMargin = Math.max(margin, VERTICAL_BREATHING * s);
        const available = work.height - vMargin * 2;

        /* La hauteur épouse le contenu au lieu d'être fixée : un panneau à
         * hauteur constante laissait un immense vide sous la seule carte
         * présente. Le réglage panel-max-height ne sert plus que de
         * plafond. */
        const natural = this._naturalHeight(width, ignore);
        const cap = Math.min(available, this._settings.get_int('panel-max-height') * s);
        const height = Math.max(160 * s, Math.min(cap, natural));
        const x = work.x + work.width - width - margin;
        let y = work.y + Math.round((work.height - height) / 2);

        this._actor.set_pivot_point(1.0, 0.5);
        if (animate && this._isOpen && this._actor.visible) {
            /* Contenu qui change panneau ouvert : le HAUT reste ancré et
             * seule la hauteur glisse — se recentrer à chaque changement
             * faisait bouger tout le panneau. Le bas doit rester dans la
             * zone de travail. */
            const top = this._actor.y;
            y = clamp(top, work.y + vMargin, work.y + work.height - vMargin - height);
            this._actor.width = width;
            this._actor.x = x;
            this._actor.remove_transition('height');
            this._actor.remove_transition('y');
            this._actor.ease({
                height, y,
                duration: 600, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._actor.set_size(width, height);
            this._actor.set_position(x, y);
        }

        const edge = this._settings.get_int('edge-width') * s;
        this._edge.set_size(edge, work.height);
        this._edge.set_position(work.x + work.width - edge, work.y);

        if (!this._isOpen)
            this._actor.translation_x = this._closedOffset();
    }

    /* ---------------------------------------------------- ouverture */

    get isOpen() {
        return this._isOpen;
    }

    open() {
        this._cancelHide();
        if (this._isOpen)
            return;
        this._isOpen = true;

        const duration = this._settings.get_int('animation-duration');
        const bounce = this._settings.get_boolean('bounce');

        this._actor.remove_all_transitions();
        this._actor.show();
        /* Pas d'échelle : combiner un scale à pivot droit avec un
         * EASE_OUT_BACK sur translation_x faisait se contrarier les deux
         * courbes et cassait le rebond. Le rebond porte sur la translation
         * seule ; l'opacité monte plus vite pour éviter l'effet « fantôme ».
         * Sans rebond, EASE_OUT_QUINT : arrivée rapide puis freinage doux. */
        this._actor.set_scale(1, 1);
        this._actor.opacity = 0;
        this._actor.ease({
            opacity: 255,
            duration: Math.min(160, duration),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._actor.ease({
            translation_x: 0,
            duration,
            mode: bounce ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUART,
            onComplete: () => Main.layoutManager._queueUpdateRegions?.(),
        });
        this._edge.remove_all_transitions();
        this._edge.ease({opacity: 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        /* les cartes glissent en cascade depuis le bord, un peu plus vite
         * que le panneau pour donner de la profondeur */
        const stagger = Math.max(30, Math.round(duration * 0.1));
        this._cards.forEach((card, i) => popIn(card, 30 + i * stagger,
            {distance: 24, duration: Math.round(duration * 0.8)}));
        if (this._emptyState?.visible)
            popIn(this._emptyState, 40, {distance: 22});
        if (this._grid.visible) {
            (this._tiles ?? []).forEach((tile, i) => {
                tile.remove_all_transitions();
                tile.set_pivot_point(0.5, 0.5);
                tile.opacity = 0;
                tile.set_scale(0.9, 0.9);
                tile.ease({
                    opacity: 255, scale_x: 1, scale_y: 1,
                    delay: 40 + i * 24, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_QUART,
                });
            });
        }
        if (this._focus.visible)
            popIn(this._focus, 30, {distance: 24, duration: Math.round(duration * 0.8)});

        this._background.start();
        this._cards.forEach(c => c.onPanelOpened());
        if (this._focusedId)
            this._gridCards.get(this._focusedId)?.onPanelOpened?.();
    }

    close(force = false) {
        if (!this._isOpen)
            return;
        if (!force && (this._pinned || this._shouldStayOpen()))
            return;
        this._isOpen = false;
        this._cancelHide();

        /* Sortie courte en EASE_OUT : une courbe EASE_IN donnait une
         * impression de latence au départ, alors que le panneau doit
         * réagir immédiatement puis s'effacer. */
        this._actor.remove_all_transitions();
        this._actor.ease({
            translation_x: this._closedOffset(),
            opacity: 0,
            duration: Math.round(this._settings.get_int('animation-duration') * 0.5),
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
            onComplete: () => {
                this._actor.hide();
                Main.layoutManager._queueUpdateRegions?.();
            },
        });
        this._edge.remove_all_transitions();
        this._edge.ease({opacity: 255, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._picker?.hide();
        this._addButton?.spSetOpen(false);
        this._background.stop();
        this._cards.forEach(c => c.onPanelClosed());
        if (this._focusedId)
            this._gridCards.get(this._focusedId)?.onPanelClosed?.();
    }

    toggle() {
        if (this._isOpen) {
            this.setPinned(false);
            this.close(true);
        } else {
            this.open();
            this.setPinned(true);
        }
    }

    setPinned(pinned) {
        this._pinned = pinned;
        this._pinButton.spSetActive(pinned, {animate: true});
        if (!pinned && !this._actor.hover)
            this._scheduleHide();
    }

    setEditMode(editing) {
        this._editMode = editing;
        /* En édition on épingle : sinon le panneau se referme pendant qu'on
         * réorganise. Quitter l'édition désépingle. */
        this.setPinned(editing);
        this._cards.forEach(c => c.setEditMode(editing));
        this._editButton.spSetActive(editing, {animate: true});
        /* Le titre reste « Panneau » comme dans la maquette : l'état est
         * déjà porté par la pastille blanche du bouton. */
    }

    _shouldStayOpen() {
        /* Le sélecteur de modules NE compte PAS ici : il restait visible
         * indéfiniment après un clic sur ＋, ce qui bloquait le panneau en
         * position ouverte. Il est refermé à la fermeture du panneau. */
        if (this._grab || this._dragCard)
            return true;
        /* PAS de condition sur le focus clavier : après un clic, un bouton
         * garde le focus, et « un enfant a le focus » bloquait le panneau
         * ouvert pour toujours. Seul le grab de saisie retient le panneau. */
        return this._actor.hover;
    }

    _scheduleHide() {
        this._cancelHide();
        if (this._pinned)
            return;
        if (this._grab)
            return;
        this._hideTimer = timeoutAdd(this._settings.get_int('hide-delay'), () => {
            this._hideTimer = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHide() {
        this._hideTimer = sourceRemove(this._hideTimer);
    }

    /* ------------------------------------------ saisie clavier (modal) */

    /* GNOME ne délivre les touches au shell que sous grab : tout module
     * contenant un champ de saisie doit appeler panel.enterEditMode(entry). */
    enterEditMode(focusActor) {
        if (this._grab) {
            if (focusActor)
                global.stage.set_key_focus(focusActor);
            return true;
        }
        this.open();
        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.NORMAL});
        if (!this._grab)
            return false;

        this._stageClickId = global.stage.connect('button-press-event', (_a, event) => {
            const [x, y] = event.get_coords();
            const [px, py] = this._actor.get_transformed_position();
            const [pw, ph] = this._actor.get_transformed_size();
            if (x < px || x > px + pw || y < py || y > py + ph) {
                this.leaveEditMode();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        if (focusActor)
            global.stage.set_key_focus(focusActor);
        return true;
    }

    leaveEditMode() {
        if (!this._grab)
            return;
        if (this._stageClickId) {
            global.stage.disconnect(this._stageClickId);
            this._stageClickId = 0;
        }
        global.stage.set_key_focus(null);
        Main.popModal(this._grab);
        this._grab = null;
        if (!this._actor?.hover)
            this._scheduleHide();
    }

    /* -------------------------------------------------------- raccourci */

    _bindShortcut() {
        Main.wm.addKeybinding('toggle-panel', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
        this._shortcutBound = true;
    }

    _rebindShortcut() {
        if (this._shortcutBound)
            Main.wm.removeKeybinding('toggle-panel');
        this._bindShortcut();
    }

    /* ---------------------------------------------------------- cycle */

    _rebuild() {
        const wasOpen = this._isOpen;
        this._teardownUI();
        this._build();
        if (wasOpen)
            this.open();
    }

    _teardownUI() {
        this._cancelHide();
        this._calibrateId = sourceRemove(this._calibrateId);
        this._calibrations = 0;
        this.leaveEditMode();
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (_e) {}
        }
        this._signals = [];
        this._cards = [];
        this._destroyGridCards();

        if (this._actor) {
            this._background?.stop();
            Main.layoutManager.removeChrome(this._actor);
            this._actor.destroy();
            this._actor = null;
        }
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
            this._edge = null;
        }
        this._isOpen = false;
        this._pinned = false;
    }

    destroy() {
        if (this._shortcutBound) {
            Main.wm.removeKeybinding('toggle-panel');
            this._shortcutBound = false;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._workAreaId) {
            global.display.disconnect(this._workAreaId);
            this._workAreaId = 0;
        }
        if (this._panelBoxId) {
            Main.layoutManager.panelBox.disconnect(this._panelBoxId);
            this._panelBoxId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._teardownUI();
        this._settings = null;
        this._extension = null;
    }
}
