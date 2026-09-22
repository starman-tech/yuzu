// SPDX-License-Identifier: GPL-3.0-or-later
/* prefs.js — préférences (processus séparé : ni St ni Clutter ici) */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';

import {
    applyInstall, applyUninstall, compareVersions, fetchCatalog, incompatibility,
    installEntry, modulesDir, newSession as newCatalogSession, readInstalled, uninstallEntry,
} from './lib/catalog.js';
import {SHAPES, SHAPE_LABELS, themeList} from './lib/theme.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');

function rgbaToHex(rgba) {
    const c = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

function spinRow(title, subtitle, settings, key, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class SidePanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._window = window;
        this._cleanups = [];
        window.set_default_size(680, 780);
        window.set_search_enabled(true);

        this._pages = {
            modules: this._modulesPage(settings),
            catalog: this._catalogPage(settings),
            settings: this._moduleSettingsPage(settings),
            panel: this._panelPage(settings),
            style: this._stylePage(settings),
            background: this._backgroundPage(settings),
        };
        for (const page of Object.values(this._pages))
            window.add(page);

        /* le panneau demande une page précise (bouton Catalogue du ＋),
         * y compris quand la fenêtre est déjà ouverte */
        const showRequested = () => {
            const wanted = this._pages[settings.get_string('prefs-page')];
            if (wanted) {
                window.set_visible_page(wanted);
                settings.set_string('prefs-page', '');
            }
        };
        showRequested();
        this._connect(settings, 'changed::prefs-page', showRequested);

        window.connect('close-request', () => {
            this._cleanups.forEach(fn => {
                try {
                    fn();
                } catch (_e) {}
            });
            this._cleanups = [];
            this._window = null;
            this._pages = null;
            return false;
        });
    }

    /* --------------------------------------------------------- style */

    _stylePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Style',
            icon_name: 'applications-graphics-symbolic',
        });

        const themes = themeList();
        const group = new Adw.PreferencesGroup({
            title: 'Bibliothèque de styles',
            description: 'Les thèmes sont définis dans lib/theme.js — copie un bloc, '
                + 'change les couleurs, il apparaît ici automatiquement.',
        });

        const row = new Adw.ComboRow({
            title: 'Thème',
            model: Gtk.StringList.new(themes.map(t => t.label)),
        });
        const current = themes.findIndex(t => t.id === settings.get_string('theme'));
        row.set_selected(current >= 0 ? current : 0);
        row.connect('notify::selected', () => {
            const picked = themes[row.get_selected()];
            if (picked)
                settings.set_string('theme', picked.id);
        });
        group.add(row);

        const blurRow = new Adw.SwitchRow({
            title: 'Flou de l\'arrière-plan (expérimental)',
            subtitle: 'Vrai flou GPU. Peut figer ou faire tomber GNOME Shell sur '
                + 'certains pilotes, NVIDIA sous X11 notamment. Désactivé par défaut.',
        });
        settings.bind('backdrop-blur', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(blurRow);

        const editRow = new Adw.ActionRow({
            title: 'Modifier les thèmes',
            subtitle: 'Ouvre lib/theme.js dans ton éditeur',
        });
        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        editButton.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri(`file://${this.path}/lib/theme.js`, null);
        });
        editRow.add_suffix(editButton);
        group.add(editRow);
        page.add(group);

        return page;
    }

    /* ----------------------------------------------------------- fond */

    _backgroundPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Fond animé',
            icon_name: 'view-paged-symbolic',
        });

        const motion = new Adw.PreferencesGroup({
            title: 'Mouvement',
            description: 'Le fond n\'est animé que lorsque le panneau est ouvert.',
        });

        const shapeRow = new Adw.ComboRow({
            title: 'Forme',
            model: Gtk.StringList.new(SHAPES.map(s => SHAPE_LABELS[s] ?? s)),
        });
        const currentShape = SHAPES.indexOf(settings.get_string('bg-shape'));
        shapeRow.set_selected(currentShape >= 0 ? currentShape : 0);
        shapeRow.connect('notify::selected',
            () => settings.set_string('bg-shape', SHAPES[shapeRow.get_selected()] ?? 'liquid'));
        motion.add(shapeRow);

        const speedRow = new Adw.SpinRow({
            title: 'Vitesse',
            subtitle: '0 = vitesse définie par le thème',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 4, step_increment: 0.05}),
        });
        settings.bind('bg-speed', speedRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        motion.add(speedRow);

        const intensityRow = new Adw.SpinRow({
            title: 'Intensité des couleurs',
            subtitle: 'Valeur négative = intensité du thème',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: -1, upper: 1.2, step_increment: 0.05}),
        });
        settings.bind('bg-intensity', intensityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        motion.add(intensityRow);
        page.add(motion);

        /* --- couleurs --- */
        const colorGroup = new Adw.PreferencesGroup({
            title: 'Couleurs',
            description: 'Quatre teintes. Décoche pour revenir aux couleurs du thème.',
        });

        const useCustom = new Adw.SwitchRow({title: 'Couleurs personnalisées'});
        useCustom.set_active(settings.get_strv('bg-colors').length > 0);
        colorGroup.add(useCustom);

        const defaults = ['#5c85fa', '#b87af5', '#4cd9d9', '#fa9a85'];
        const stored = settings.get_strv('bg-colors');
        const buttons = [];

        const push = () => {
            if (!useCustom.get_active()) {
                settings.set_strv('bg-colors', []);
                return;
            }
            settings.set_strv('bg-colors', buttons.map(b => rgbaToHex(b.get_rgba())));
        };

        for (let i = 0; i < 4; i++) {
            const row = new Adw.ActionRow({title: `Teinte ${i + 1}`});
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                valign: Gtk.Align.CENTER,
            });
            const rgba = new Gdk.RGBA();
            rgba.parse(stored[i] ?? defaults[i]);
            button.set_rgba(rgba);
            button.connect('notify::rgba', () => push());
            buttons.push(button);
            row.add_suffix(button);
            colorGroup.add(row);
        }

        useCustom.connect('notify::active', () => push());
        page.add(colorGroup);

        return page;
    }

    /* -------------------------------------------------------- panneau */

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Panneau',
            icon_name: 'preferences-system-symbolic',
        });

        const geometry = new Adw.PreferencesGroup({title: 'Dimensions'});
        geometry.add(spinRow('Largeur (px)', null, settings, 'panel-width', 280, 720, 10));
        geometry.add(spinRow('Marge au bord (px)',
            'Le panneau flotte : 0 le recolle au bord', settings, 'panel-margin', 0, 80, 2));
        geometry.add(spinRow('Hauteur maximale (px)', null,
            settings, 'panel-max-height', 320, 2000, 20));
        geometry.add(spinRow('Espacement entre les cartes (px)', null,
            settings, 'card-spacing', 0, 40, 2));
        page.add(geometry);

        const behaviour = new Adw.PreferencesGroup({title: 'Comportement'});

        const modes = [['stack', 'Cartes empilées'], ['grid', 'Grille d\'icônes (comme un téléphone)']];
        const viewRow = new Adw.ComboRow({
            title: 'Affichage des modules',
            subtitle: 'Le bouton grille de l\'en-tête bascule aussi',
            model: Gtk.StringList.new(modes.map(m => m[1])),
        });
        const currentMode = modes.findIndex(m => m[0] === settings.get_string('view-mode'));
        viewRow.set_selected(currentMode >= 0 ? currentMode : 0);
        viewRow.connect('notify::selected',
            () => settings.set_string('view-mode', modes[viewRow.get_selected()]?.[0] ?? 'stack'));
        behaviour.add(viewRow);

        behaviour.add(switchRow('Ouvrir au survol', 'Bord droit de l\'écran',
            settings, 'show-on-hover'));
        behaviour.add(spinRow('Zone de déclenchement (px)', null,
            settings, 'edge-width', 1, 40, 1));
        behaviour.add(spinRow('Délai de fermeture (ms)', null,
            settings, 'hide-delay', 0, 3000, 50));
        behaviour.add(spinRow('Durée de l\'animation (ms)', null,
            settings, 'animation-duration', 80, 1400, 20));
        behaviour.add(switchRow('Rebond à l\'ouverture', 'Courbe EASE_OUT_BACK',
            settings, 'bounce'));
        behaviour.add(switchRow('Rester allumé capot fermé',
            'Pas de mise en veille : VS Code, terminaux et téléchargements continuent',
            settings, 'keep-awake'));

        const accelRow = new Adw.EntryRow({title: 'Raccourci clavier'});
        accelRow.set_text(settings.get_strv('toggle-panel')[0] ?? '');
        accelRow.connect('changed', () => {
            const text = accelRow.get_text().trim();
            if (!text) {
                settings.set_strv('toggle-panel', []);
                accelRow.remove_css_class('error');
                return;
            }
            const [ok] = Gtk.accelerator_parse(text);
            if (ok) {
                accelRow.remove_css_class('error');
                settings.set_strv('toggle-panel', [text]);
            } else {
                accelRow.add_css_class('error');
            }
        });
        behaviour.add(accelRow);
        page.add(behaviour);

        return page;
    }

    /* -------------------------------------------------------- modules */

    _builtins() {
        try {
            const [, bytes] = GLib.file_get_contents(`${this.path}/builtins.json`);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            console.error(`[sidepanel] builtins.json : ${e}`);
            return {modules: [], features: []};
        }
    }

    _modulesPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Modules',
            icon_name: 'view-grid-symbolic',
        });
        const {modules, features} = this._builtins();

        /* --- intégrés : un interrupteur par module --- */
        const builtin = new Adw.PreferencesGroup({
            title: 'Modules intégrés',
            description: 'Active ceux que tu veux voir dans le panneau. L\'ordre se règle '
                + 'directement dans le panneau (icône crayon, puis glisser).',
        });
        const switches = new Map();
        let syncing = false;
        for (const mod of modules) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(mod.title, -1),
                subtitle: describe(mod),
                subtitle_lines: 4,
            });
            row.connect('notify::active', () => {
                if (syncing)
                    return;
                const order = settings.get_strv('module-order').filter(x => x !== mod.id);
                if (row.get_active())
                    order.push(mod.id);
                else
                    settings.set_strv('module-hidden', settings.get_strv('module-hidden').filter(x => x !== mod.id));
                settings.set_strv('module-order', order);
            });
            switches.set(mod.id, row);
            builtin.add(row);
        }
        const syncSwitches = () => {
            syncing = true;
            const order = settings.get_strv('module-order');
            for (const [id, row] of switches)
                row.set_active(order.includes(id));
            syncing = false;
        };
        syncSwitches();
        this._connect(settings, 'changed::module-order', syncSwitches);
        page.add(builtin);

        /* --- fonctions globales --- */
        if (features.length > 0) {
            const group = new Adw.PreferencesGroup({title: 'Fonctions'});
            for (const feat of features) {
                const row = new Adw.SwitchRow({
                    title: GLib.markup_escape_text(feat.title, -1),
                    subtitle: describe(feat),
                    subtitle_lines: 4,
                });
                settings.bind(feat.setting, row, 'active', Gio.SettingsBindFlags.DEFAULT);
                group.add(row);
            }
            page.add(group);
        }

        /* --- ajoutés : catalogue ou fichier --- */
        const added = new Adw.PreferencesGroup({
            title: 'Modules ajoutés',
            description: 'Installés depuis le catalogue ou importés depuis un fichier. '
                + 'Ils s\'exécutent dans GNOME Shell avec tes droits : n\'ajoute que du code '
                + 'en qui tu as confiance.',
        });
        const addBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        const fileButton = new Gtk.Button({
            label: 'Importer un fichier…',
            css_classes: ['flat'],
        });
        fileButton.connect('clicked', () => this._importFile(settings, page));
        const folderButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: 'Ouvrir le dossier des modules',
            css_classes: ['flat'],
        });
        folderButton.connect('clicked',
            () => Gio.AppInfo.launch_default_for_uri(`file://${modulesDir()}`, null));
        addBox.append(fileButton);
        addBox.append(folderButton);
        added.set_header_suffix(addBox);

        let addedRows = [];
        const renderAdded = () => {
            addedRows.forEach(r => added.remove(r));
            addedRows = [];
            const installed = readInstalled();
            const byPath = new Map(Object.entries(installed).map(([id, info]) => [info.path, {id, ...info}]));
            const paths = settings.get_strv('module-paths');
            if (paths.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'Aucun module ajouté',
                    subtitle: 'Parcours le catalogue pour en installer en un clic.',
                });
                const go = new Gtk.Button({
                    label: 'Catalogue',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['suggested-action'],
                });
                go.connect('clicked', () => this._window?.set_visible_page(this._pages.catalog));
                empty.add_suffix(go);
                added.add(empty);
                addedRows.push(empty);
                return;
            }
            for (const path of paths) {
                const info = byPath.get(path);
                const row = new Adw.ActionRow({
                    title: info?.title ?? GLib.path_get_basename(path),
                    subtitle: info ? `Catalogue · v${info.version}` : path.replace(GLib.get_home_dir(), '~'),
                });
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: 'Retirer',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    if (info) {
                        applyUninstall(settings, info.id, uninstallEntry(info.id));
                    } else {
                        settings.set_strv('module-paths',
                            settings.get_strv('module-paths').filter(x => x !== path));
                    }
                });
                row.add_suffix(remove);
                added.add(row);
                addedRows.push(row);
            }
        };
        renderAdded();
        this._connect(settings, 'changed::module-paths', renderAdded);
        page.add(added);

        /* --- disposition --- */
        const layout = new Adw.PreferencesGroup({title: 'Disposition'});
        const resetRow = new Adw.ActionRow({
            title: 'Réinitialiser',
            subtitle: 'Modules par défaut, dans l\'ordre par défaut. Les modules ajoutés restent installés mais sont retirés du panneau.',
        });
        const resetButton = new Gtk.Button({
            label: 'Réinitialiser',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => {
            settings.reset('module-order');
            settings.set_strv('module-hidden', []);
        });
        resetRow.add_suffix(resetButton);
        layout.add(resetRow);
        page.add(layout);

        return page;
    }

    async _importFile(settings, page) {
        const dialog = new Gtk.FileDialog({
            title: 'Choisir un module (.js)',
            modal: true,
        });
        const filter = new Gtk.FileFilter({name: 'Modules JavaScript'});
        filter.add_pattern('*.js');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        dialog.set_filters(filters);
        try {
            const file = await dialog.open(this._window, null);
            const target = Gio.File.new_for_path(`${modulesDir()}/${file.get_basename()}`);
            if (!file.equal(target))
                file.copy(target, Gio.FileCopyFlags.OVERWRITE, null, null);
            const paths = settings.get_strv('module-paths').filter(p => p !== target.get_path());
            settings.set_strv('module-paths', [...paths, target.get_path()]);
            this._toast(page, `${file.get_basename()} ajouté au panneau`);
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                this._toast(page, `Import impossible : ${e.message ?? e}`);
        }
    }

    /* ------------------------------------------------------ catalogue */

    _catalogPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Catalogue',
            icon_name: 'folder-download-symbolic',
        });
        const session = newCatalogSession();
        const cancellable = new Gio.Cancellable();
        this._cleanups.push(() => {
            cancellable.cancel();
            session.abort();
        });

        const intro = new Adw.PreferencesGroup({
            title: 'Catalogue communautaire',
            description: 'Des modules écrits par la communauté, relus avant publication. '
                + 'Un clic installe, le panneau les charge aussitôt, sans redémarrer. '
                + 'Chaque fichier est vérifié par son empreinte SHA-256.',
        });
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Actualiser',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        intro.set_header_suffix(refresh);
        const search = new Gtk.SearchEntry({
            placeholder_text: 'Rechercher un module',
            hexpand: true,
            margin_bottom: 6,
        });
        intro.add(search);
        const status = new Adw.ActionRow({title: 'Chargement du catalogue…'});
        const spinner = new Gtk.Spinner({spinning: true, valign: Gtk.Align.CENTER});
        status.add_prefix(spinner);
        intro.add(status);
        page.add(intro);

        const list = new Adw.PreferencesGroup();
        page.add(list);

        let rows = [];
        let catalog = null;
        const shellVersion = Config.PACKAGE_VERSION;
        const extVersion = this.metadata.version ?? 0;

        const render = () => {
            rows.forEach(r => list.remove(r));
            rows = [];
            if (!catalog)
                return;
            const query = search.get_text().trim().toLowerCase();
            const installed = readInstalled();
            const entries = catalog.modules.filter(e => !query
                || [e.title, e.description, e.author, ...(e.tags ?? [])]
                    .some(v => String(v ?? '').toLowerCase().includes(query)));
            list.set_title(query ? `${entries.length} résultat(s)` : `${entries.length} module(s)`);
            for (const entry of entries) {
                const row = this._catalogRow(settings, page, session, cancellable, entry,
                    installed[entry.id], incompatibility(entry, extVersion, shellVersion), render);
                list.add(row);
                rows.push(row);
            }
        };

        const load = async () => {
            spinner.set_spinning(true);
            spinner.show();
            status.set_title('Chargement du catalogue…');
            status.set_subtitle('');
            refresh.set_sensitive(false);
            try {
                catalog = await fetchCatalog(session, settings.get_string('catalog-url'), cancellable);
                if (catalog.stale) {
                    status.set_title('Hors ligne : copie locale du catalogue');
                    status.set_subtitle(catalog.error ?? '');
                } else {
                    status.set_title(`Catalogue à jour · ${catalog.modules.length} module(s)`);
                    status.set_subtitle(settings.get_string('catalog-url').replace(/^https:\/\//, ''));
                }
                render();
            } catch (e) {
                if (cancellable.is_cancelled())
                    return;
                status.set_title('Catalogue injoignable');
                status.set_subtitle(String(e.message ?? e));
            } finally {
                if (!cancellable.is_cancelled()) {
                    spinner.set_spinning(false);
                    spinner.hide();
                    refresh.set_sensitive(true);
                }
            }
        };

        refresh.connect('clicked', () => load());
        search.connect('search-changed', () => render());
        this._connect(settings, 'changed::module-paths', () => render());
        this._connect(settings, 'changed::catalog-url', () => load());

        /* --- source du catalogue --- */
        const advanced = new Adw.PreferencesGroup({
            title: 'Source',
            description: 'Pour utiliser un fork ou un catalogue privé. Vide = catalogue officiel.',
        });
        const urlRow = new Adw.EntryRow({title: 'URL du catalogue (catalog.json)'});
        urlRow.set_text(settings.get_string('catalog-url'));
        urlRow.set_show_apply_button(true);
        urlRow.connect('apply', () => {
            const text = urlRow.get_text().trim();
            if (text)
                settings.set_string('catalog-url', text);
            else
                settings.reset('catalog-url');
            urlRow.set_text(settings.get_string('catalog-url'));
        });
        advanced.add(urlRow);
        page.add(advanced);

        /* le catalogue n'est téléchargé qu'à la première ouverture de la page */
        let started = false;
        page.connect('map', () => {
            if (!started) {
                started = true;
                load();
            }
        });

        return page;
    }

    _catalogRow(settings, page, session, cancellable, entry, installed, incompatible, rerender) {
        const meta = [`v${entry.version}`];
        if (entry.author)
            meta.push(`par ${entry.author}`);
        if (entry.network?.length)
            meta.push(`réseau : ${entry.network.join(', ')}`);
        if (incompatible)
            meta.push(`⚠ ${incompatible}`);
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(entry.title, -1),
            subtitle: GLib.markup_escape_text(`${entry.description ?? ''}\n${meta.join(' · ')}`, -1),
            subtitle_lines: 4,
        });

        const source = sourceUrl(settings.get_string('catalog-url'), entry);
        if (source) {
            const code = new Gtk.Button({
                label: 'Code',
                tooltip_text: 'Lire le code source sur GitHub',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            code.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(source, null));
            row.add_suffix(code);
        }

        const upToDate = installed && compareVersions(installed.version, entry.version) >= 0;
        if (installed) {
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Désinstaller',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => {
                applyUninstall(settings, entry.id, uninstallEntry(entry.id));
                this._toast(page, `${entry.title} désinstallé`);
                rerender();
            });
            row.add_suffix(remove);
        }
        if (!upToDate) {
            const action = new Gtk.Button({
                label: installed ? 'Mettre à jour' : 'Installer',
                valign: Gtk.Align.CENTER,
                sensitive: !incompatible,
                css_classes: ['suggested-action'],
            });
            action.connect('clicked', async () => {
                action.set_sensitive(false);
                action.set_label('…');
                try {
                    const {path, previousPath} = await installEntry(session,
                        settings.get_string('catalog-url'), entry, cancellable);
                    applyInstall(settings, entry.id, path, previousPath);
                    this._toast(page, installed
                        ? `${entry.title} mis à jour — redémarre la session si l'ancienne version reste affichée`
                        : `${entry.title} ajouté au panneau`);
                } catch (e) {
                    if (cancellable.is_cancelled())
                        return;
                    this._toast(page, `${entry.title} : ${e.message ?? e}`);
                }
                rerender();
            });
            row.add_suffix(action);
        } else {
            const done = new Gtk.Image({
                icon_name: 'object-select-symbolic',
                tooltip_text: 'Installé',
                valign: Gtk.Align.CENTER,
            });
            row.add_suffix(done);
        }
        return row;
    }

    /* ------------------------------------------------ réglages modules */

    _moduleSettingsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Réglages',
            icon_name: 'emblem-system-symbolic',
        });

        const player = new Adw.PreferencesGroup({
            title: 'Lecteur',
            description: 'La hauteur se déduit de la largeur (ratio 480:270 de la '
                + 'maquette). Toutes les mesures internes — polices, marges, boutons — '
                + 'sont mises à l\'échelle proportionnellement : la carte reste une '
                + 'miniature exacte, jamais une version écrasée.',
        });
        player.add(spinRow('Largeur (px)', 'La hauteur suit automatiquement',
            settings, 'player-width', 160, 640, 10));
        const preferred = new Adw.EntryRow({title: 'Lecteur prioritaire'});
        preferred.set_text(settings.get_string('preferred-player'));
        preferred.connect('changed',
            () => settings.set_string('preferred-player', preferred.get_text().trim()));
        player.add(preferred);
        page.add(player);

        const weather = new Adw.PreferencesGroup({
            title: 'Météo',
            description: 'Ville géocodée par Open-Meteo (gratuit, sans clé). Exemple : « Lyon », « Montréal », « Tokyo ».',
        });
        const location = new Adw.EntryRow({title: 'Ville'});
        location.set_text(settings.get_string('weather-location'));
        location.connect('changed',
            () => settings.set_string('weather-location', location.get_text().trim()));
        weather.add(location);
        page.add(weather);

        const ai = new Adw.PreferencesGroup({
            title: 'Assistant IA',
            description: 'Chat éphémère branché sur Groq Cloud (console.groq.com → API Keys). '
                + 'Le modèle se change aussi d\'un clic sur son badge dans la carte. '
                + 'Le mode web (globe) ajoute un outil de recherche (flux RSS Bing).',
        });
        const apiKey = new Adw.PasswordEntryRow({title: 'Clé API Groq'});
        apiKey.set_text(settings.get_string('ai-api-key'));
        apiKey.connect('changed', () => settings.set_string('ai-api-key', apiKey.get_text().trim()));
        ai.add(apiKey);
        const model = new Adw.EntryRow({title: 'Modèle du chat'});
        model.set_text(settings.get_string('ai-model'));
        model.connect('changed', () => settings.set_string('ai-model', model.get_text().trim()));
        ai.add(model);
        const terminal = new Adw.EntryRow({title: 'Terminal à ouvrir (vide = automatique)'});
        terminal.set_text(settings.get_string('ai-terminal'));
        terminal.connect('changed', () => settings.set_string('ai-terminal', terminal.get_text().trim()));
        ai.add(terminal);
        page.add(ai);

        const rewrite = new Adw.PreferencesGroup({
            title: 'Réécriture intelligente',
            description: 'Sélectionne du texte n\'importe où, appuie sur le raccourci : le résultat remplace la sélection. '
                + 'Le premier caractère choisit l\'action : rien = correction (orthographe, ou bugs si c\'est du code) · '
                + '~ reformuler/restructurer · # exécuter une instruction (« # une fonction JS qui… ») · '
                + '> traduire (« >en ») · ! résumer · ? répondre (sous la question) · $ phrase ⇒ commande shell · = calculer.',
        });
        const rewriteAccel = new Adw.EntryRow({title: 'Raccourci (ex. <Control>m)'});
        rewriteAccel.set_text(settings.get_strv('rewrite-shortcut')[0] ?? '');
        rewriteAccel.connect('changed', () => {
            const text = rewriteAccel.get_text().trim();
            if (!text) {
                settings.set_strv('rewrite-shortcut', []);
                rewriteAccel.remove_css_class('error');
                return;
            }
            const [ok] = Gtk.accelerator_parse(text);
            if (ok) {
                rewriteAccel.remove_css_class('error');
                settings.set_strv('rewrite-shortcut', [text]);
            } else {
                rewriteAccel.add_css_class('error');
            }
        });
        rewrite.add(rewriteAccel);
        page.add(rewrite);
        return page;
    }

    /* ---------------------------------------------------------- outils */

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._cleanups.push(() => object.disconnect(id));
    }

    _toast(page, title) {
        if (this._window?.add_toast)
            this._window.add_toast(new Adw.Toast({title, timeout: 4}));
        else
            console.log(`[sidepanel] ${title}`);
    }
}

/** Sous-titre d'un module intégré : description, réseau, confidentialité. */
function describe(mod) {
    const parts = [mod.description];
    if (mod.needsKey)
        parts.push(`Demande : ${mod.needsKey} (onglet Réglages).`);
    if (mod.network)
        parts.push(`Réseau : ${mod.network}.`);
    if (mod.privacy)
        parts.push(`⚠ ${mod.privacy}`);
    return GLib.markup_escape_text(parts.join('\n'), -1);
}

/** Page GitHub du fichier d'un module, si le catalogue est sur GitHub. */
function sourceUrl(catalogUrl, entry) {
    if (entry.homepage)
        return entry.homepage;
    const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*\/)?[^/]*$/.exec(catalogUrl);
    return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${m[4] ?? ''}${entry.file}` : null;
}
