// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/card.js — enveloppe d'un module dans le panneau.
 *
 * Le module fournit un acteur ; la carte lui donne son habillage
 * néo-brutal — contour épais + ombre dure décalée — et la barre d'édition
 * (réorganiser / ranger / retirer) qui n'apparaît qu'en mode édition.
 *
 * Structure :
 *   ModuleCard (BoxLayout vertical, marges droite/bas = décalage de l'ombre)
 *     ├─ _editBar
 *     └─ _body (BinLayout)
 *          ├─ _shadow  : bloc plein, translaté de (off, off) → ombre dure
 *          └─ _frame   : contour épais ; contient instance.actor
 *
 * L'ombre est un acteur et non un box-shadow CSS : un box-shadow sur un
 * acteur qui contient une image de fond (pochette du lecteur) est peint en
 * rectangle et déborde des coins. Un bloc translaté, lui, est prévisible.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {labelStyle} from './theme.js';
import {scaleFactor} from './utils.js';
import {makeVectorButton} from './widgets.js';

export const ModuleCard = GObject.registerClass({
    Signals: {
        'move-requested': {param_types: [GObject.TYPE_INT]},
        'stow-requested': {},
        'remove-requested': {},
        'drag-begin': {},
    },
}, class ModuleCard extends St.BoxLayout {
    _init(descriptor, instance, theme) {
        super._init({vertical: true, x_expand: true});

        this.moduleId = descriptor.id;
        this._descriptor = descriptor;
        this._instance = instance;
        this._theme = theme;

        /* --- barre d'édition (masquée par défaut) --- */
        this._editBar = new St.BoxLayout({style_class: 'sp-editbar', x_expand: true});
        this._editTitle = new St.Label({
            text: (descriptor.title ?? descriptor.id).toUpperCase(),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._editTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._dragHandle = makeVectorButton({
            icon: 'ui-grip', size: 28, iconSize: 15, motion: 'pop',
            tooltip: 'Maintenir et glisser pour réorganiser',
            onClick: () => {},
        });
        this._dragHandle.connect('button-press-event', () => {
            this.emit('drag-begin');
            return Clutter.EVENT_PROPAGATE;
        });
        this._editBar.add_child(this._dragHandle);
        this._editBar.add_child(this._editTitle);
        this._editBar.add_child(this._mkButton('ui-up', 'nudge-up', 'Monter',
            () => this.emit('move-requested', -1)));
        this._editBar.add_child(this._mkButton('ui-down', 'nudge-down', 'Descendre',
            () => this.emit('move-requested', 1)));
        this._editBar.add_child(this._mkButton('ui-stow', 'pop', 'Ranger dans la bibliothèque',
            () => this.emit('stow-requested')));
        if (!descriptor.builtin) {
            this._editBar.add_child(this._mkButton('ui-close', 'spin', 'Retirer',
                () => this.emit('remove-requested')));
        }
        this._editBar.hide();
        this.add_child(this._editBar);

        /* --- corps : ombre dure + cadre --- */
        this._body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._shadow = new St.Widget({
            x_expand: true, y_expand: true, reactive: false,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
        });
        this._frame = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
        });
        this._body.add_child(this._shadow);
        this._body.add_child(this._frame);
        if (instance?.actor)
            this._frame.add_child(instance.actor);
        this.add_child(this._body);

        this.setTheme(theme);
        this.connect('destroy', () => this._onDestroy());
    }

    _mkButton(iconName, motion, tooltip, callback) {
        const btn = makeVectorButton({
            icon: iconName, size: 28, iconSize: 15, motion,
            tooltip, onClick: callback,
        });
        this._editButtons ??= [];
        this._editButtons.push(btn);
        return btn;
    }

    setTheme(theme) {
        this._theme = theme;
        const t = theme;
        const s = scaleFactor();
        const off = (t.shadowOffset ?? 0);

        /* la marge réserve la place de l'ombre dans la colonne : sans elle,
         * l'ombre du dernier bloc serait coupée par la zone défilante */
        this.margin_right = off * s;
        this.margin_bottom = off * s;

        this._shadow.translation_x = off * s;
        this._shadow.translation_y = off * s;
        this._shadow.set_style(
            `background-color: ${t.cardShadow}; border-radius: ${t.cardRadius}px;`);
        this._frame.set_style(`
            background-color: ${t.cardTint};
            border: ${t.strokeWidth}px solid ${t.cardStroke};
            border-radius: ${t.cardRadius}px;`);

        this._editBar.set_style(`
            border-radius: ${t.cardRadius}px;
            background-color: ${t.cardTint};
            border: ${t.strokeWidth}px solid ${t.cardStroke};
            padding: 2px 4px;
            margin-bottom: 8px;
            spacing: 2px;`);
        this._editTitle.set_style(`${labelStyle(t, {size: 10, color: t.accent})} padding-left: 6px;`);
        this._instance?.setTheme?.(theme);
    }

    /* La barre glisse depuis le haut et ses boutons arrivent en cascade —
     * St n'anime aucun CSS, tout est joué par Clutter. */
    setEditMode(editing) {
        const buttons = [this._dragHandle, ...(this._editButtons ?? [])];
        this._editBar.remove_all_transitions();

        if (editing) {
            this._editBar.show();
            this._editBar.opacity = 0;
            this._editBar.translation_y = -6;
            this._editBar.ease({
                opacity: 255, translation_y: 0,
                duration: 220, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
            buttons.forEach((btn, index) => {
                btn.remove_all_transitions();
                btn.opacity = 0;
                btn.set_pivot_point(0.5, 0.5);
                btn.set_scale(0.6, 0.6);
                btn.ease({
                    opacity: 255, scale_x: 1, scale_y: 1,
                    delay: 30 + index * 30,
                    duration: 240, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            });
        } else {
            this._editBar.ease({
                opacity: 0, translation_y: -6,
                duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._editBar.hide(),
            });
        }
    }

    onPanelOpened() {
        this._instance?.onOpen?.();
    }

    onPanelClosed() {
        this._instance?.onClose?.();
    }

    _onDestroy() {
        try {
            this._instance?.destroy?.();
        } catch (e) {
            console.error(`[yuzu] destroy ${this.moduleId}: ${e}`);
        }
        this._instance = null;
    }
});
