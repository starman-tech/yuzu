// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/rewrite.js — réécriture intelligente de la sélection, partout.
 *
 * Indépendant du panneau (créé par extension.js comme KeepAwake). Un
 * raccourci global (`rewrite-shortcut`, Ctrl+M par défaut) lit le texte
 * sélectionné dans l'application active (sélection PRIMARY, sinon le
 * presse-papiers), l'envoie à Groq selon un mode choisi par le PREMIER
 * caractère de la sélection, puis colle le résultat À LA PLACE de la
 * sélection (presse-papiers + Ctrl+V par clavier virtuel ; Ctrl+Maj+V dans
 * un terminal). Le presse-papiers d'origine est restauré ensuite.
 *
 *   (rien)  correction : orthographe et grammaire d'un texte, bugs et
 *           syntaxe d'un code — sans rien changer d'autre
 *   ~       reformuler, améliorer, restructurer (même sens, même langue)
 *   #       instruction à exécuter : « # une fonction JS qui… », « # un
 *           mail poli pour… » ⇒ seul le résultat est collé
 *   >       traduire (« >en », « >es »… ; « > » seul : FR ⇄ EN)
 *   !       résumer en quelques lignes
 *   ?       répondre à la question (la réponse est ajoutée sous la question)
 *   $       phrase en français ⇒ commande shell (une ligne, sans explication)
 *   =       calcul, conversion, formule ⇒ le résultat
 *
 * Règle absolue passée au modèle : jamais de tiret long ou demi-cadratin.
 *
 * Retour visuel : un petit bandeau en haut de l'écran (« ✎ correction… »,
 * « ✓ collé », erreur en rouge).
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PALETTE} from './theme.js';
import {newSession, scaleFactor, sourceRemove, timeoutAdd} from './utils.js';

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_TOKENS = 1800;
const TERMINAL_CLASSES = [
    'gnome-terminal', 'kitty', 'alacritty', 'ptyxis', 'kgx', 'console',
    'tilix', 'konsole', 'wezterm', 'foot', 'xterm', 'terminator', 'ghostty',
];

const COMMON = 'Tu es un outil de réécriture invisible intégré au système. Renvoie UNIQUEMENT le résultat demandé : '
    + 'aucun préambule, aucune explication, aucune phrase d\'introduction ni de conclusion, aucun guillemet autour, '
    + 'aucune balise de code ``` sauf si la sélection en contenait déjà. Conserve la langue, la mise en forme, '
    + 'l\'indentation et les sauts de ligne d\'origine. Interdiction absolue des tirets longs « — » et demi-cadratins « – » : '
    + 'utilise une virgule, un point ou deux-points à la place.';

/* mode → {label, prompt, append} ; `append` = le résultat s'ajoute sous la sélection */
const MODES = {
    fix: {
        label: 'correction',
        prompt: 'Corrige la sélection. Si c\'est du texte : uniquement l\'orthographe, la grammaire, la ponctuation et les accords, '
            + 'sans reformuler ni changer le ton. Si c\'est du code : corrige les bugs, erreurs de syntaxe et fautes évidentes '
            + 'sans changer le style ni ajouter de fonctionnalité. Si rien n\'est à corriger, renvoie la sélection telle quelle.',
    },
    improve: {
        label: 'reformulation',
        prompt: 'Reformule et améliore la sélection : plus claire, mieux structurée, plus fluide, même sens, même langue, '
            + 'même registre, longueur comparable. Pour du code : rends-le plus propre et lisible sans changer son comportement.',
    },
    instruct: {
        label: 'instruction',
        prompt: 'La sélection est une INSTRUCTION à exécuter (écrire un code, un texte, un mail, une liste…). '
            + 'Produis directement le résultat demandé, prêt à être collé à la place de l\'instruction. '
            + 'Pour du code, colle le code seul, sans balises.',
    },
    translate: {
        label: 'traduction',
        prompt: 'Traduis la sélection vers la langue cible indiquée. Sans cible : traduis vers l\'anglais si le texte est en français, '
            + 'sinon vers le français. Traduction naturelle, même mise en forme.',
    },
    summarize: {
        label: 'résumé',
        prompt: 'Résume la sélection en quelques lignes, dans sa langue, en gardant les informations essentielles.',
    },
    answer: {
        label: 'réponse',
        prompt: 'Réponds à la question ou à la demande contenue dans la sélection, de façon concise et directe, dans sa langue.',
        append: true,
    },
    shell: {
        label: 'commande',
        prompt: 'Transforme la demande en UNE commande shell Linux (bash, Ubuntu, GNOME), sur une seule ligne, sans explication, sans « $ ».',
    },
    compute: {
        label: 'calcul',
        prompt: 'Calcule ou convertis ce que demande la sélection et renvoie le résultat seul, avec l\'unité, '
            + 'éventuellement suivi d\'un très court détail entre parenthèses.',
    },
};

/** Premier caractère ⇒ mode ; renvoie {mode, text, extra}. */
function detectMode(raw) {
    const s = raw.replace(/^\s+/, '');
    const c = s[0];
    if (c === '~')
        return {mode: 'improve', text: s.slice(1).trim()};
    if (c === '#')
        return {mode: 'instruct', text: s.slice(1).trim()};
    if (c === '!')
        return {mode: 'summarize', text: s.slice(1).trim()};
    if (c === '?')
        return {mode: 'answer', text: s.slice(1).trim()};
    if (c === '$')
        return {mode: 'shell', text: s.slice(1).trim()};
    if (c === '=')
        return {mode: 'compute', text: s.slice(1).trim()};
    if (c === '>') {
        const m = /^>\s*([a-zA-Z]{2,3})?\b\s*/.exec(s);
        const lang = m?.[1]?.toLowerCase() ?? '';
        return {mode: 'translate', text: s.slice(m?.[0]?.length ?? 1).trim(), extra: lang ? `Langue cible : ${lang}.` : ''};
    }
    return {mode: 'fix', text: raw};
}

function stripResult(text, hadFences) {
    let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!hadFences)
        t = t.replace(/^```[\w-]*\n([\s\S]*?)\n```$/m, '$1').trim();
    /* dernière ligne de défense contre les tirets longs */
    return t.replace(/\s[—–]\s/g, ', ').replace(/[—–]/g, '-');
}

export class SmartRewrite {
    constructor(settings) {
        this._settings = settings;
        this._session = newSession();
        this._session.timeout = 60;
        this._busy = false;
        this._vkbd = null;
        this._toastActor = null;
        this._toastTimer = 0;
        this._bound = false;
        this._bind();
        this._settingsId = settings.connect('changed::rewrite-shortcut', () => this._rebind());
    }

    _bind() {
        Main.wm.addKeybinding('rewrite-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._trigger());
        this._bound = true;
    }

    _rebind() {
        if (this._bound)
            Main.wm.removeKeybinding('rewrite-shortcut');
        this._bind();
    }

    /* ---------------------------------------------------------- flux */

    /* ⚠️ Un St.Clipboard.get_text() appelé DANS le rappel d'un autre
     * get_text() fait planter gnome-shell (segfault reproduit dans le shell
     * imbriqué). Chaque lecture part donc d'un idle, jamais d'un rappel. */
    _readClipboard(type) {
        return new Promise(resolve => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                St.Clipboard.get_default().get_text(type, (_c, text) => resolve(text ?? ''));
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _trigger() {
        if (this._busy) {
            this._toast('Déjà en cours…');
            return;
        }
        this._busy = true;
        this._collect().then(({selection, previous}) => {
            if (!selection.trim()) {
                this._busy = false;
                this._toast('Sélectionne du texte d\'abord', {danger: true});
                return;
            }
            return this._run(selection, previous);
        }).catch(e => {
            console.warn(`[sidepanel] réécriture : ${e}`);
            this._toast(`Erreur : ${e.message ?? e}`, {danger: true});
        }).finally(() => {
            this._busy = false;
        });
    }

    async _collect() {
        const primary = await this._readClipboard(St.ClipboardType.PRIMARY);
        const previous = await this._readClipboard(St.ClipboardType.CLIPBOARD);
        return {selection: primary.trim() ? primary : previous, previous};
    }

    async _run(selection, previous) {
        const key = this._settings.get_string('ai-api-key').trim();
        if (!key) {
            this._toast('Clé API Groq manquante (Préférences → Modules)', {danger: true});
            return;
        }
        const {mode, text, extra} = detectMode(selection);
        if (!text) {
            this._toast('Rien après le préfixe', {danger: true});
            return;
        }
        const spec = MODES[mode];
        const target = global.display.focus_window;
        this._toast(`✎ ${spec.label}…`, {sticky: true});
        const result = await this._ask(key, spec, text, extra);
        if (!result) {
            this._toast('Réponse vide', {danger: true});
            return;
        }
        const output = spec.append ? `${selection.trim()}\n${result}` : result;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, output);
        this._paste(target);
        this._toast(`✓ ${spec.label} collée`);
        if (previous && previous !== selection) {
            timeoutAdd(1500, () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, previous);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    async _ask(key, spec, text, extra) {
        const model = this._settings.get_string('ai-model');
        const hadFences = /```/.test(text);
        const body = {
            model,
            temperature: 0.2,
            max_tokens: MAX_TOKENS,
            reasoning_format: 'hidden',
            messages: [
                {role: 'system', content: `${COMMON}\n${spec.prompt}${extra ? `\n${extra}` : ''}`},
                {role: 'user', content: text},
            ],
        };
        let data;
        try {
            data = await this._post(key, body);
        } catch (e) {
            /* certains modèles refusent reasoning_format : on réessaie sans */
            if (e.status === 400 && /reasoning/i.test(e.message)) {
                delete body.reasoning_format;
                data = await this._post(key, body);
            } else {
                throw e;
            }
        }
        return stripResult(data?.choices?.[0]?.message?.content, hadFences);
    }

    async _post(key, body, attempt = 0) {
        const msg = Soup.Message.new('POST', API_URL);
        msg.get_request_headers().append('Authorization', `Bearer ${key}`);
        msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        const raw = new TextDecoder().decode(bytes.get_data());
        /* status_code, jamais get_status() : 429 n'est pas dans l'énumération St */
        if (msg.status_code === 200)
            return JSON.parse(raw);
        let detail = '';
        try {
            detail = JSON.parse(raw)?.error?.message ?? '';
        } catch (_e) {}
        if (msg.status_code === 429 && attempt < 2) {
            const wait = Math.min(25, Math.max(2, Number(msg.get_response_headers().get_one('retry-after')) || 5));
            this._toast(`Quota atteint, nouvel essai dans ${wait} s…`, {sticky: true});
            await new Promise(resolve => timeoutAdd(wait * 1000, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
            return this._post(key, body, attempt + 1);
        }
        const err = new Error(`HTTP ${msg.status_code}${detail ? ` : ${detail}` : ''}`);
        err.status = msg.status_code;
        throw err;
    }

    /* ---------------------------------------------------------- collage */

    _paste(target) {
        try {
            if (target && !target.has_focus?.())
                target.activate(global.get_current_time());
            if (!this._vkbd) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._vkbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            const cls = (target?.get_wm_class?.() ?? '').toLowerCase();
            const terminal = TERMINAL_CLASSES.some(t => cls.includes(t));
            const keys = terminal
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];
            /* petit délai : laisser l'application reprendre le focus et
             * l'utilisateur relâcher ses touches */
            timeoutAdd(120, () => {
                for (const k of keys)
                    this._vkbd.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.PRESSED);
                for (const k of [...keys].reverse())
                    this._vkbd.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.RELEASED);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.warn(`[sidepanel] réécriture : collage : ${e}`);
            this._toast('Résultat dans le presse-papiers (Ctrl+V)', {danger: false});
        }
    }

    /* ----------------------------------------------------------- bandeau */

    _toast(text, {danger = false, sticky = false} = {}) {
        this._toastTimer = sourceRemove(this._toastTimer);
        const s = scaleFactor();
        if (!this._toastActor) {
            this._toastActor = new St.Label({style_class: 'sp-toast', reactive: false});
            this._toastActor.set_pivot_point(0.5, 0);
            Main.uiGroup.add_child(this._toastActor);
        }
        const actor = this._toastActor;
        actor.text = text;
        actor.set_style(`color: ${danger ? PALETTE.red : PALETTE.beige}; border-color: ${danger ? PALETTE.red : PALETTE.beige};`);
        const monitor = Main.layoutManager.primaryMonitor;
        const [, natW] = actor.get_preferred_width(-1);
        actor.set_position(Math.round(monitor.x + (monitor.width - natW) / 2), Math.round(monitor.y + 48 * s));
        actor.remove_all_transitions();
        if (actor.opacity < 255 || !actor.visible) {
            actor.show();
            actor.opacity = 0;
            actor.translation_y = -8 * s;
            actor.ease({opacity: 255, translation_y: 0, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        if (!sticky) {
            this._toastTimer = timeoutAdd(1800, () => {
                this._toastTimer = 0;
                actor.ease({opacity: 0, translation_y: -6 * s, duration: 260,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => actor.hide()});
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    destroy() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._bound) {
            Main.wm.removeKeybinding('rewrite-shortcut');
            this._bound = false;
        }
        this._toastTimer = sourceRemove(this._toastTimer);
        this._toastActor?.destroy();
        this._toastActor = null;
        this._session.abort();
        this._vkbd = null;
    }
}
