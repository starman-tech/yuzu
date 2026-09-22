// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/sysmon.js — moniteur système, 100 % local.
 *
 * CPU (delta de /proc/stat), mémoire (/proc/meminfo), disque racine
 * (Gio.File.query_filesystem_info), charge et uptime. Aucune dépendance
 * externe, aucun sous-processus : tout se lit dans /proc et via Gio.
 *
 * Rafraîchi toutes les 2 s, uniquement panneau ouvert.
 *
 * Mise à l'échelle : k pour la proportion du design (maquette 380 px),
 * s pour le HiDPI (propriétés d'acteur seulement) — voir player.js.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {MODULE} from '../lib/theme.js';
import {clamp, scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';

const DESIGN_WIDTH = 380;
const REFRESH_MS = 2000;

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch (_e) {
        return '';
    }
}

function fmtBytes(bytes) {
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}j ${h}h`;
    if (h > 0)
        return `${h}h ${m.toString().padStart(2, '0')}`;
    return `${m} min`;
}

class SysmonCard {
    constructor(ctx) {
        this._moduleWidth = ctx.moduleWidth;
        this._timer = 0;
        this._prevCpu = null;
        this._destroyed = false;
        this._build();
        this._refresh();
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
                + `padding: ${px(20)}px; spacing: ${px(14)}px; `
                + `color: ${MODULE.text};`,
        });

        /* en-tête : titre + uptime */
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Label({
            text: 'SYSTÈME',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(13)}px; font-weight: bold; letter-spacing: 1px; `
                + `color: ${MODULE.textDim};`,
        }));
        this._uptimeLabel = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(11)}px; font-weight: bold; color: ${MODULE.textMuted}; `
                + `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(2)}px ${px(8)}px;`,
        });
        header.add_child(this._uptimeLabel);
        this.actor.add_child(header);

        /* trois jauges */
        this._rows = {
            cpu: this._makeRow('CPU'),
            mem: this._makeRow('MÉMOIRE'),
            disk: this._makeRow('DISQUE /'),
        };
        for (const row of Object.values(this._rows))
            this.actor.add_child(row.actor);

        /* pied : charge moyenne */
        this._loadLabel = new St.Label({
            text: 'charge —',
            style: `font-size: ${px(11)}px; color: ${MODULE.textMuted};`,
        });
        this.actor.add_child(this._loadLabel);
    }

    _makeRow(title) {
        const px = this._px;
        const jsx = this._jsx;
        const box = new St.BoxLayout({vertical: true, x_expand: true, style: `spacing: ${px(6)}px;`});
        const line = new St.BoxLayout({x_expand: true});
        const name = new St.Label({
            text: title,
            x_expand: true,
            style: `font-size: ${px(13)}px; font-weight: bold; color: ${MODULE.text};`,
        });
        const value = new St.Label({
            text: '—',
            style: `font-size: ${px(13)}px; font-weight: bold; color: ${MODULE.accent};`,
        });
        const detail = new St.Label({
            text: '',
            style: `font-size: ${px(11)}px; color: ${MODULE.textMuted}; padding-right: ${px(8)}px;`,
        });
        line.add_child(name);
        line.add_child(detail);
        line.add_child(value);

        /* jauge : BoxLayout horizontal, le remplissage part de la gauche */
        const track = new St.BoxLayout({
            x_expand: true,
            height: jsx(10),
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: 0px;`,
        });
        const fill = new St.Widget({
            width: 0, y_expand: true,
            style: `background-color: ${MODULE.accent};`,
        });
        track.add_child(fill);
        box.add_child(line);
        box.add_child(track);

        const row = {actor: box, value, detail, track, fill, ratio: 0};
        track.connect('notify::width', () => this._applyFill(row));
        return row;
    }

    _applyFill(row) {
        /* Hors scène (premier _refresh() du constructeur, carte détachée
         * pendant une reconstruction), lire `width` force St à calculer la
         * taille sans thème : St-CRITICAL en rafale. get_stage() d'abord ;
         * notify::width rappellera une fois la carte allouée. */
        if (this._destroyed || !row.track.get_stage() || row.track.width <= 0)
            return;
        const inner = Math.max(0, row.track.width - 4 * scaleFactor());
        const target = Math.round(inner * clamp(row.ratio, 0, 1));
        row.fill.remove_all_transitions();
        row.fill.ease({width: target, duration: 500, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
        /* la jauge vire au beige quand elle sature : un signal, pas une alarme */
        row.fill.set_style(`background-color: ${row.ratio > 0.9 ? MODULE.text : MODULE.accent};`);
    }

    setTheme(_theme) {}

    /* ----------------------------------------------------------- mesure */

    _readCpu() {
        const line = readFile('/proc/stat').split('\n')[0] ?? '';
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4)
            return null;
        const idle = parts[3] + (parts[4] ?? 0);
        const total = parts.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return null;
        return 1 - (idle - prev.idle) / (total - prev.total);
    }

    _readMem() {
        const info = {};
        for (const line of readFile('/proc/meminfo').split('\n')) {
            const m = /^(\w+):\s+(\d+)/.exec(line);
            if (m)
                info[m[1]] = Number(m[2]) * 1024;
        }
        const total = info.MemTotal ?? 0;
        const avail = info.MemAvailable ?? 0;
        return {total, used: total - avail};
    }

    _readDisk() {
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info(
                'filesystem::size,filesystem::used', null);
            return {
                total: info.get_attribute_uint64('filesystem::size'),
                used: info.get_attribute_uint64('filesystem::used'),
            };
        } catch (_e) {
            return {total: 0, used: 0};
        }
    }

    _refresh() {
        if (this._destroyed)
            return;

        const cpu = this._readCpu();
        if (cpu !== null) {
            this._rows.cpu.ratio = cpu;
            this._rows.cpu.value.text = `${Math.round(cpu * 100)} %`;
            this._applyFill(this._rows.cpu);
        }
        const nproc = GLib.get_num_processors();
        this._rows.cpu.detail.text = `${nproc} cœurs`;

        const mem = this._readMem();
        if (mem.total > 0) {
            this._rows.mem.ratio = mem.used / mem.total;
            this._rows.mem.value.text = `${Math.round((mem.used / mem.total) * 100)} %`;
            this._rows.mem.detail.text = `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`;
            this._applyFill(this._rows.mem);
        }

        const disk = this._readDisk();
        if (disk.total > 0) {
            this._rows.disk.ratio = disk.used / disk.total;
            this._rows.disk.value.text = `${Math.round((disk.used / disk.total) * 100)} %`;
            this._rows.disk.detail.text = `${fmtBytes(disk.total - disk.used)} libres`;
            this._applyFill(this._rows.disk);
        }

        const up = parseFloat(readFile('/proc/uptime').split(' ')[0] ?? '0');
        this._uptimeLabel.text = `↑ ${fmtUptime(up)}`;

        const load = readFile('/proc/loadavg').split(' ').slice(0, 3).join('  ');
        this._loadLabel.text = `charge ${load || '—'}`;
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._refresh();
        if (this._timer)
            return;
        this._timer = timeoutAdd(REFRESH_MS, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._refresh();
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
    id: 'sysmon',
    title: 'Système',
    short: 'Système',
    icon: 'ui-cpu',
    build(ctx) {
        return new SysmonCard(ctx);
    },
};
