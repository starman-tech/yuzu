// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/registry.js — catalogue des modules.
 *
 * Deux sources :
 *   • intégrés    -> ./modules/*.js listés dans BUILTINS
 *   • importés    -> n'importe quel .js déposé dans
 *                    ~/.config/sidepanel/modules/ (chargé par import()
 *                    dynamique, donc sans réinstaller l'extension)
 *
 * Contrat d'un module (docs/MODULES.md, exemples dans le dépôt
 * starman-tech/sidepanel-modules) :
 *
 *   export default {
 *       id: 'mon-module',
 *       title: 'Mon module',
 *       icon: 'starred-symbolic',
 *       build(ctx) {
 *           // ctx = {St, Clutter, GLib, Gio, api, theme, settings, panel,
 *           //        moduleWidth, style, utils} — détail dans docs/MODULES.md
 *           return {
 *               actor,               // obligatoire : l'acteur affiché
 *               setTheme(theme) {},  // optionnel : le thème a changé
 *               onOpen() {},         // optionnel : panneau ouvert
 *               onClose() {},        // optionnel : panneau fermé
 *               destroy() {},        // optionnel : libérer timers/D-Bus
 *           };
 *       },
 *   };
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import assistantModule from '../modules/assistant.js';
import calendarModule from '../modules/calendar.js';
import launcherModule from '../modules/launcher.js';
import marketModule from '../modules/market.js';
import playerModule from '../modules/player.js';
import sysmonModule from '../modules/sysmon.js';
import todoModule from '../modules/todo.js';
import trackerModule from '../modules/tracker.js';
import weatherModule from '../modules/weather.js';
import {configDir} from './utils.js';

const BUILTINS = [
    playerModule, trackerModule, marketModule, todoModule,
    sysmonModule, weatherModule, calendarModule, launcherModule, assistantModule,
];

export function userModuleDir() {
    return configDir('modules');
}

export class ModuleRegistry {
    constructor() {
        this._descriptors = new Map();
        for (const mod of BUILTINS)
            this._descriptors.set(mod.id, {...mod, builtin: true, source: 'intégré'});
    }

    get(id) {
        return this._descriptors.get(id) ?? null;
    }

    all() {
        return [...this._descriptors.values()];
    }

    isLoaded(path) {
        return this.all().some(d => d.source === path);
    }

    /** Fichiers .js présents dans le dossier utilisateur, chargés ou non. */
    listFiles() {
        const dir = Gio.File.new_for_path(userModuleDir());
        const files = [];
        try {
            const iter = dir.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.endsWith('.js'))
                    files.push(`${userModuleDir()}/${name}`);
            }
        } catch (e) {
            console.warn(`[sidepanel] lecture du dossier modules : ${e}`);
        }
        return files.sort();
    }

    /** Charge un fichier .js et enregistre le module qu'il exporte. */
    async loadFile(path) {
        const uri = `file://${path}`;
        const mod = await import(uri);
        const desc = mod.default;
        if (!desc?.id || typeof desc.build !== 'function')
            throw new Error('le fichier doit exporter { id, build(ctx) } par défaut');
        if (this._descriptors.has(desc.id) && this._descriptors.get(desc.id).builtin)
            throw new Error(`l'identifiant « ${desc.id} » est déjà pris par un module intégré`);
        this._descriptors.set(desc.id, {...desc, builtin: false, source: path});
        return desc.id;
    }

    /** Charge tous les fichiers enregistrés dans les réglages. */
    async loadAll(paths) {
        const loaded = [];
        for (const path of paths) {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                continue;
            try {
                loaded.push(await this.loadFile(path));
            } catch (e) {
                console.error(`[sidepanel] import de ${path} : ${e}`);
            }
        }
        return loaded;
    }
}
