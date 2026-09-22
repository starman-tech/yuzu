// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/launcher.js — lanceur d'applications favorites.
 *
 * Lit `org.gnome.shell favorite-apps` (les favoris du dock GNOME) et les
 * affiche en grille de 4 colonnes ; un clic lance l'application (ou la met
 * au premier plan si elle tourne déjà) et referme le panneau. Suit les
 * changements de favoris en direct.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {MODULE} from '../lib/theme.js';
import {scaleFactor} from '../lib/utils.js';

const DESIGN_WIDTH = 380;
const COLUMNS = 4;

class LauncherCard {
    constructor(ctx) {
        this._panel = ctx.panel;
        this._moduleWidth = ctx.moduleWidth;
        this._destroyed = false;
        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._build();
        this._render();
        this._favId = this._shellSettings.connect('changed::favorite-apps', () => this._render());
        this._appsId = Shell.AppSystem.get_default().connect('installed-changed', () => this._render());
    }

    _build() {
        const s = scaleFactor();
        const k = this._moduleWidth / DESIGN_WIDTH;
        const px = v => Math.max(1, Math.round(v * k));
        const jsx = v => Math.max(1, Math.round(v * k * s));
        this._px = px;
        this._jsx = jsx;

        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: `background-color: ${MODULE.surface}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(20)}px; spacing: ${px(12)}px; color: ${MODULE.text};`,
        });

        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Label({
            text: 'FAVORIS',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(13)}px; font-weight: bold; letter-spacing: 1px; `
                + `color: ${MODULE.textDim};`,
        }));
        this._countLabel = new St.Label({
            text: '0',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(11)}px; font-weight: bold; color: ${MODULE.textMuted}; `
                + `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(2)}px ${px(8)}px;`,
        });
        header.add_child(this._countLabel);
        this.actor.add_child(header);

        this._grid = new St.BoxLayout({vertical: true, x_expand: true, style: `spacing: ${px(8)}px;`});
        this.actor.add_child(this._grid);

        this._emptyLabel = new St.Label({
            text: 'Aucun favori : épingle des applications dans le dock GNOME.',
            style: `font-size: ${px(12)}px; color: ${MODULE.textMuted};`,
        });
        this._emptyLabel.clutter_text.line_wrap = true;
        this._emptyLabel.hide();
        this.actor.add_child(this._emptyLabel);
    }

    setTheme(_theme) {}

    _render() {
        if (this._destroyed)
            return;
        const px = this._px;
        const jsx = this._jsx;
        this._grid.destroy_all_children();

        const appSystem = Shell.AppSystem.get_default();
        const apps = this._shellSettings.get_strv('favorite-apps')
            .map(id => appSystem.lookup_app(id))
            .filter(Boolean);
        this._countLabel.text = String(apps.length);
        this._emptyLabel.visible = apps.length === 0;

        let row = null;
        apps.forEach((app, index) => {
            if (index % COLUMNS === 0) {
                row = new St.BoxLayout({x_expand: true, style: `spacing: ${px(8)}px;`});
                this._grid.add_child(row);
            }
            row.add_child(this._tile(app, px, jsx));
        });
        /* complète la dernière ligne pour garder des tuiles de même largeur */
        if (row) {
            for (let i = apps.length % COLUMNS; i > 0 && i < COLUMNS; i++)
                row.add_child(new St.Widget({x_expand: true}));
        }
    }

    _tile(app, px, jsx) {
        const btn = new St.Button({
            x_expand: true,
            can_focus: true,
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(8)}px ${px(2)}px;`,
        });
        btn.set_accessible_name(app.get_name());
        const box = new St.BoxLayout({vertical: true, x_expand: true, style: `spacing: ${px(4)}px;`});
        const icon = new St.Icon({
            gicon: app.get_icon(),
            icon_size: px(28),
            x_align: Clutter.ActorAlign.CENTER,
        });
        icon.set_pivot_point(0.5, 0.5);
        const name = new St.Label({
            text: app.get_name(),
            x_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(9)}px; font-weight: bold; color: ${MODULE.textDim};`,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        name.clutter_text.line_wrap = false;
        box.add_child(icon);
        box.add_child(name);
        btn.set_child(box);

        btn.connect('notify::hover', () => {
            btn.set_style(`background-color: ${btn.hover ? MODULE.insetHover : MODULE.inset}; `
                + `border: 2px solid ${btn.hover ? MODULE.stroke : MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(8)}px ${px(2)}px;`);
            icon.remove_all_transitions();
            icon.ease({
                scale_x: btn.hover ? 1.12 : 1, scale_y: btn.hover ? 1.12 : 1,
                duration: 160, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        });
        btn.connect('clicked', () => {
            try {
                app.activate();
            } catch (e) {
                console.error(`[sidepanel] lancement de ${app.get_id()} : ${e}`);
            }
            this._panel?.close?.(true);
        });
        return btn;
    }

    destroy() {
        this._destroyed = true;
        if (this._favId) {
            this._shellSettings.disconnect(this._favId);
            this._favId = 0;
        }
        if (this._appsId) {
            Shell.AppSystem.get_default().disconnect(this._appsId);
            this._appsId = 0;
        }
    }
}

export default {
    id: 'launcher',
    title: 'Favoris',
    short: 'Favoris',
    icon: 'ui-apps',
    build(ctx) {
        return new LauncherCard(ctx);
    },
};
