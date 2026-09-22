// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/calendar.js — horloge + calendrier mensuel.
 *
 * Heure et date en gros, grille du mois avec le jour courant en bloc
 * orange, navigation mois précédent / suivant, retour à aujourd'hui d'un
 * clic sur le titre. Aucune donnée réseau.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {MODULE} from '../lib/theme.js';
import {vectorIcon} from '../lib/vectorIcons.js';
import {scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';

const DESIGN_WIDTH = 380;
const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

class CalendarCard {
    constructor(ctx) {
        this._moduleWidth = ctx.moduleWidth;
        this._timer = 0;
        this._destroyed = false;
        const now = GLib.DateTime.new_now_local();
        this._year = now.get_year();
        this._month = now.get_month();
        this._build();
        this._tick();
        this._renderMonth();
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

        /* horloge */
        const clock = new St.BoxLayout({x_expand: true, style: `spacing: ${px(12)}px;`});
        this._timeLabel = new St.Label({
            text: '--:--',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(40)}px; font-weight: bold; letter-spacing: -1px; color: ${MODULE.text};`,
        });
        const dateBox = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._dayLabel = new St.Label({
            text: '',
            style: `font-size: ${px(13)}px; font-weight: bold; color: ${MODULE.accent}; letter-spacing: 1px;`,
        });
        this._dateLabel = new St.Label({
            text: '',
            style: `font-size: ${px(12)}px; color: ${MODULE.textDim};`,
        });
        dateBox.add_child(this._dayLabel);
        dateBox.add_child(this._dateLabel);
        clock.add_child(this._timeLabel);
        clock.add_child(dateBox);
        this.actor.add_child(clock);

        /* navigation du mois */
        const nav = new St.BoxLayout({x_expand: true, style: `spacing: ${px(6)}px;`});
        this._prevBtn = this._navButton('ui-up', 'Mois précédent', () => this._shiftMonth(-1));
        this._monthBtn = new St.Button({
            x_expand: true,
            can_focus: true,
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(4)}px; `
                + `font-size: ${px(12)}px; font-weight: bold; color: ${MODULE.text};`,
        });
        this._monthBtn.set_accessible_name('Revenir à aujourd\'hui');
        this._monthBtn.connect('clicked', () => this._goToday());
        this._nextBtn = this._navButton('ui-down', 'Mois suivant', () => this._shiftMonth(1));
        nav.add_child(this._prevBtn);
        nav.add_child(this._monthBtn);
        nav.add_child(this._nextBtn);
        this.actor.add_child(nav);

        /* grille : 7 colonnes, en-tête des jours puis 6 lignes max */
        this._grid = new St.BoxLayout({vertical: true, x_expand: true, style: `spacing: ${px(3)}px;`});
        const head = new St.BoxLayout({x_expand: true, style: `spacing: ${px(3)}px;`});
        for (const d of WEEKDAYS) {
            head.add_child(new St.Label({
                text: d,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(10)}px; font-weight: bold; color: ${MODULE.textMuted};`,
            }));
        }
        this._grid.add_child(head);
        this._rows = [];
        for (let r = 0; r < 6; r++) {
            const row = new St.BoxLayout({x_expand: true, style: `spacing: ${px(3)}px;`});
            const cells = [];
            for (let c = 0; c < 7; c++) {
                const cell = new St.Label({
                    text: '',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                    height: jsx(22),
                });
                /* ClutterText n'aligne le texte dans sa largeur que si la
                 * mise en page Pango a une largeur, ce que l'ellipse impose */
                cell.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                cell.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
                row.add_child(cell);
                cells.push(cell);
            }
            this._grid.add_child(row);
            this._rows.push({row, cells});
        }
        this.actor.add_child(this._grid);
    }

    _navButton(icon, tooltip, onClick) {
        const px = this._px;
        const jsx = this._jsx;
        const btn = new St.Button({
            can_focus: true,
            width: jsx(28),
            height: jsx(28),
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px;`,
        });
        const ic = vectorIcon(icon, MODULE.text, px(14));
        ic.set_pivot_point(0.5, 0.5);
        /* les flèches haut/bas du jeu maison servent de « précédent /
         * suivant » une fois tournées d'un quart de tour dans le sens
         * anti-horaire : haut → gauche, bas → droite */
        ic.rotation_angle_z = -90;
        btn.set_child(ic);
        btn.set_accessible_name(tooltip);
        btn.connect('clicked', onClick);
        return btn;
    }

    setTheme(_theme) {}

    /* ------------------------------------------------------------ rendu */

    _tick() {
        if (this._destroyed)
            return;
        const now = GLib.DateTime.new_now_local();
        this._timeLabel.text = now.format('%H:%M');
        this._dayLabel.text = now.format('%A').toUpperCase();
        this._dateLabel.text = now.format('%e %B %Y').trim();
        /* nouveau jour : la grille change */
        const key = now.format('%Y-%m-%d');
        if (key !== this._todayKey) {
            this._todayKey = key;
            this._renderMonth();
        }
    }

    _shiftMonth(delta) {
        let m = this._month + delta;
        let y = this._year;
        if (m < 1) {
            m = 12;
            y--;
        } else if (m > 12) {
            m = 1;
            y++;
        }
        this._month = m;
        this._year = y;
        this._renderMonth(delta);
    }

    _goToday() {
        const now = GLib.DateTime.new_now_local();
        this._year = now.get_year();
        this._month = now.get_month();
        this._renderMonth();
    }

    _renderMonth(direction = 0) {
        if (this._destroyed)
            return;
        const px = this._px;
        const first = GLib.DateTime.new_local(this._year, this._month, 1, 0, 0, 0);
        const today = GLib.DateTime.new_now_local();
        const isThisMonth = today.get_year() === this._year && today.get_month() === this._month;
        const daysInMonth = GLib.Date.get_days_in_month(this._month, this._year);
        const startCol = first.get_day_of_week() - 1;   // lundi = 0

        this._monthBtn.label = first.format('%B %Y').toUpperCase();

        let day = 1 - startCol;
        for (const {row, cells} of this._rows) {
            let anyVisible = false;
            for (const cell of cells) {
                if (day >= 1 && day <= daysInMonth) {
                    anyVisible = true;
                    const isToday = isThisMonth && day === today.get_day_of_month();
                    cell.text = String(day);
                    cell.set_style(isToday
                        ? `font-size: ${px(11)}px; font-weight: bold; color: ${MODULE.accentInk}; `
                          + `background-color: ${MODULE.accent}; border: 2px solid ${MODULE.stroke}; `
                          + `border-radius: ${px(3)}px;`
                        : `font-size: ${px(11)}px; color: ${MODULE.text}; `
                          + `background-color: ${MODULE.inset}; border-radius: ${px(3)}px;`);
                } else {
                    cell.text = '';
                    cell.set_style('background-color: transparent; border: none;');
                }
                day++;
            }
            row.visible = anyVisible;
        }

        if (direction !== 0) {
            const s = scaleFactor();
            this._grid.remove_all_transitions();
            this._grid.translation_x = direction * 12 * s;
            this._grid.opacity = 120;
            this._grid.ease({
                translation_x: 0, opacity: 255,
                duration: 220, mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        }
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._tick();
        if (this._timer)
            return;
        this._timer = timeoutAdd(1000, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    onClose() {
        this._timer = sourceRemove(this._timer);
    }

    destroy() {
        this._destroyed = true;
        this._timer = sourceRemove(this._timer);
    }
}

export default {
    id: 'calendar',
    title: 'Calendrier',
    short: 'Agenda',
    icon: 'ui-calendar',
    build(ctx) {
        return new CalendarCard(ctx);
    },
};
