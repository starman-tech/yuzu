// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/catalog.js — catalogue de modules communautaires.
 *
 * Utilisable dans les DEUX processus (shell et préférences) : n'importe
 * que Gio, GLib et Soup, jamais St ni Gtk.
 *
 * Le catalogue est un JSON (clé `catalog-url`, par défaut le dépôt
 * starman-tech/sidepanel-modules) :
 *
 *   {
 *     "schema": 1,
 *     "modules": [{
 *       "id": "pomodoro", "title": "Pomodoro", "description": "…",
 *       "author": "…", "version": "1.2.0", "file": "modules/pomodoro.js",
 *       "sha256": "…", "minExtension": 5, "shell": ["46", "47"],
 *       "network": ["api.exemple.org"], "tags": ["productivité"]
 *     }]
 *   }
 *
 * `file` est relatif au dossier du catalogue. Le fichier téléchargé est
 * refusé si son SHA-256 ne correspond pas : ce qui s'exécute est
 * exactement ce qui a été relu dans le dépôt.
 *
 * Nom de fichier installé : <id>-<version>.js. GJS met en cache les modules
 * import()és par URI jusqu'au redémarrage du shell ; changer de nom à chaque
 * version est le seul moyen qu'une mise à jour prenne effet à chaud.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

export const CATALOG_SCHEMA = 1;
export const BUILTIN_IDS = ['player', 'tracker', 'market', 'todo', 'sysmon',
    'weather', 'calendar', 'launcher', 'assistant'];

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VERSION_RE = /^\d+(\.\d+){0,2}$/;

const CONFIG = `${GLib.get_user_config_dir()}/sidepanel`;
const CACHE = `${GLib.get_user_cache_dir()}/sidepanel`;

function ensure(path) {
    GLib.mkdir_with_parents(path, 0o700);
    return path;
}

export function modulesDir() {
    return ensure(`${CONFIG}/modules`);
}

const indexPath = () => `${ensure(CONFIG)}/catalog-installed.json`;
const cachePath = () => `${ensure(CACHE)}/catalog.json`;

function readJson(path, fallback) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : fallback;
    } catch (_e) {
        return fallback;
    }
}

function writeJson(path, value) {
    GLib.file_set_contents(path, JSON.stringify(value, null, 2));
}

/** -1, 0 ou 1, comme un comparateur de tri ; « 1.10 » > « 1.9 ». */
export function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d)
            return Math.sign(d);
    }
    return 0;
}

/** Entrée du catalogue valide et sûre à manipuler, ou message d'erreur. */
export function validateEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return 'entrée vide';
    if (!ID_RE.test(entry.id ?? ''))
        return `identifiant invalide « ${entry.id} »`;
    if (BUILTIN_IDS.includes(entry.id))
        return `« ${entry.id} » est réservé à un module intégré`;
    if (!entry.title)
        return 'titre manquant';
    if (!VERSION_RE.test(entry.version ?? ''))
        return `version invalide « ${entry.version} »`;
    if (!/^[\w./-]+\.js$/.test(entry.file ?? '') || entry.file.includes('..'))
        return `chemin de fichier invalide « ${entry.file} »`;
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? ''))
        return 'sha256 manquant ou invalide';
    return null;
}

/** Compatibilité avec cette extension et ce shell : null si compatible,
 * sinon la raison, à afficher telle quelle. */
export function incompatibility(entry, extensionVersion, shellVersion) {
    if (entry.minExtension && extensionVersion < entry.minExtension)
        return `demande Side Panel ${entry.minExtension} ou plus récent`;
    const major = String(shellVersion).split('.')[0];
    if (Array.isArray(entry.shell) && entry.shell.length && !entry.shell.includes(major))
        return `non testé sur GNOME ${major}`;
    return null;
}

export function newSession() {
    return new Soup.Session({timeout: 20, user_agent: 'sidepanel-catalog/1'});
}

async function getBytes(session, url, cancellable) {
    const msg = Soup.Message.new('GET', url);
    if (!msg)
        throw new Error(`URL invalide : ${url}`);
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    const status = msg.get_status();
    if (status !== Soup.Status.OK)
        throw new Error(`HTTP ${status} sur ${url}`);
    return bytes;
}

/** Télécharge le catalogue. En cas d'échec réseau, renvoie la dernière
 * copie en cache marquée `stale: true` ; lève seulement si aucune n'existe. */
export async function fetchCatalog(session, url, cancellable = null) {
    /* paramètre changé chaque minute : le cache du CDN (~5 min) ne sert
     * pas un catalogue périmé juste après une publication */
    const fresh = url.includes('?') ? url : `${url}?t=${Math.floor(Date.now() / 60000)}`;
    try {
        const bytes = await getBytes(session, fresh, cancellable);
        const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (data?.schema !== CATALOG_SCHEMA || !Array.isArray(data.modules))
            throw new Error(`format de catalogue inconnu (schema ${data?.schema})`);
        const modules = [];
        for (const entry of data.modules) {
            const err = validateEntry(entry);
            if (err)
                console.warn(`[sidepanel] catalogue : entrée ignorée — ${err}`);
            else
                modules.push(entry);
        }
        const catalog = {url, fetched: Date.now(), modules, stale: false};
        try {
            writeJson(cachePath(), catalog);
        } catch (_e) {}
        return catalog;
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        const cached = readJson(cachePath(), null);
        if (cached?.url === url && Array.isArray(cached.modules))
            return {...cached, stale: true, error: String(e.message ?? e)};
        throw e;
    }
}

/** { id: {version, path, sha256, title} } des modules installés via le catalogue. */
export function readInstalled() {
    const index = readJson(indexPath(), {});
    /* un fichier supprimé à la main n'est plus installé */
    for (const [id, info] of Object.entries(index)) {
        if (!GLib.file_test(info.path ?? '', GLib.FileTest.EXISTS))
            delete index[id];
    }
    return index;
}

function baseOf(url) {
    return url.slice(0, url.lastIndexOf('/') + 1);
}

/** Télécharge, vérifie et écrit le module. Renvoie {path, previousPath}. */
export async function installEntry(session, catalogUrl, entry, cancellable = null) {
    const err = validateEntry(entry);
    if (err)
        throw new Error(err);

    /* Les CDN (raw.githubusercontent.com : ~5 min) mettent les fichiers en
     * cache par URL complète. Sans ce paramètre, juste après une mise à jour
     * du catalogue, on recevrait le NOUVEAU catalog.json et l'ANCIEN .js (ou
     * l'inverse), et l'empreinte ne correspondrait jamais. Avec l'empreinte
     * dans l'URL, fichier et catalogue viennent toujours de la même version. */
    const url = `${baseOf(catalogUrl)}${entry.file}?h=${entry.sha256.slice(0, 16)}`;
    let bytes = await getBytes(session, url, cancellable);
    let sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
    if (sum !== entry.sha256) {
        /* le CDN a pu mettre en cache cette URL avant la publication : une
         * seconde tentative avec une URL unique passe outre */
        bytes = await getBytes(session, `${url}&r=${GLib.uuid_string_random()}`, cancellable);
        sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
    }
    if (sum !== entry.sha256) {
        throw new Error('empreinte SHA-256 différente de celle du catalogue : téléchargement refusé. '
            + 'Si le catalogue vient d’être mis à jour, réessaie dans quelques minutes.');
    }

    const path = `${modulesDir()}/${entry.id}-${entry.version}.js`;
    await Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);

    const index = readInstalled();
    const previousPath = index[entry.id]?.path ?? null;
    if (previousPath && previousPath !== path) {
        try {
            Gio.File.new_for_path(previousPath).delete(null);
        } catch (_e) {}
    }
    index[entry.id] = {version: entry.version, path, sha256: entry.sha256, title: entry.title};
    writeJson(indexPath(), index);
    return {path, previousPath};
}

/** Supprime le fichier et l'entrée d'index. Renvoie le chemin retiré. */
export function uninstallEntry(id) {
    const index = readInstalled();
    const path = index[id]?.path ?? null;
    if (path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (_e) {}
    }
    delete index[id];
    writeJson(indexPath(), index);
    return path;
}

/** Répercute une installation sur les réglages : chemin chargé, carte
 * affichée. Le shell écoute `module-paths` et importe à chaud. */
export function applyInstall(settings, id, path, previousPath) {
    const paths = settings.get_strv('module-paths').filter(p => p !== previousPath && p !== path);
    paths.push(path);
    settings.set_strv('module-paths', paths);
    const order = settings.get_strv('module-order');
    if (!order.includes(id)) {
        order.push(id);
        settings.set_strv('module-order', order);
    }
}

export function applyUninstall(settings, id, path) {
    if (path)
        settings.set_strv('module-paths', settings.get_strv('module-paths').filter(p => p !== path));
    settings.set_strv('module-order', settings.get_strv('module-order').filter(x => x !== id));
    settings.set_strv('module-hidden', settings.get_strv('module-hidden').filter(x => x !== id));
}
