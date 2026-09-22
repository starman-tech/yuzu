// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/tracker.js — Time-Tracker passif, maquette « Apple Liquid Glass ».
 *
 * 100 % local : aucune télémétrie, aucun serveur. Le temps est mesuré en
 * écoutant `notify::focus-window` sur `global.display`, et stocké dans un
 * fichier JSON sous ~/.config/yuzu/.
 *
 * Trois écarts assumés par rapport au CSS de référence, chacun imposé par
 * une limite de St (le moteur de style de GNOME Shell) :
 *
 *   • `backdrop-filter: blur(50px) saturate(250%)` n'existe pas dans St.
 *     Le flou d'arrière-plan est déjà rendu par le panneau lui-même
 *     (Shell.BlurEffect) ; la carte pose donc uniquement sa teinte de verre.
 *   • `linear-gradient(135deg, …)` : St ne gère que vertical / horizontal /
 *     radial. Les carrés d'icônes utilisent un dégradé vertical, avec les
 *     deux teintes exactes de la maquette.
 *   • `transition` et `@keyframes` n'existent pas : toutes les animations
 *     (survol, cascade des sous-éléments, remplissage des barres) sont
 *     jouées en JS via Clutter, avec les mêmes durées et courbes.
 *
 * Mise à l'échelle : k pour la proportion du design (maquette dessinée pour
 * 380 px), s pour le HiDPI — ce dernier uniquement sur les tailles fixées
 * via les propriétés d'acteur.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {setVectorIcon, vectorIcon} from '../lib/vectorIcons.js';
import {MODULE} from '../lib/theme.js';
import {clamp, configDir, configFile, scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';

const DESIGN_WIDTH = 380;
const VISIBLE_ROWS = 3;          // la maquette en montre trois
const SUB_ITEMS = 3;             // trois sous-éléments par application
const SAVE_INTERVAL = 30;        // secondes entre deux écritures disque
const IDLE_THRESHOLD = 180;      // secondes d'inactivité avant suspension

/* Palette vibrante Apple : [teinte claire, teinte foncée, couleur de barre].
 * Les applications connues gardent leur couleur d'identité. */
const SIGNATURES = [
    {match: /spotify/i,                          light: '#5EE07F', dark: '#1DB954', bar: '#32D74B', icon: 'ui-window'},
    {match: /code|codium|vscode/i,               light: '#3291FF', dark: '#0052CC', bar: '#0A84FF', icon: 'ui-code'},
    {match: /obsidian/i,                         light: '#A78BFA', dark: '#6D28D9', bar: '#5E5CE6', icon: 'ui-window'},
    {match: /firefox|librewolf|zen/i,            light: '#FF9F5A', dark: '#E85D04', bar: '#FF9F0A', icon: 'ui-globe'},
    {match: /chrome|chromium|brave|vivaldi/i,    light: '#FF5172', dark: '#E00034', bar: '#FF375F', icon: 'ui-globe'},
    {match: /terminal|konsole|kitty|alacritty|ptyxis|foot|wezterm|tilix/i,
        light: '#5EE06F', dark: '#219630', bar: '#32D74B', icon: 'ui-terminal'},
    {match: /jetbrains|idea|pycharm|webstorm|clion/i,
        light: '#FF7BC8', dark: '#C2185B', bar: '#FF375F', icon: 'ui-code'},
    {match: /figma|inkscape|gimp|krita|blender/i,
        light: '#C08BFF', dark: '#7B2FF7', bar: '#BF5AF2', icon: 'ui-palette'},
    {match: /discord|slack|telegram|signal|element|teams/i,
        light: '#7A8CFF', dark: '#3B47C8', bar: '#5E5CE6', icon: 'ui-chat'},
    {match: /thunderbird|geary|evolution/i,
        light: '#5AC8FA', dark: '#0071A4', bar: '#64D2FF', icon: 'ui-chat'},
    {match: /nautilus|files|fichiers/i,
        light: '#FFD60A', dark: '#C77700', bar: '#FFD60A', icon: 'ui-window'},
];

/* Teintes de repli, attribuées de façon stable par nom d'application. */
const FALLBACKS = [
    {light: '#64D2FF', dark: '#0071A4', bar: '#64D2FF'},
    {light: '#FFD60A', dark: '#C77700', bar: '#FFD60A'},
    {light: '#BF5AF2', dark: '#7B2FF7', bar: '#BF5AF2'},
    {light: '#FF9F0A', dark: '#C76A00', bar: '#FF9F0A'},
    {light: '#8E8E93', dark: '#48484A', bar: '#8E8E93'},
];

function signatureFor(appId, appName) {
    const haystack = `${appId ?? ''} ${appName ?? ''}`;
    const hit = SIGNATURES.find(s => s.match.test(haystack));
    if (hit)
        return hit;
    let hash = 0;
    for (const ch of haystack)
        hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return {...FALLBACKS[hash % FALLBACKS.length], icon: 'ui-window'};
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0)
        return `${h}h ${m.toString().padStart(2, '0')}m`;
    if (m > 0)
        return `${m}m`;
    return `${total}s`;
}

function todayKey() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

class TrackerCard {
    constructor(ctx) {
        /* largeur distribuée par le panneau : lui seul connaît la place
         * réellement disponible (padding + barre de défilement) */
        this._moduleWidth = ctx.moduleWidth;
        this._file = configFile('timetracker.json');
        this._day = todayKey();
        this._apps = new Map();      // appId -> {name, seconds, titles:{}}
        this._currentId = null;
        this._currentTitle = '';
        this._currentSince = 0;
        this._dirty = false;
        this._rows = new Map();
        this._expanded = false;
        this._tickTimer = 0;
        this._saveCounter = 0;
        this._paused = false;
        this._history = {};          // 'YYYY-MM-DD' -> secondes (jours précédents)

        this._load();
        this._build();
        this._connectDisplay();
    }

    /* ------------------------------------------------------------- UI */

    _build() {
        const s = scaleFactor();
        const logicalWidth = this._moduleWidth;
        const k = logicalWidth / DESIGN_WIDTH;
        const px = v => Math.max(1, Math.round(v * k));
        const jsx = v => Math.max(1, Math.round(v * k * s));
        this._px = px;
        this._jsx = jsx;

        /* .liquid-widget */
        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: `background-color: ${MODULE.surface}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(24)}px ${px(20)}px; `
                + `color: ${MODULE.text};`,
        });

        /* .header */
        const header = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: `padding: 0 ${px(12)}px;`,
        });
        const titleRow = new St.BoxLayout({x_expand: true});
        titleRow.add_child(new St.Label({
            text: 'AUJOURD\'HUI',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(13)}px; font-weight: bold; `
                + `color: ${MODULE.textDim}; letter-spacing: 0.5px;`,
        }));
        /* pause : le temps ne s'accumule plus tant qu'elle est active */
        this._pauseBtn = new St.Button({
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(3)}px;`,
        });
        this._pauseIcon = vectorIcon('ui-pause', MODULE.textDim, px(14));
        this._pauseBtn.set_child(this._pauseIcon);
        this._pauseBtn.set_accessible_name('Mettre le suivi en pause');
        this._pauseBtn.connect('clicked', () => this._togglePause());
        titleRow.add_child(this._pauseBtn);
        header.add_child(titleRow);

        const totalRow = new St.BoxLayout({x_expand: true, style: `spacing: ${px(10)}px;`});
        this._totalLabel = new St.Label({
            text: '0m',
            y_align: Clutter.ActorAlign.END,
            style: `font-size: ${px(32)}px; font-weight: bold; `
                + `letter-spacing: -1px; color: ${MODULE.text};`,
        });
        this._weekLabel = new St.Label({
            text: '7 J · —',
            y_align: Clutter.ActorAlign.END,
            style: `font-size: ${px(11)}px; font-weight: bold; color: ${MODULE.textMuted}; `
                + `padding-bottom: ${px(6)}px;`,
        });
        totalRow.add_child(this._totalLabel);
        totalRow.add_child(this._weekLabel);
        header.add_child(totalRow);
        this.actor.add_child(header);

        /* .app-list */
        this._list = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: `spacing: ${px(8)}px; padding-top: ${px(20)}px;`,
        });
        this.actor.add_child(this._list);

        this._emptyLabel = new St.Label({
            text: 'Aucune activité enregistrée pour l\'instant.',
            style: `font-size: ${px(13)}px; color: ${MODULE.textDim}; `
                + `padding: ${px(16)}px ${px(16)}px;`,
        });
        this._list.add_child(this._emptyLabel);

        /* « Voir plus » — hors maquette, requis par la limite à trois lignes */
        this._moreButton = new St.Button({
            x_expand: true,
            can_focus: true,
            style: `background-color: transparent; border: none; `
                + `padding: ${px(12)}px 0 ${px(4)}px 0; `
                + `color: ${MODULE.textDim}; font-size: ${px(13)}px; `
                + `font-weight: bold;`,
        });
        this._moreButton.connect('clicked', () => {
            this._expanded = !this._expanded;
            this._refresh();
        });
        this._moreButton.hide();
        this.actor.add_child(this._moreButton);
    }

    setTheme(_theme) {}

    /* --------------------------------------------------- mesure du temps */

    _connectDisplay() {
        this._focusId = global.display.connect('notify::focus-window',
            () => this._onFocusChanged());
        this._onFocusChanged();
    }

    _now() {
        return GLib.get_monotonic_time() / 1e6;
    }

    _idleSeconds() {
        try {
            return global.backend.get_core_idle_monitor().get_idletime() / 1000;
        } catch (_e) {
            return 0;
        }
    }

    /* Nettoie le titre de fenêtre : les navigateurs et éditeurs y collent
     * leur propre nom (« MDN — Mozilla Firefox »), qui est déjà affiché sur
     * la ligne au-dessus. */
    _cleanTitle(title, appName) {
        if (!title)
            return '';
        let out = title.replace(/\s*[-—–|]\s*(Google Chrome|Chromium|Mozilla Firefox|Firefox|Brave|Microsoft Edge|Opera|Vivaldi|Obsidian|Visual Studio Code|VSCodium)\s*$/i, '');
        if (appName)
            out = out.replace(new RegExp(`\\s*[-—–|]\\s*${appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
        return out.trim() || title;
    }

    /* Un changement d'ONGLET ne déclenche pas notify::focus-window : la
     * fenêtre reste la même, seul son titre change. Sans cette écoute, tout
     * le temps passé dans un navigateur était attribué au premier onglet. */
    _watchTitle(win) {
        if (this._titleWin && this._titleId) {
            try {
                this._titleWin.disconnect(this._titleId);
            } catch (_e) {}
        }
        this._titleWin = win;
        this._titleId = win
            ? win.connect('notify::title', () => this._onTitleChanged())
            : 0;
    }

    _onTitleChanged() {
        this._commitCurrent();          // clôt l'intervalle de l'onglet quitté
        const win = this._titleWin;
        if (!win)
            return;
        const entry = this._apps.get(this._currentId);
        this._currentTitle = this._cleanTitle(win.get_title(), entry?.name)
            || entry?.name || '';
        this._currentSince = this._now();
    }

    _onFocusChanged() {
        this._commitCurrent();

        const win = global.display.focus_window;
        if (!win) {
            this._watchTitle(null);
            this._currentId = null;
            return;
        }

        let appId = null;
        let appName = null;
        try {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            appId = app?.get_id() ?? null;
            appName = app?.get_name() ?? null;
        } catch (_e) {}

        if (!appId) {
            appId = win.get_wm_class() ?? 'inconnu';
            appName = appId;
        }

        const entry = this._apps.get(appId)
            ?? {name: appName ?? appId, seconds: 0, titles: {}};
        entry.name = appName ?? entry.name;
        this._apps.set(appId, entry);

        this._currentId = appId;
        this._currentTitle = this._cleanTitle(win.get_title(), entry.name) || entry.name;
        this._currentSince = this._now();
        this._watchTitle(win);
    }

    /* Additionne l'intervalle réel écoulé, sur l'application ET sur le titre
     * de fenêtre courant — c'est ce qui alimente les sous-éléments.
     * Horodater les changements plutôt qu'incrémenter chaque seconde évite
     * de compter le temps écran verrouillé ou machine en veille. */
    _commitCurrent() {
        if (!this._currentId)
            return;
        const elapsed = this._now() - this._currentSince;
        this._currentSince = this._now();
        if (this._paused || elapsed <= 0 || this._idleSeconds() > IDLE_THRESHOLD)
            return;

        const entry = this._apps.get(this._currentId);
        if (!entry)
            return;
        entry.seconds += elapsed;
        if (this._currentTitle) {
            entry.titles[this._currentTitle] =
                (entry.titles[this._currentTitle] ?? 0) + elapsed;
        }
        this._dirty = true;
    }

    _togglePause() {
        this._commitCurrent();
        this._paused = !this._paused;
        setVectorIcon(this._pauseIcon, this._paused ? 'ui-play' : 'ui-pause',
            this._paused ? MODULE.accentInk : MODULE.textDim);
        this._pauseBtn.set_style(`background-color: ${this._paused ? MODULE.accent : MODULE.inset}; `
            + `border: 2px solid ${this._paused ? MODULE.stroke : MODULE.strokeSoft}; `
            + `border-radius: ${this._px(3)}px; padding: ${this._px(3)}px;`);
        this._pauseBtn.set_accessible_name(this._paused ? 'Reprendre le suivi' : 'Mettre le suivi en pause');
        this._currentSince = this._now();
    }

    _todayTotal() {
        let total = 0;
        for (const e of this._apps.values())
            total += e.seconds;
        return total;
    }

    /** Total des 7 derniers jours (historique + aujourd'hui). */
    _weekTotal() {
        const now = GLib.DateTime.new_now_local();
        let total = this._todayTotal();
        for (let i = 1; i < 7; i++) {
            const key = now.add_days(-i).format('%Y-%m-%d');
            total += this._history[key] ?? 0;
        }
        return total;
    }

    _rolloverIfNeeded() {
        const key = todayKey();
        if (key === this._day)
            return;
        this._history[this._day] = Math.round(this._todayTotal());
        this._save();
        this._day = key;
        this._apps.clear();
        this._rows.forEach(row => row.actor.destroy());
        this._rows.clear();
        this._currentSince = this._now();
    }

    /* --------------------------------------------------------- affichage */

    _refresh() {
        if (this._destroyed || !this._totalLabel)
            return;
        this._rolloverIfNeeded();
        this._commitCurrent();

        const entries = [...this._apps.entries()]
            .map(([id, e]) => ({id, ...e}))
            .filter(e => e.seconds >= 1)
            .sort((a, b) => b.seconds - a.seconds);

        /* Le maximum des barres est le TEMPS TOTAL : chaque barre représente
         * donc la part réelle de l'application dans la journée. */
        const total = entries.reduce((sum, e) => sum + e.seconds, 0);
        this._totalLabel.text = formatDuration(total);
        this._weekLabel.text = `7 J · ${formatDuration(this._weekTotal())}`;
        this._emptyLabel.visible = entries.length === 0;

        const shown = this._expanded ? entries : entries.slice(0, VISIBLE_ROWS);
        const keep = new Set(shown.map(e => e.id));

        for (const [id, row] of this._rows) {
            if (!keep.has(id)) {
                row.actor.destroy();
                this._rows.delete(id);
            }
        }

        shown.forEach((entry, index) => {
            let row = this._rows.get(entry.id);
            if (!row) {
                row = this._makeRow(entry);
                this._rows.set(entry.id, row);
                this._list.add_child(row.actor);
            }
            this._list.set_child_at_index(row.actor, index + 1);
            this._updateRow(row, entry, total);
        });

        const hidden = entries.length - shown.length;
        this._moreButton.visible = entries.length > VISIBLE_ROWS;
        this._moreButton.label = this._expanded
            ? 'Voir moins'
            : `Voir plus (${hidden})`;
    }

    /* .app-card */
    _makeRow(entry) {
        const px = this._px;
        const jsx = this._jsx;
        const sig = signatureFor(entry.id, entry.name);

        const card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            reactive: true,
            track_hover: true,
            style: `border-radius: ${px(MODULE.radius)}px; padding: ${px(14)}px; `
                + `border: 2px solid transparent;`,
        });
        card.set_pivot_point(0.5, 0.5);

        /* .app-main */
        const main = new St.BoxLayout({x_expand: true, style: `spacing: ${px(16)}px;`});

        /* .app-icon — carré arrondi à dégradé, contenant la VRAIE icône de
         * l'application quand le système la connaît. */
        const iconBin = new St.Bin({
            width: jsx(44),
            height: jsx(44),
            y_align: Clutter.ActorAlign.CENTER,
            style: `border-radius: ${px(MODULE.radius)}px; border: 2px solid ${MODULE.stroke}; `
                + `background-gradient-direction: vertical; `
                + `background-gradient-start: ${sig.light}; `
                + `background-gradient-end: ${sig.dark};`,
        });
        iconBin.set_child(this._appIcon(entry.id, sig, px(24)));

        /* .app-info */
        const info = new St.BoxLayout({vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});

        const headerRow = new St.BoxLayout({x_expand: true});
        const nameLabel = new St.Label({
            text: entry.name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(17)}px; font-weight: bold; `
                + `letter-spacing: -0.3px; color: ${MODULE.text};`,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const timeLabel = new St.Label({
            text: '0m',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(17)}px; font-weight: bold; color: ${MODULE.text};`,
        });
        headerRow.add_child(nameLabel);
        headerRow.add_child(timeLabel);

        /* .mini-track — boîte HORIZONTALE : elle empile ses enfants depuis la
         * gauche par construction. Un BinLayout centrait le remplissage, ce
         * qui faisait démarrer la barre au milieu. */
        const track = new St.BoxLayout({
            x_expand: true,
            height: jsx(4),
            style: `background-color: ${MODULE.strokeSoft}; `
                + `border-radius: 0px; margin-top: ${px(4)}px;`,
        });
        const fill = new St.Widget({
            width: 0,
            y_expand: true,
            style: `background-color: ${sig.bar}; border-radius: 0px;`,
        });
        track.add_child(fill);
        track.connect('notify::width', () => this._applyFill(row));

        info.add_child(headerRow);
        info.add_child(track);

        main.add_child(iconBin);
        main.add_child(info);
        card.add_child(main);

        /* .sub-items — repliés, révélés au survol */
        const subBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            height: 0,
            clip_to_allocation: true,
            style: `padding-left: ${px(56)}px; spacing: ${px(12)}px;`,
        });
        card.add_child(subBox);

        const row = {
            actor: card, nameLabel, timeLabel, track, fill, subBox,
            subLabels: [], ratio: -1, signature: sig,
        };

        card.connect('notify::hover', () => this._setCardHover(row, card.hover));
        return row;
    }

    /** Icône réelle de l'application, sinon repli vectoriel. */
    _appIcon(appId, signature, size) {
        try {
            const app = Shell.AppSystem.get_default().lookup_app(appId);
            const gicon = app?.get_icon();
            if (gicon)
                return new St.Icon({gicon, icon_size: size});
        } catch (_e) {}
        return vectorIcon(signature.icon, MODULE.text, size);
    }

    _updateRow(row, entry, total) {
        row.nameLabel.text = entry.name;
        row.timeLabel.text = formatDuration(entry.seconds);
        row.ratio = clamp(entry.seconds / Math.max(1, total), 0, 1);
        this._applyFill(row);
        this._updateSubItems(row, entry);
    }

    _applyFill(row) {
        /* hors scène, lire `width` fait calculer à St une taille sans thème
         * (St-CRITICAL) : get_stage() d'abord, notify::width rappellera */
        if (!row?.track || !row.track.get_stage() || row.track.width <= 0 || row.ratio < 0)
            return;
        const target = Math.round(row.track.width * row.ratio);
        if (Math.abs(target - row.fill.width) < 1)
            return;
        row.fill.remove_all_transitions();
        /* même courbe et durée que .mini-fill : 1s cubic-bezier(.16,1,.3,1) */
        row.fill.ease({
            width: target,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
    }

    /* Trois principaux titres de fenêtre pour cette application. */
    _updateSubItems(row, entry) {
        const px = this._px;
        const top = Object.entries(entry.titles ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, SUB_ITEMS);

        while (row.subLabels.length > top.length) {
            row.subLabels.pop().actor.destroy();
        }

        top.forEach(([title, seconds], index) => {
            let item = row.subLabels[index];
            if (!item) {
                const line = new St.BoxLayout({x_expand: true});
                const name = new St.Label({
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `font-size: ${px(13)}px; color: ${MODULE.textDim}; `
                        + `max-width: ${px(160)}px;`,
                });
                name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                name.clutter_text.line_wrap = false;
                const time = new St.Label({
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `font-size: ${px(13)}px; color: ${MODULE.text};`,
                });
                line.add_child(name);
                line.add_child(time);
                line.opacity = 0;
                row.subBox.add_child(line);
                item = {actor: line, name, time};
                row.subLabels[index] = item;
            }
            item.name.text = title;
            item.time.text = formatDuration(seconds);
        });
    }

    /* Survol : agrandissement de la carte + déroulé des sous-éléments en
     * cascade. `transition` et `grid-template-rows` n'existent pas dans St :
     * on anime la hauteur et chaque ligne à la main. */
    _setCardHover(row, hovered) {
        const px = this._px;
        const card = row.actor;

        card.remove_all_transitions();
        card.ease({
            translation_x: hovered ? this._jsx(3) : 0,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        card.set_style(hovered
            ? `border-radius: ${px(MODULE.radius)}px; padding: ${px(14)}px; `
              + `background-color: ${MODULE.inset}; `
              + `border: 2px solid ${MODULE.stroke};`
            : `border-radius: ${px(MODULE.radius)}px; padding: ${px(14)}px; `
              + `border: 2px solid transparent;`);

        const count = row.subLabels.length;
        if (count === 0)
            return;

        row.subBox.remove_all_transitions();
        if (hovered) {
            const [, natural] = row.subBox.get_preferred_height(row.subBox.width);
            row.subBox.ease({
                height: natural + this._jsx(16),
                duration: 400,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            row.subLabels.forEach((item, index) => {
                item.actor.remove_all_transitions();
                item.actor.translation_y = -this._jsx(5);
                item.actor.ease({
                    opacity: 255,
                    translation_y: 0,
                    delay: 100 + index * 50,   // cascade de la maquette
                    duration: 300,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
        } else {
            row.subLabels.forEach(item => {
                item.actor.remove_all_transitions();
                item.actor.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
            row.subBox.ease({
                height: 0,
                duration: 400,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /* ------------------------------------------------------- persistance */

    _load() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._file);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            this._history = data?.history ?? {};
            if (data?.day !== todayKey()) {
                /* autre journée : son total rejoint l'historique, on repart de zéro */
                if (data?.day && data?.apps) {
                    this._history[data.day] = Object.values(data.apps)
                        .reduce((sum, e) => sum + (e.seconds ?? 0), 0);
                }
                return;
            }
            this._day = data.day;
            for (const [id, entry] of Object.entries(data.apps ?? {}))
                this._apps.set(id, {titles: {}, ...entry});
        } catch (_e) {
            /* premier lancement ou fichier illisible */
        }
    }

    _save() {
        try {
            configDir();
            const apps = {};
            for (const [id, entry] of this._apps) {
                const titles = {};
                for (const [title, seconds] of Object.entries(entry.titles ?? {}))
                    titles[title] = Math.round(seconds);
                apps[id] = {
                    name: entry.name,
                    seconds: Math.round(entry.seconds),
                    titles,
                };
            }
            /* l'historique ne garde que deux semaines */
            const cutoff = GLib.DateTime.new_now_local().add_days(-14).format('%Y-%m-%d');
            const history = {};
            for (const [day, seconds] of Object.entries(this._history)) {
                if (day >= cutoff && day !== this._day)
                    history[day] = seconds;
            }
            this._history = history;
            GLib.file_set_contents(this._file,
                JSON.stringify({day: this._day, apps, history}, null, 2));
            this._dirty = false;
        } catch (e) {
            console.error(`[yuzu] sauvegarde du suivi : ${e}`);
        }
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._refresh();
        if (this._tickTimer)
            return;
        this._tickTimer = timeoutAdd(1000, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._refresh();
            if (++this._saveCounter % SAVE_INTERVAL === 0 && this._dirty)
                this._save();
            return GLib.SOURCE_CONTINUE;
        });
    }

    onClose() {
        this._tickTimer = sourceRemove(this._tickTimer);
        this._commitCurrent();
        if (this._dirty)
            this._save();
    }

    destroy() {
        this._destroyed = true;
        this._tickTimer = sourceRemove(this._tickTimer);
        this._commitCurrent();
        this._save();
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        this._watchTitle(null);
    }
}

export default {
    id: 'tracker',
    title: 'Suivi du temps',
    short: 'Suivi',
    icon: 'ui-clock',
    build(ctx) {
        return new TrackerCard(ctx);
    },
};
