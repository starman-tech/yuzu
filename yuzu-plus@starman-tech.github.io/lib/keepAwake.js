// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/keepAwake.js — garder la session allumée, capot fermé.
 *
 * Deux verrous, pris ensemble tant que la clé `keep-awake` est vraie :
 *
 *   • logind `handle-lid-switch` en mode `block` : logind ne met plus en
 *     veille à la fermeture du capot. Les verrous « bas niveau » de ce
 *     type sont TOUJOURS respectés, quel que soit LidSwitchIgnoreInhibited.
 *     Le verrou vit tant que le descripteur de fichier reçu reste ouvert.
 *
 *   • gnome-session, drapeau SUSPEND (4) : gsd-power ne déclenche plus la
 *     veille par inactivité, et à la fermeture du capot il se contente de
 *     verrouiller l'écran (« Suspend is inhibited but lid is closed,
 *     locking the screen »).
 *
 * gnome-session traduit le second en verrou logind `sleep` ; logind ignore
 * cependant les verrous de l'utilisateur qui demande lui-même la veille, donc
 * la mise en veille manuelle (menu système) reste possible. Si gnome-shell
 * plante, les deux verrous tombent d'eux-mêmes — ils sont liés au processus.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const APP_ID = 'yuzu-plus@starman-tech.github.io';
const REASON = 'Yuzu : rester allumé capot fermé';
const GSM_INHIBIT_SUSPEND = 4;

function inhibitLid() {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call_with_unix_fd_list(
            'org.freedesktop.login1',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            'Inhibit',
            new GLib.Variant('(ssss)', ['handle-lid-switch', 'Yuzu', REASON, 'block']),
            new GLib.VariantType('(h)'),
            Gio.DBusCallFlags.NONE, -1, null, null,
            (connection, result) => {
                try {
                    const [reply, fdList] = connection.call_with_unix_fd_list_finish(result);
                    const [index] = reply.deepUnpack();
                    /* steal_fds : on devient propriétaire des descripteurs,
                     * sinon ils ne seraient fermés qu'au passage du GC et le
                     * verrou survivrait à la désactivation. */
                    const fds = fdList.steal_fds();
                    fds.forEach((fd, i) => i !== index && GLib.close(fd));
                    resolve(fds[index]);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function inhibitSession() {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager',
            'org.gnome.SessionManager',
            'Inhibit',
            new GLib.Variant('(susu)', [APP_ID, 0, REASON, GSM_INHIBIT_SUSPEND]),
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack()[0]);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function releaseLid(fd) {
    try {
        GLib.close(fd);
    } catch (e) {
        console.warn(`[yuzu] libération du verrou capot : ${e}`);
    }
}

function releaseSession(cookie) {
    Gio.DBus.session.call(
        'org.gnome.SessionManager',
        '/org/gnome/SessionManager',
        'org.gnome.SessionManager',
        'Uninhibit',
        new GLib.Variant('(u)', [cookie]),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (connection, result) => {
            try {
                connection.call_finish(result);
            } catch (e) {
                console.warn(`[yuzu] libération du verrou de veille : ${e}`);
            }
        });
}

export class KeepAwake {
    constructor(settings) {
        this._settings = settings;
        this._active = false;
        this._generation = 0;
        this._lidFd = -1;
        this._cookie = 0;

        this._settingsId = settings.connect('changed::keep-awake', () => this._sync());
        this._sync();
    }

    _sync() {
        if (this._settings.get_boolean('keep-awake'))
            this._acquire();
        else
            this._release();
    }

    async _acquire() {
        if (this._active)
            return;
        this._active = true;
        const generation = ++this._generation;

        const [lid, session] = await Promise.allSettled([inhibitLid(), inhibitSession()]);

        /* Désactivé pendant l'appel D-Bus : on rend aussitôt ce qu'on a eu. */
        const stale = generation !== this._generation;

        if (lid.status === 'fulfilled') {
            if (stale)
                releaseLid(lid.value);
            else
                this._lidFd = lid.value;
        } else {
            console.error(`[yuzu] verrou capot (logind) : ${lid.reason}`);
        }

        if (session.status === 'fulfilled') {
            if (stale)
                releaseSession(session.value);
            else
                this._cookie = session.value;
        } else {
            console.error(`[yuzu] verrou de veille (gnome-session) : ${session.reason}`);
        }
    }

    _release() {
        if (!this._active)
            return;
        this._active = false;
        this._generation++;

        if (this._lidFd >= 0) {
            releaseLid(this._lidFd);
            this._lidFd = -1;
        }
        if (this._cookie) {
            releaseSession(this._cookie);
            this._cookie = 0;
        }
    }

    destroy() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._release();
        this._settings = null;
    }
}
