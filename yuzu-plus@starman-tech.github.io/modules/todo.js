// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/todo.js — Liste de tâches « Liquid Glass », maquette Apple.
 *
 * Design, dimensions et animations repris à l'identique de la maquette de
 * référence. Les corrections ci-dessous ne touchent pas au rendu : elles
 * remplacent des constructions que St ignore silencieusement (le style
 * n'était alors pas appliqué du tout) ou qui lèvent une erreur.
 *
 * Correctifs par rapport à la version fournie :
 *   • `linear-gradient(135deg, …)` → St ne gère que
 *     `background-gradient-direction: vertical|horizontal|radial`. Le
 *     dégradé du bouton + est donc vertical, avec les deux mêmes teintes.
 *   • `border-radius: 50%` → St exige des pixels : rayon = moitié du côté.
 *   • `opacity` / `scale-x` dans une chaîne de style → ce ne sont pas des
 *     propriétés CSS de St, mais des propriétés d'acteur, fixées en JS.
 *   • signaux `pressed` / `released` → n'existent pas sur St.Button ;
 *     ce sont `button-press-event` / `button-release-event`.
 *   • `file.replace_contents(json, …)` → attend des octets, pas une
 *     chaîne ; `GLib.file_set_contents` est utilisé partout ailleurs dans
 *     le projet.
 *   • `enter-event` / `leave-event` sur la ligne → ne se déclenchent que
 *     si l'acteur est `reactive: true`, sinon le bouton de suppression
 *     restait invisible en permanence.
 *   • `box-shadow` sur un coin arrondi → St le peint en rectangle et
 *     produit des coins noirs ; la lueur verte passe par la bordure.
 *   • Le champ de saisie appelle `panel.enterEditMode()` : sans grab
 *     modal, GNOME n'envoie AUCUNE frappe au shell et le champ restait
 *     inutilisable.
 *
 * Persistance : ~/.config/yuzu/todos.json, comme les autres
 * modules du projet.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {configDir, configFile, scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';
import {MODULE, PALETTE} from '../lib/theme.js';
import {vectorIcon} from '../lib/vectorIcons.js';

const DESIGN_WIDTH = 390;
const MAX_COMPLETED = 5;        // au-delà, la plus ancienne s'efface

/* palette du panneau : orange = action/terminé, nuit = encre */
const ACCENT = PALETTE.orange;
const ACCENT_LIGHT = PALETTE.orangeSoft;
const ACCENT_INK = PALETTE.navyDeep;
const POSITIVE = PALETTE.orange;
const POSITIVE_BG = 'rgba(245, 79, 27, 0.10)';
const POSITIVE_BORDER = 'rgba(245, 79, 27, 0.55)';

/* ------------------------------------------------------- checkbox animée */

const TodoCheckbox = GObject.registerClass(
class TodoCheckbox extends St.Button {
    _init(px, jsx, checked, onChange) {
        super._init({
            can_focus: true,
            reactive: true,
            /* Sans y_align, la case est ÉTIRÉE sur toute la hauteur de la
             * ligne par le BoxLayout parent : elle devenait une pilule
             * verticale au lieu d'un carré. */
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._px = px;
        this._jsx = jsx;
        this._checked = checked;
        this._onChange = onChange;

        const container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true,
        });

        this._checkLabel = new St.Label({
            text: checked ? '✓' : '',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(12)}px; font-weight: bold; color: ${ACCENT_INK};`,
        });

        /* Le « shine » : disque blanc qui jaillit au cochage. Sa taille et
         * son rayon sont en pixels (St refuse les pourcentages), et son
         * opacité/échelle sont des propriétés d'acteur, pas du CSS. */
        const shineSize = px(20);
        this._shine = new St.Widget({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${MODULE.text}; `
                + `border-radius: ${Math.round(shineSize / 2)}px; `
                + `width: ${shineSize}px; height: ${shineSize}px;`,
        });
        /* opacité de crête volontairement basse : à 255 le disque blanc
         * écrasait complètement la case et « flashait ». */
        this._shine.set_pivot_point(0.5, 0.5);
        this._shine.opacity = 0;
        this._shine.set_scale(0.4, 0.4);

        /* le disque d'abord : ajouté après, il recouvrait la coche */
        container.add_child(this._shine);
        container.add_child(this._checkLabel);
        this.set_child(container);

        /* Une seule source de vérité pour la taille : la propriété
         * d'acteur, en unités périphérique (jsx). La déclarer AUSSI en CSS
         * faisait cohabiter deux valeurs différentes sur un écran HiDPI
         * (22 côté acteur, 44 côté CSS) — d'où la case déformée. */
        this.set_size(jsx(22), jsx(22));
        this.set_pivot_point(0.5, 0.5);
        this._updateStyle(checked);

        this.connect('clicked', () => this._toggle());
    }

    _updateStyle(checked) {
        const px = this._px;
        const common = `border-radius: ${px(3)}px; padding: 0;`;
        if (checked) {
            this.set_style(`background-color: ${POSITIVE}; `
                + `border: 2px solid ${POSITIVE}; ${common}`);
            this._checkLabel.text = '✓';
        } else {
            this.set_style(`background-color: transparent; `
                + `border: 2px solid ${MODULE.stroke}; ${common}`);
            this._checkLabel.text = '';
        }
    }

    setChecked(checked) {
        this._checked = checked;
        this._updateStyle(checked);
    }

    _toggle() {
        this._checked = !this._checked;
        this._updateStyle(this._checked);
        if (this._checked)
            this._animateCheck();
        else
            this._animateUncheck();
        this._onChange?.(this._checked);
    }

    /* Rebond en quatre temps : 1.4 (avec bascule -6°) → 0.9 → 1.1 → 1,
     * exactement la séquence de la maquette. */
    _animateCheck() {
        this.remove_all_transitions();
        this.set_scale(1, 1);
        this.rotation_angle_z = 0;

        const step = (sx, sy, rot, duration, next) => ({
            scale_x: sx, scale_y: sy, rotation_angle_z: rot,
            duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: next,
        });

        this.ease(step(1.4, 1.4, -6, 180, () => {
            this.ease(step(0.9, 0.9, 0, 60, () => {
                this.ease(step(1.1, 1.1, 0, 60, () => {
                    this.ease(step(1, 1, 0, 80, null));
                }));
            }));
        }));

        this._shine.remove_all_transitions();
        this._shine.opacity = 0;
        this._shine.set_scale(0.4, 0.4);
        /* Une onde brève qui s'ouvre en s'effaçant, en UN seul mouvement.
         * La version précédente montait à l'opacité maximale — un aplat
         * blanc qui masquait la case — puis se rétractait, ce qui donnait
         * un clignotement disgracieux. */
        this._shine.ease({
            opacity: 90, scale_x: 1.5, scale_y: 1.5,
            duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._shine.ease({
                opacity: 0, scale_x: 2.4, scale_y: 2.4,
                duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._shine.set_scale(0.4, 0.4),
            }),
        });
    }

    _animateUncheck() {
        this.remove_all_transitions();
        this.ease({
            scale_x: 1.1, scale_y: 1.1,
            duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.ease({
                scale_x: 1, scale_y: 1,
                duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }),
        });
    }
});

/* ------------------------------------------------------- ligne de tâche */

const TodoRow = GObject.registerClass(
class TodoRow extends St.BoxLayout {
    _init(task, px, jsx, callbacks) {
        super._init({
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            /* reactive : sans lui, enter-event/leave-event ne se
             * déclenchent jamais et le bouton ✕ reste invisible. */
            reactive: true,
            track_hover: true,
        });

        this._task = task;
        this._px = px;
        this._jsx = jsx;
        this._callbacks = callbacks;
        this.set_pivot_point(0.5, 0.5);

        this._baseStyle = `background-color: ${MODULE.inset}; `
            + `border: 2px solid ${MODULE.strokeSoft}; `
            + `border-radius: ${px(MODULE.radius)}px; `
            + `padding: ${px(12)}px ${px(14)}px; spacing: ${px(12)}px;`;
        this._completedStyle = `background-color: ${POSITIVE_BG}; `
            + `border: 2px solid ${POSITIVE_BORDER}; `
            + `border-radius: ${px(MODULE.radius)}px; `
            + `padding: ${px(12)}px ${px(14)}px; spacing: ${px(12)}px;`;

        this._checkbox = new TodoCheckbox(px, jsx, task.completed,
            checked => this._callbacks.onToggle(this._task, checked, this));
        this.add_child(this._checkbox);

        this._textLabel = new St.Label({
            text: task.text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(14)}px; color: ${MODULE.text};`,
        });
        this._textLabel.clutter_text.line_wrap = true;
        /* double-clic sur le texte : édition en place */
        this._textLabel.reactive = true;
        this._textLabel.connect('button-press-event', (_a, event) => {
            if (event.get_click_count() === 2) {
                this._startEdit();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.add_child(this._textLabel);

        this._deleteBtn = new St.Button({
            can_focus: true,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: transparent; border: none; `
                + `border-radius: ${px(3)}px; padding: 0;`,
        });
        /* taille en propriété d'acteur (jsx) et une seule source, comme la
         * case à cocher : déclarée en CSS, elle cohabitait avec l'étirement
         * de la rangée et le bouton n'était pas carré. */
        this._deleteBtn.set_size(jsx(28), jsx(28));
        this._deleteLabel = new St.Label({
            text: '✕',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(15)}px; color: ${MODULE.textMuted};`,
        });
        this._deleteBtn.set_child(this._deleteLabel);

        /* La croix vire au rouge quand on la survole elle-même (et pas la
         * ligne entière) : c'est ce que fait `.delete-btn:hover` du CSS. */
        this._deleteBtn.connect('notify::hover', () => {
            const hovered = this._deleteBtn.hover;
            this._deleteLabel.set_style(
                `font-size: ${px(15)}px; color: ${hovered ? MODULE.negative : MODULE.textMuted};`);
            this._deleteBtn.set_style(
                `background-color: ${hovered ? MODULE.negativeBg : 'transparent'}; `
                + `border: none; border-radius: ${px(3)}px; padding: 0;`);
        });
        this._deleteBtn.opacity = 0;
        this._deleteBtn.connect('clicked',
            () => this._callbacks.onDelete(this._task, this));
        this.add_child(this._deleteBtn);

        this.connect('notify::hover', () => {
            this._deleteBtn.remove_all_transitions();
            this._deleteBtn.ease({
                opacity: this.hover ? 255 : 0,
                duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });

        this.set_style(task.completed ? this._completedStyle : this._baseStyle);
        this._updateTextStyle();
    }

    _updateTextStyle() {
        const escaped = GLib.markup_escape_text(this._task.text, -1);
        if (this._task.completed) {
            this._textLabel.clutter_text.set_markup(
                `<span strikethrough="true" foreground="${MODULE.textMuted}">${escaped}</span>`);
            this._textLabel.opacity = 150;
            this._textLabel.translation_x = this._px(3);
        } else {
            this._textLabel.clutter_text.set_markup(escaped);
            this._textLabel.opacity = 255;
            this._textLabel.translation_x = 0;
        }
    }

    /* ---- édition en place ---- */

    _startEdit() {
        if (this._entry)
            return;
        const px = this._px;
        this._entry = new St.Entry({
            text: this._task.text,
            x_expand: true,
            can_focus: true,
            style_class: 'sp-entry',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(14)}px; padding: ${px(4)}px ${px(8)}px;`,
        });
        this._entry.clutter_text.set_single_line_mode(true);
        this._entry.clutter_text.set_activatable(true);
        this._entry.clutter_text.connect('activate', () => this._commitEdit(true));
        this._entry.clutter_text.connect('key-focus-out', () => this._commitEdit(true));
        this._entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._commitEdit(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._textLabel.hide();
        this.insert_child_at_index(this._entry, 1);
        this._callbacks.onEditStart?.(this._entry);
        this._entry.clutter_text.set_selection(0, -1);
    }

    _commitEdit(save) {
        const entry = this._entry;
        if (!entry)
            return;
        this._entry = null;
        const text = entry.get_text().trim();
        entry.destroy();
        this._textLabel.show();
        if (save && text && text !== this._task.text) {
            this._task.text = text;
            this._callbacks.onEdit?.(this._task);
        }
        this._updateTextStyle();
    }

    setCompleted(completed) {
        this._task.completed = completed;
        this._checkbox.setChecked(completed);
        this.set_style(completed ? this._completedStyle : this._baseStyle);
        this._updateTextStyle();
    }

    /* Disparition : la lueur verte passe par une bordure vive plutôt que
     * par un box-shadow, que St peindrait en rectangle (coins noirs). */
    disappear(onDone) {
        const px = this._px;
        this.set_style(`background-color: rgba(245, 79, 27, 0.22); `
            + `border: 2px solid ${POSITIVE}; `
            + `border-radius: ${px(MODULE.radius)}px; `
            + `padding: ${px(12)}px ${px(14)}px; spacing: ${px(12)}px;`);

        this.remove_all_transitions();
        this.ease({
            scale_x: 0.85, scale_y: 0.85,
            translation_y: px(10),
            opacity: 0,
            duration: 700,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.get_parent()?.remove_child(this);
                this.destroy();
                onDone?.();
            },
        });
    }
});

/* -------------------------------------------------------------- module */

class TodoCard {
    constructor(ctx) {
        this._settings = ctx.settings;
        this._panel = ctx.panel;
        /* largeur distribuée par le panneau : lui seul connaît la place
         * réellement disponible (marges + gouttière de défilement) */
        this._moduleWidth = ctx.moduleWidth;
        this._rows = new Map();
        this._emptyLabel = null;
        this._destroyed = false;
        this._file = configFile('todos.json');

        this._tasks = this._loadTasks();
        this._build();
        this._renderInitial();
    }

    /* ------------------------------------------------------------- UI */

    _build() {
        const s = scaleFactor();
        const logicalWidth = this._moduleWidth ?? DESIGN_WIDTH;
        const k = logicalWidth / DESIGN_WIDTH;
        const px = v => Math.max(1, Math.round(v * k));
        const jsx = v => Math.max(1, Math.round(v * k * s));
        this._px = px;
        this._jsx = jsx;

        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            style: `background-color: ${MODULE.surface}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(24)}px; `
                + `spacing: ${px(18)}px; `
                + `color: #ffffff;`,
        });

        /* ---- en-tête ---- */
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Label({
            text: 'Tâches Pro',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(17)}px; font-weight: bold; `
                + `letter-spacing: -0.3px; color: ${MODULE.text};`,
        }));
        this._counterLabel = new St.Label({
            text: '0 / 0',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(12)}px; color: ${MODULE.textMuted}; `
                + `background-color: ${MODULE.inset}; `
                + `border: 1px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; `
                + `padding: ${px(4)}px ${px(10)}px;`,
        });
        header.add_child(this._counterLabel);

        /* vider les tâches terminées */
        this._clearBtn = new St.Button({
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(3)}px; margin-left: ${px(6)}px;`,
        });
        this._clearBtn.set_child(vectorIcon('ui-clear', MODULE.textDim, px(14)));
        this._clearBtn.set_accessible_name('Supprimer les tâches terminées');
        this._clearBtn.connect('clicked', () => this._clearCompleted());
        header.add_child(this._clearBtn);
        this.actor.add_child(header);

        /* ---- barre d'ajout ---- */
        const inputRow = new St.BoxLayout({
            x_expand: true, style: `spacing: ${px(8)}px;`,
        });

        this._entry = new St.Entry({
            hint_text: 'Ajouter une tâche…',
            x_expand: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry.clutter_text.line_wrap = false;
        this._entry.clutter_text.set_activatable(true);
        this._entry.clutter_text.connect('activate', () => this._addTask());
        this._entry.clutter_text.connect('key-focus-in', () => this._updateEntryStyle());
        this._entry.clutter_text.connect('key-focus-out', () => this._updateEntryStyle());
        /* Sans grab modal, GNOME envoie les touches à la fenêtre active et
         * le champ reste inerte : c'est le panneau qui prend le grab. */
        this._entry.connect('button-press-event', () => {
            this._panel?.enterEditMode?.(this._entry.clutter_text);
            return Clutter.EVENT_PROPAGATE;
        });
        inputRow.add_child(this._entry);

        /* y_align CENTER : sans lui, la rangée étire le bouton sur toute
         * la hauteur du champ de saisie (plus haut que 44 px à cause de son
         * padding) et il cesse d'être carré. */
        this._addBtn = new St.Button({
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._addBtn.set_pivot_point(0.5, 0.5);
        this._addBtn.set_size(jsx(44), jsx(44));
        this._addIcon = new St.Label({
            text: '＋',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(22)}px; color: ${ACCENT_INK};`,
        });
        /* pivot au centre : par défaut Clutter pivote autour du coin
         * haut-gauche, ce qui envoie le « + » hors du bouton. */
        this._addIcon.set_pivot_point(0.5, 0.5);
        this._addBtn.set_child(this._addIcon);
        this._addBtn.connect('clicked', () => this._addTask());
        this._addBtn.connect('notify::hover', () => this._onAddHover(this._addBtn.hover));
        /* St.Button n'émet ni « pressed » ni « released » : ce sont les
         * événements bruts qu'il faut écouter. */
        this._addBtn.connect('button-press-event', () => {
            this._addBtn.remove_all_transitions();
            this._addBtn.ease({
                scale_x: 0.95, scale_y: 0.95,
                duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        });
        this._addBtn.connect('button-release-event', () => {
            this._onAddHover(this._addBtn.hover);
            return Clutter.EVENT_PROPAGATE;
        });
        inputRow.add_child(this._addBtn);
        this.actor.add_child(inputRow);

        this._updateEntryStyle();
        this._onAddHover(false);

        /* ---- liste des tâches ----
         * Le CSS de référence dit `max-height: 300px`, PAS `height` : une
         * hauteur fixe laisserait un grand vide sous une liste courte. La
         * hauteur suit donc le contenu et n'est plafonnée qu'au-delà —
         * c'est _updateListHeight() qui l'ajuste. */
        this._scroll = new St.ScrollView({
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._list = new St.BoxLayout({
            vertical: true, x_expand: true, style: `spacing: ${px(10)}px;`,
        });
        this._scroll.set_child(this._list);
        this.actor.add_child(this._scroll);
    }

    /** Hauteur de la liste = contenu réel, plafonné à 300 px logiques.
     *
     * Le panneau épouse la hauteur de son contenu : quand une tâche est
     * ajoutée ou supprimée, il doit être prévenu, sinon la carte grandit
     * mais le panneau garde son ancienne taille et la coupe. */
    _updateListHeight() {
        if (this._destroyed || !this._scroll)
            return;
        /* Hors scène (construction, ouverture d'une tuile en mode applis),
         * St n'a pas encore de thème pour ces acteurs : mesurer déclenche
         * « st_widget_get_theme_node called on the widget … not in the
         * stage » puis des CRITICAL GObject. onOpen() remesure une fois
         * la carte posée. */
        if (!this._list.get_stage())
            return;
        const [, natural] = this._list.get_preferred_height(-1);
        const cap = this._jsx(300);
        this._scroll.height = Math.min(natural, cap);
        this._panel?.requestRelayout?.();
    }

    _updateEntryStyle() {
        const px = this._px;
        const common = `border-radius: ${px(MODULE.radius)}px; `
            + `padding: ${px(12)}px ${px(14)}px; `
            + `color: ${MODULE.text}; font-size: ${px(14)}px; `
            + `caret-color: ${ACCENT};`;
        const focused = this._entry.clutter_text.has_key_focus();
        this._entry.set_style(focused
            ? `background-color: ${MODULE.insetHover}; `
              + `border: 2px solid ${ACCENT}; ${common}`
            : `background-color: ${MODULE.inset}; `
              + `border: 2px solid ${MODULE.strokeSoft}; ${common}`);
    }

    /* Le dégradé de la maquette est à 135° ; St ne connaît que vertical,
     * horizontal et radial — vertical est le plus proche visuellement. */
    _onAddHover(hover) {
        const px = this._px;
        this._addBtn.set_style(`
            background-color: ${hover ? ACCENT_LIGHT : ACCENT};
            border: 2px solid ${MODULE.stroke};
            border-radius: ${px(MODULE.radius)}px;`);
        /* `transform: rotate(90deg) scale(1.08)` de la maquette porte sur
         * le BOUTON entier : c'est bien le carré bleu qui pivote, pas
         * seulement le glyphe. */
        this._addBtn.remove_all_transitions();
        this._addBtn.ease({
            rotation_angle_z: hover ? 90 : 0,
            scale_x: hover ? 1.08 : 1,
            scale_y: hover ? 1.08 : 1,
            duration: 300, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    /* ----------------------------------------------------- persistance */

    _loadTasks() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._file);
            if (ok) {
                const data = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(data)) {
                    return data.map(t => ({
                        id: Number(t.id) || Date.now(),
                        text: String(t.text ?? ''),
                        completed: Boolean(t.completed),
                        time: Number(t.time) || 0,
                    }));
                }
            }
        } catch (_e) {
            /* fichier absent au premier lancement */
        }
        return [
            {id: 1, text: 'Préparer le design system', completed: false, time: 1},
            {id: 2, text: 'Valider les animations fluides', completed: true, time: 2},
            {id: 3, text: 'Optimiser les effets lumineux', completed: true, time: 3},
        ];
    }

    _saveTasks() {
        try {
            configDir();
            GLib.file_set_contents(this._file, JSON.stringify(this._tasks, null, 2));
        } catch (e) {
            console.warn(`[yuzu] todo : enregistrement impossible — ${e}`);
        }
    }

    /* ------------------------------------------------------------ tri */

    /* Les tâches actives d'abord, puis les terminées de la plus récente à
     * la plus ancienne. */
    _sortedTasks() {
        const active = this._tasks.filter(t => !t.completed);
        const completed = this._tasks.filter(t => t.completed)
            .sort((a, b) => b.time - a.time);
        return [...active, ...completed];
    }

    _sortRows() {
        if (this._tasks.length === 0) {
            this._showEmpty();
            return;
        }
        this._removeEmptyLabel();
        this._sortedTasks().forEach((task, index) => {
            const row = this._rows.get(task.id);
            if (row && row.get_parent() === this._list)
                this._list.set_child_at_index(row, index);
        });
    }

    _updateCounter() {
        const done = this._tasks.filter(t => t.completed).length;
        this._counterLabel.text = `${done} / ${this._tasks.length}`;
    }

    /* -------------------------------------------------------- rendu */

    _makeRow(task) {
        const row = new TodoRow(task, this._px, this._jsx, {
            onToggle: (t, checked, r) => this._onToggle(t, checked, r),
            onDelete: (t, r) => this._onDelete(t, r),
            onEdit: () => this._saveTasks(),
            onEditStart: entry => this._panel?.enterEditMode?.(entry.clutter_text),
        });
        this._rows.set(task.id, row);
        return row;
    }

    _insertRowAnimated(row, index) {
        this._list.insert_child_at_index(row, index);
        row.translation_y = -this._jsx(15);
        row.opacity = 0;
        row.set_scale(0.95, 0.95);
        row.ease({
            translation_y: 0, opacity: 255, scale_x: 1, scale_y: 1,
            duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _renderInitial() {
        this._updateCounter();
        if (this._tasks.length === 0) {
            this._showEmpty();
            return;
        }
        for (const task of this._sortedTasks())
            this._list.add_child(this._makeRow(task));
        this._updateListHeight();
    }

    _showEmpty() {
        this._clearRows();
        this._emptyLabel = new St.Label({
            text: 'Aucune tâche en cours',
            x_align: Clutter.ActorAlign.CENTER,
            style: `color: ${MODULE.textMuted}; font-size: ${this._px(13)}px; `
                + `padding: ${this._px(24)}px 0;`,
        });
        this._list.add_child(this._emptyLabel);
        this._updateListHeight();
    }

    _removeEmptyLabel() {
        if (this._emptyLabel?.get_parent() === this._list)
            this._emptyLabel.destroy();
        this._emptyLabel = null;
    }

    _clearRows() {
        this._rows.clear();
        this._list.destroy_all_children();
        this._emptyLabel = null;
    }

    /* --------------------------------------------------- actions */

    _addTask() {
        const text = this._entry.get_text().trim();
        if (!text)
            return;
        const task = {id: Date.now(), text, completed: false, time: 0};
        this._tasks.unshift(task);
        this._saveTasks();

        this._removeEmptyLabel();
        this._insertRowAnimated(this._makeRow(task), 0);

        this._entry.set_text('');
        this._updateCounter();
        this._updateListHeight();
    }

    _onToggle(task, checked, row) {
        task.completed = checked;
        if (checked) {
            task.time = Date.now();
        } else {
            task.time = 0;
            const idx = this._tasks.indexOf(task);
            if (idx !== -1) {
                this._tasks.splice(idx, 1);
                this._tasks.unshift(task);
            }
        }
        row.setCompleted(checked);

        this._saveTasks();
        this._updateCounter();
        this._sortRows();
        this._purgeOldestCompleted();
    }

    /* Au-delà de MAX_COMPLETED tâches terminées, la plus ancienne
     * disparaît avec son animation de lueur verte. */
    _purgeOldestCompleted() {
        const completed = this._tasks.filter(t => t.completed)
            .sort((a, b) => b.time - a.time);
        if (completed.length <= MAX_COMPLETED)
            return;

        const oldest = completed[completed.length - 1];
        const row = this._rows.get(oldest.id);
        if (!row)
            return;

        row.disappear(() => {
            this._tasks = this._tasks.filter(t => t.id !== oldest.id);
            this._rows.delete(oldest.id);
            this._saveTasks();
            this._updateCounter();
            if (this._tasks.length === 0)
                this._showEmpty();
            this._updateListHeight();
        });
    }

    _clearCompleted() {
        const done = this._tasks.filter(t => t.completed);
        if (done.length === 0)
            return;
        done.forEach((task, index) => {
            const row = this._rows.get(task.id);
            if (!row)
                return;
            row.remove_all_transitions();
            row.ease({
                opacity: 0, translation_x: this._jsx(24),
                delay: index * 40, duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    row.destroy();
                    this._rows.delete(task.id);
                    this._updateListHeight();
                },
            });
        });
        this._tasks = this._tasks.filter(t => !t.completed);
        this._saveTasks();
        this._updateCounter();
        if (this._tasks.length === 0) {
            /* les lignes terminées s'effacent d'elles-mêmes ; l'état vide
             * arrive juste après */
            sourceRemove(this._emptyTimer);
            this._emptyTimer = timeoutAdd(300, () => {
                this._emptyTimer = 0;
                if (!this._destroyed && this._tasks.length === 0)
                    this._showEmpty();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onDelete(task, row) {
        row.disappear(() => {
            this._tasks = this._tasks.filter(t => t.id !== task.id);
            this._rows.delete(task.id);
            this._saveTasks();
            this._updateCounter();
            if (this._tasks.length === 0)
                this._showEmpty();
            this._updateListHeight();
        });
    }

    /* ------------------------------------------------------------ hooks */

    setTheme(_theme) {}   // maquette figée, indépendante du thème du panneau

    onOpen() {
        /* Au premier build la liste n'est pas encore allouée : sa hauteur
         * naturelle vaut 0. On la recalcule à l'ouverture, quand elle est
         * réellement mesurable. */
        this._updateListHeight();
    }

    onClose() {
        this._panel?.leaveEditMode?.();
    }

    destroy() {
        this._destroyed = true;
        this._emptyTimer = sourceRemove(this._emptyTimer);
        this._saveTasks();
    }
}

export default {
    id: 'todo',
    title: 'Tâches Pro',
    short: 'Tâches',
    icon: 'ui-todo',
    build(ctx) {
        return new TodoCard(ctx);
    },
};
