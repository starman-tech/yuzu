// SPDX-License-Identifier: GPL-3.0-or-later
/* extension.js — point d'entrée */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {KeepAwake} from './lib/keepAwake.js';
import {YuzuPanel} from './lib/panel.js';
// #if full
import {SmartRewrite} from './lib/rewrite.js';
// #endif

export default class YuzuExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._keepAwake = new KeepAwake(this._settings);

        // #if full
        /* réécriture de la sélection : opt-in, raccourci global, texte envoyé
         * à un service distant */
        this._rewriteId = this._settings.connect('changed::rewrite-enabled', () => this._syncRewrite());
        this._syncRewrite();
        // #endif

        /* metadata.json déclare le mode `unlock-dialog` : fermer le capot
         * verrouille l'écran, et sans ce mode GNOME désactiverait
         * l'extension — donc relâcherait le verrou — juste à ce moment.
         * Le panneau, lui, n'a rien à faire sur l'écran de verrouillage. */
        this._sessionModeId = Main.sessionMode.connect('updated', () => this._syncPanel());
        this._syncPanel();

        if (!this._settings.get_boolean('setup-done'))
            this._offerSetup();
    }

    /* Premier lancement : proposer de choisir ses modules plutôt que
     * d'imposer les neuf. Une seule fois, qu'on clique ou non. */
    _offerSetup() {
        this._settings.set_boolean('setup-done', true);
        const openModules = () => {
            this._settings.set_string('prefs-page', 'modules');
            Promise.resolve(this.openPreferences())
                .catch(e => console.error(`[yuzu] ouverture des préférences : ${e}`));
        };
        try {
            const source = new MessageTray.Source({
                title: 'Yuzu',
                iconName: 'sidebar-show-right-symbolic',
            });
            Main.messageTray.add(source);
            const notification = new MessageTray.Notification({
                source,
                title: 'Yuzu est installé',
                body: 'Survole le bord droit de l\'écran ou appuie sur Super+P. '
                    + 'Choisis ensuite les modules à afficher.',
            });
            notification.addAction('Choisir les modules', openModules);
            source.addNotification(notification);
        } catch (e) {
            console.warn(`[yuzu] notification de bienvenue : ${e}`);
        }
    }

    // #if full
    _syncRewrite() {
        if (this._settings.get_boolean('rewrite-enabled') && !Main.sessionMode.isLocked) {
            this._rewrite ??= new SmartRewrite(this._settings);
        } else {
            this._rewrite?.destroy();
            this._rewrite = null;
        }
    }
    // #endif

    _syncPanel() {
        if (Main.sessionMode.isLocked) {
            this._panel?.destroy();
            this._panel = null;
        } else {
            this._panel ??= new YuzuPanel(this);
        }
        // #if full
        this._syncRewrite();
        // #endif
    }

    /* Mode `unlock-dialog` : l'extension reste active écran verrouillé
     * uniquement pour KeepAwake. Fermer le capot verrouille la session ; si
     * GNOME désactivait l'extension à cet instant, l'inhibition de mise en
     * veille serait relâchée et l'ordinateur s'endormirait. Dès le
     * verrouillage, le panneau et son raccourci clavier sont détruits
     * (_syncPanel) ; disable() libère le reste. */
    disable() {
        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }
        // #if full
        if (this._rewriteId) {
            this._settings.disconnect(this._rewriteId);
            this._rewriteId = 0;
        }
        this._rewrite?.destroy();
        this._rewrite = null;
        // #endif
        this._panel?.destroy();
        this._panel = null;
        this._keepAwake?.destroy();
        this._keepAwake = null;
        this._settings = null;
    }
}
