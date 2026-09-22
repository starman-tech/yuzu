// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/utils.js — helpers partagés */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export function timeoutAdd(ms, fn) {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, fn);
}

export function sourceRemove(id) {
    if (id) {
        try {
            GLib.Source.remove(id);
        } catch (_e) {}
    }
    return 0;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function ensureDir(path) {
    GLib.mkdir_with_parents(path, 0o700);
    return path;
}

const CONFIG = `${GLib.get_user_config_dir()}/yuzu`;

// #if full
/* Anciennes versions : ~/.config/mon-extension (≤ 4), ~/.config/sidepanel
 * (5.x, avant le nom Yuzu). Au premier appel, leur contenu est déplacé ici,
 * entrée par entrée : les préférences (processus séparé) peuvent avoir créé
 * le nouveau dossier avant que le shell ne passe par là. */
const LEGACY_CONFIGS = ['mon-extension', 'sidepanel']
    .map(name => `${GLib.get_user_config_dir()}/${name}`);
let migrated = false;

function migrateLegacyConfig(legacyPath) {
    if (!GLib.file_test(legacyPath, GLib.FileTest.IS_DIR))
        return;
    const legacy = Gio.File.new_for_path(legacyPath);
    try {
        if (!GLib.file_test(CONFIG, GLib.FileTest.EXISTS)) {
            legacy.move(Gio.File.new_for_path(CONFIG), Gio.FileCopyFlags.NONE, null, null);
        } else {
            const iter = legacy.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = iter.next_file(null)) !== null) {
                const name = info.get_name();
                const dest = Gio.File.new_for_path(`${CONFIG}/${name}`);
                if (!dest.query_exists(null))
                    legacy.get_child(name).move(dest, Gio.FileCopyFlags.NONE, null, null);
            }
            iter.close(null);
            try {
                legacy.delete(null); // échoue sans bruit s'il reste des doublons
            } catch (_e) {}
        }
        console.log(`[yuzu] données migrées : ${legacyPath} → ${CONFIG}`);
    } catch (e) {
        console.warn(`[yuzu] migration de ${legacyPath} : ${e}`);
    }
}

// #endif

/** Dossier de données de l'extension (~/.config/yuzu/…), créé au besoin. */
export function configDir(...parts) {
    // #if full
    if (!migrated) {
        migrated = true;
        LEGACY_CONFIGS.forEach(migrateLegacyConfig);
    }
    // #endif
    return ensureDir([CONFIG, ...parts].join('/'));
}

/** Fichier dans le dossier de données, sans créer le fichier lui-même. */
export function configFile(name) {
    return `${configDir()}/${name}`;
}

export function cacheDir(...parts) {
    return ensureDir([`${GLib.get_user_cache_dir()}/yuzu`, ...parts].join('/'));
}

export function hashString(str) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, str || '', -1);
}


export function newSession() {
    return new Soup.Session({timeout: 15, user_agent: 'yuzu/6'});
}

export async function fetchBytes(session, url, cancellable = null, headers = null) {
    const msg = Soup.Message.new('GET', url);
    if (!msg)
        throw new Error(`URL invalide : ${url}`);
    if (headers) {
        const reqHeaders = msg.get_request_headers();
        for (const [name, value] of Object.entries(headers))
            reqHeaders.append(name, value);
    }
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    if (msg.get_status() !== Soup.Status.OK)
        throw new Error(`HTTP ${msg.get_status()}`);
    return bytes;
}

/** Réponse HTTP décodée en texte (JSON, CSV, XML/RSS…). */
export async function fetchText(session, url, cancellable = null, headers = null) {
    const bytes = await fetchBytes(session, url, cancellable, headers);
    return new TextDecoder().decode(bytes.get_data());
}

export function rgbToHex(r, g, b) {
    const c = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

/** Couleur moyenne d'une image, éclaircie vers le blanc pour rester pastel.
 * GdkPixbuf est chargé pré-réduit à 24×24 : la moyenne se calcule donc sur
 * une poignée de pixels, pas sur l'image complète. */
export function extractPastelAccent(path, fallback = '#cde4f8') {
    try {
        const pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 24, 24, false);
        const w = pix.get_width();
        const h = pix.get_height();
        const channels = pix.get_n_channels();
        const rowstride = pix.get_rowstride();
        const pixels = pix.get_pixels();

        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const off = y * rowstride + x * channels;
                r += pixels[off];
                g += pixels[off + 1];
                b += pixels[off + 2];
                n++;
            }
        }
        if (n === 0)
            return fallback;
        r /= n;
        g /= n;
        b /= n;

        const mix = 0.68; // 0 = couleur brute, 1 = blanc pur — plus haut = plus pastel
        r += (255 - r) * mix;
        g += (255 - g) * mix;
        b += (255 - b) * mix;
        return rgbToHex(r, g, b);
    } catch (_e) {
        return fallback;
    }
}

/** Facteur d'échelle HiDPI du thème.
 *
 * Indispensable dès qu'on fixe une taille en JavaScript : dans GNOME Shell,
 * les longueurs en px écrites en CSS sont automatiquement multipliées par ce
 * facteur, mais PAS celles fixées via les propriétés d'acteur
 * (actor.width = 480). Mélanger les deux donne un contenu deux fois trop
 * grand pour son conteneur sur un écran à l'échelle 2. */
export function scaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

/** Chemin arrondi Cairo réutilisable. */
export function roundedPath(cr, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    cr.newPath();
    cr.arc(x + rad, y + rad, rad, Math.PI, 1.5 * Math.PI);
    cr.arc(x + w - rad, y + rad, rad, 1.5 * Math.PI, 2 * Math.PI);
    cr.arc(x + w - rad, y + h - rad, rad, 0, 0.5 * Math.PI);
    cr.arc(x + rad, y + h - rad, rad, 0.5 * Math.PI, Math.PI);
    cr.closePath();
}

/** Défilement horizontal d'un label trop long. */
export class Marquee {
    constructor(label, {pause = 1800, pxPerSec = 32} = {}) {
        this._label = label;
        this._pause = pause;
        this._pxPerSec = pxPerSec;
        this._timer = 0;
        this._overflow = 0;
    }

    update(availWidth) {
        this.stop();
        if (!this._label || availWidth <= 0)
            return;
        const [, natural] = this._label.get_preferred_width(-1);
        this._overflow = Math.max(0, natural - availWidth);
        this._label.translation_x = 0;
        if (this._overflow > 3)
            this._schedule(true);
    }

    _schedule(forward) {
        this._timer = timeoutAdd(this._pause, () => {
            this._timer = 0;
            if (!this._label)
                return GLib.SOURCE_REMOVE;
            const target = forward ? -this._overflow : 0;
            const distance = Math.abs(target - this._label.translation_x);
            this._label.ease({
                translation_x: target,
                duration: Math.max(500, (distance / this._pxPerSec) * 1000),
                mode: Clutter.AnimationMode.LINEAR,
                onComplete: () => this._label && this._schedule(!forward),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        this._timer = sourceRemove(this._timer);
        this._label?.remove_all_transitions();
    }

    destroy() {
        this.stop();
        this._label = null;
    }
}
