// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/assistant.js — assistant IA (Groq Cloud) : chat minimal, éphémère,
 * qui connaît le contexte de travail et agit sur le terminal.
 *
 *   • Chat « rapide » : MAX_TURNS échanges gardés en mémoire, rien sur
 *     disque, la corbeille vide tout. Réponses en flux (SSE).
 *   • Contexte automatique, SANS rien indiquer : si un terminal est au
 *     premier plan, son dossier courant (/proc/<pid>/cwd du shell), la
 *     commande en cours d'exécution et les dernières commandes de
 *     l'historique sont transmis au modèle ; si c'est le gestionnaire de
 *     fichiers, le dossier affiché (titre de la fenêtre résolu par `find`).
 *     Sinon, rien de plus que ~.
 *   • Le modèle explore lui-même les dossiers avec des OUTILS (appels de
 *     fonction) : list_dir (noms et tailles, jamais le contenu des
 *     fichiers), find_path (recherche par nom), run_inspect (commande en
 *     lecture seule d'une liste blanche : ls, du, find, git status/log…,
 *     wc, stat, df, tree). Mode WEB : outil web_search (flux RSS Bing, le
 *     seul moteur qui répond sans clé ni captcha).
 *   • Chaque bloc ```bash de la réponse devient une ligne de commande avec
 *     une flèche : clic ⇒ la commande est collée dans le terminal le plus
 *     récent (activation + Ctrl+Maj+V par clavier virtuel Clutter) puis
 *     EXÉCUTÉE (Entrée), sauf si elle paraît destructive (rm -rf, reset
 *     --hard, dd…) : alors elle est seulement collée. Sans terminal
 *     ouvert, un terminal est lancé dans le dossier de contexte. Clic sur
 *     le texte de la commande ⇒ copie.
 *
 * Réglages : ai-api-key, ai-model, ai-terminal. Modèle aussi choisi d'un
 * clic sur son badge (liste chargée depuis Groq). Réseau sortant :
 * api.groq.com, www.bing.com (mode web seulement).
 *
 * Mise à l'échelle : k pour la proportion du design (maquette 380 px),
 * s pour le HiDPI (propriétés d'acteur seulement) — voir player.js.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {MODULE, PALETTE} from '../lib/theme.js';
import {newSession, scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';
import {setVectorIcon, vectorIcon} from '../lib/vectorIcons.js';
import {makeRow, slideIn, slideOut} from '../lib/widgets.js';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const DESIGN_WIDTH = 380;
const MAX_TURNS = 3;              // échanges gardés (question + réponse)
const LIST_CAP = 430;             // hauteur max de la liste (px logiques)
const MAX_TOKENS = 700;
const MAX_ROUNDS = 8;             // allers-retours d'outils par question
const TOOL_OUTPUT_CAP = 1200;     // caractères renvoyés par outil (quota 8k jetons/min)
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS_URL = 'https://api.groq.com/openai/v1/models';
const BING_RSS = 'https://www.bing.com/search?format=rss&q=';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STREAM_PAINT_MS = 70;

const TERMINAL_CLASSES = [
    'gnome-terminal', 'kitty', 'alacritty', 'ptyxis', 'kgx', 'console',
    'tilix', 'konsole', 'wezterm', 'foot', 'xterm', 'terminator', 'ghostty',
];
const FILES_CLASSES = ['nautilus', 'org.gnome.files', 'nemo', 'thunar', 'dolphin', 'pcmanfm'];
const TERMINAL_LAUNCH = {
    'kitty': dir => ['kitty', '--directory', dir],
    'gnome-terminal': dir => ['gnome-terminal', `--working-directory=${dir}`],
    'ptyxis': dir => ['ptyxis', '--working-directory', dir],
    'kgx': dir => ['kgx', '--working-directory', dir],
    'alacritty': dir => ['alacritty', '--working-directory', dir],
    'wezterm': dir => ['wezterm', 'start', '--cwd', dir],
    'foot': dir => ['foot', '--working-directory', dir],
    'tilix': dir => ['tilix', '--working-directory', dir],
    'konsole': dir => ['konsole', '--workdir', dir],
};
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'fish']);
const SKIP_DIRS = ['node_modules', '.git', '.cache', 'snap', '__pycache__', '.venv', 'venv', '.npm', '.cargo', '.rustup'];
const TOOLS_PROBE = [
    'docker', 'podman', 'git', 'gh', 'npm', 'pnpm', 'node', 'bun', 'python3',
    'pip', 'uv', 'cargo', 'go', 'gcc', 'make', 'nvidia-smi', 'ollama', 'ffmpeg',
    'rsync', 'ssh', 'flatpak', 'snap', 'apt', 'jq', 'curl', 'wget', 'wl-copy',
    'code', 'kitty', 'gnome-terminal', 'tree', 'fd', 'rg', 'du',
];
/* commande « en lecture seule » : premier mot de chaque segment autorisé */
const INSPECT_ALLOWED = new Set([
    'ls', 'du', 'find', 'tree', 'wc', 'stat', 'file', 'df', 'pwd', 'whoami',
    'git', 'head', 'grep', 'rg', 'fd', 'sort', 'uniq', 'cut', 'awk', 'sed',
    'tail', 'echo', 'date', 'uname', 'basename', 'dirname', 'realpath', 'xargs', 'tr',
]);
const INSPECT_GIT = /^git\s+(status|log|branch|diff|remote|show|stash\s+list|rev-parse|describe|tag|ls-files|shortlog)\b/;
const DANGEROUS = /\b(rm\s+-[a-zA-Z]*[rf]|rm\s+-r|rmdir|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|poweroff|git\s+(reset\s+--hard|push\s+[^\n]*--force|push\s+-f|clean\s+-[a-z]*f|checkout\s+--\s)|chmod\s+-R|chown\s+-R|truncate|>\s*\/dev\/|sudo\s+rm|kill\s+-9|pkill|killall|DROP\s+TABLE|format)\b/i;

/* ------------------------------------------------------------- helpers */

const esc = s => GLib.markup_escape_text(String(s ?? ''), -1);

function decodeEntities(s) {
    return String(s ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
        .replace(/\s+/g, ' ').trim();
}

/** Markdown minimal → Pango : gras, code en ligne, titres, puces. */
function mdToMarkup(text) {
    const inline = l => l.split(/(`[^`]+`)/g).map(p => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 1)
            return `<span foreground="${PALETTE.orangeSoft}">${esc(p.slice(1, -1))}</span>`;
        return esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    }).join('');
    return String(text ?? '').split('\n').map(line => {
        const heading = /^#{1,4}\s+(.*)$/.exec(line);
        if (heading)
            return `<b>${inline(heading[1])}</b>`;
        return inline(line.replace(/^\s*[-*•]\s+/, '  • ').replace(/^\s*(\d+)[.)]\s+/, '  $1. '));
    }).join('\n');
}

/** Découpe une réponse en segments texte / code (blocs ```). Un bloc non
 * fermé (réponse encore en flux) est traité comme du code. */
function splitSegments(text) {
    const segments = [];
    const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last)
            segments.push({type: 'text', body: text.slice(last, m.index)});
        const lang = (m[1] ?? '').toLowerCase();
        const body = m[2].replace(/^\$\s+/gm, '').trim();
        if (body)
            segments.push({type: 'code', lang, body, shell: SHELL_LANGS.has(lang)});
        last = re.lastIndex;
    }
    if (last < text.length)
        segments.push({type: 'text', body: text.slice(last)});
    return segments.filter(sg => sg.type === 'code' || sg.body.trim());
}

function stripThink(text) {
    return String(text ?? '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*$/, '')
        .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
        .trim();
}

/** Qwen écrit parfois l'appel d'outil en XML dans le texte au lieu du
 * champ tool_calls : <tool_call><function=list_dir><parameter=path>~</parameter>…
 * On le convertit en appel structuré pour ne pas perdre le tour. */
function parseInlineToolCalls(text) {
    const calls = [];
    const re = /<tool_call>\s*<function=([\w-]+)>([\s\S]*?)<\/function>\s*(?:<\/tool_call>|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const args = {};
        const pre = /<parameter=([\w-]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
        let pm;
        while ((pm = pre.exec(m[2])) !== null)
            args[pm[1]] = pm[2];
        calls.push({id: `inline_${calls.length}_${Date.now()}`, type: 'function',
            function: {name: m[1], arguments: JSON.stringify(args)}});
    }
    return calls;
}

function expandHome(p) {
    const home = GLib.get_home_dir();
    const s = String(p ?? '').trim();
    if (!s || s === '~')
        return home;
    if (s.startsWith('~/'))
        return `${home}${s.slice(1)}`;
    return s.startsWith('/') ? s : `${home}/${s}`;
}

function shortPath(path, max = 44) {
    const home = GLib.get_home_dir();
    let p = path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    if (p.length > max)
        p = `…${p.slice(-(max - 1))}`;
    return p;
}

function readLink(path) {
    try {
        return GLib.file_read_link(path);
    } catch (_e) {
        return null;
    }
}

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch (_e) {
        return '';
    }
}

/** Table ppid → [pids] construite en une passe sur /proc. */
function processTree() {
    const kids = new Map();
    const comm = new Map();
    try {
        const dir = Gio.File.new_for_path('/proc');
        const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const name = info.get_name();
            if (!/^\d+$/.test(name))
                continue;
            const stat = readFile(`/proc/${name}/stat`);
            const close = stat.lastIndexOf(')');
            if (close < 0)
                continue;
            const pid = Number(name);
            comm.set(pid, stat.slice(stat.indexOf('(') + 1, close));
            const ppid = Number(stat.slice(close + 2).split(' ')[1]);
            if (!kids.has(ppid))
                kids.set(ppid, []);
            kids.get(ppid).push(pid);
        }
        iter.close(null);
    } catch (_e) {}
    return {kids, comm};
}

function cmdline(pid) {
    return readFile(`/proc/${pid}/cmdline`).replace(/\0+$/, '').replace(/\0/g, ' ').trim();
}

function fmtSize(bytes) {
    const units = ['o', 'K', 'M', 'G', 'T'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

function shellQuote(s) {
    return `'${String(s).replace(/'/g, '\'\\\'\'')}'`;
}

/* ================================================================ carte */

class AssistantCard {
    constructor(ctx) {
        this._panel = ctx.panel;
        this._settings = ctx.settings;
        this._moduleWidth = ctx.moduleWidth;
        this._destroyed = false;
        this._session = newSession();
        this._session.timeout = 60;
        this._session.max_conns_per_host = 6;   /* flux SSE successifs vers le même hôte */
        this._cancellable = null;
        this._busy = false;
        this._web = false;
        this._turns = [];            // [{user, assistant}]
        this._timers = new Set();
        this._vkbd = null;
        this._focusWin = null;
        this._ctx = null;            // contexte de premier plan {kind, dir, label, ...}
        this._focusId = 0;
        this._machine = this._probeMachine();
        this._build();
    }

    /* ------------------------------------------------------------- UI */

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
                + `padding: ${px(16)}px; spacing: ${px(10)}px; color: ${MODULE.text};`,
        });

        /* en-tête : titre, modèle (cliquable), WEB, corbeille */
        const header = new St.BoxLayout({x_expand: true, style: `spacing: ${px(6)}px;`});
        header.add_child(new St.Label({
            text: 'ASSISTANT',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(13)}px; font-weight: bold; letter-spacing: 1px; `
                + `color: ${MODULE.textDim};`,
        }));
        this._modelBtn = new St.Button({can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._modelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(10)}px; font-weight: bold; color: ${MODULE.textMuted};`,
        });
        this._modelBtn.set_child(this._modelLabel);
        this._modelBtn.set_accessible_name('Choisir le modèle');
        const paintModel = () => this._modelBtn.set_style(
            `background-color: ${this._modelBtn.hover ? MODULE.insetHover : MODULE.inset}; `
            + `border: 2px solid ${this._modelBtn.hover ? MODULE.textDim : MODULE.strokeSoft}; `
            + `border-radius: ${px(3)}px; padding: ${px(2)}px ${px(7)}px;`);
        paintModel();
        this._modelBtn.connect('notify::hover', paintModel);
        this._modelBtn.connect('clicked', () => this._toggleModelMenu());
        header.add_child(this._modelBtn);
        this._webBtn = this._iconToggle('ui-globe', 'Recherche web', () => this._toggleWeb());
        header.add_child(this._webBtn);
        header.add_child(this._iconToggle('ui-trash', 'Vider la conversation', () => this._clear()));
        this.actor.add_child(header);

        /* ligne de contexte : « kitty · ~/Desktop/CODING » */
        this._ctxLabel = new St.Label({
            text: '',
            visible: false,
            style: `font-size: ${px(10)}px; color: ${MODULE.textMuted};`,
        });
        this._ctxLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this.actor.add_child(this._ctxLabel);

        /* menu des modèles (inline, caché) */
        this._modelMenu = new St.BoxLayout({
            vertical: true, x_expand: true, visible: false,
            style: `spacing: ${px(4)}px; padding: ${px(4)}px 0;`,
        });
        this.actor.add_child(this._modelMenu);

        /* messages */
        this._scroll = new St.ScrollView({
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._list = new St.BoxLayout({vertical: true, x_expand: true, style: `spacing: ${px(12)}px;`});
        this._scroll.set_child(this._list);
        /* jamais caché : un ScrollView masqué à la construction est mesuré
         * à zéro lors de son premier affichage (liste invisible pendant
         * tout le premier échange). Vide, sa hauteur vaut simplement 0. */
        this._scroll.height = 0;
        this.actor.add_child(this._scroll);

        /* saisie + envoi/stop */
        const inputRow = new St.BoxLayout({x_expand: true, style: `spacing: ${px(8)}px;`});
        this._entry = new St.Entry({
            style_class: 'sp-entry',
            hint_text: 'Demande une commande, une explication…',
            x_expand: true,
            can_focus: true,
            style: `font-size: ${px(12)}px; padding: ${px(7)}px ${px(10)}px;`,
        });
        const ct = this._entry.clutter_text;
        ct.set_single_line_mode(true);
        ct.set_activatable(true);
        ct.connect('activate', () => this._send(this._entry.get_text()));
        ct.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._panel?.leaveEditMode?.();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._entry.connect('button-press-event', () => {
            this._captureFocus();
            this._panel?.enterEditMode?.(ct);
            return Clutter.EVENT_PROPAGATE;
        });
        inputRow.add_child(this._entry);

        this._sendBtn = new St.Button({
            can_focus: true,
            width: jsx(36), height: jsx(36),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sendIcon = vectorIcon('ui-send', MODULE.accentInk, px(16));
        this._sendIcon.set_pivot_point(0.5, 0.5);
        this._sendBtn.set_child(this._sendIcon);
        this._sendBtn.connect('clicked', () => {
            if (this._busy)
                this._stop();
            else
                this._send(this._entry.get_text());
        });
        this._sendBtn.connect('notify::hover', () => {
            this._sendIcon.remove_all_transitions();
            this._sendIcon.ease({
                translation_x: this._sendBtn.hover && !this._busy ? 3 * s : 0,
                duration: 240, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
        inputRow.add_child(this._sendBtn);
        this.actor.add_child(inputRow);
        this._setBusy(false);

        /* ligne d'état */
        this._status = new St.Label({
            text: 'Pose une question ou demande une commande.',
            style: `font-size: ${px(10)}px; color: ${MODULE.textMuted};`,
        });
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add_child(this._status);

        this._updateModelLabel();
    }

    _iconToggle(icon, tooltip, onClick) {
        const px = this._px;
        const jsx = this._jsx;
        const btn = new St.Button({
            can_focus: true,
            width: jsx(26), height: jsx(26),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const ic = vectorIcon(icon, MODULE.textDim, px(14));
        ic.set_pivot_point(0.5, 0.5);
        btn.set_child(ic);
        btn._spOn = false;
        btn.set_accessible_name(tooltip);
        const paint = () => {
            const on = btn._spOn;
            btn.set_style(`background-color: ${on ? MODULE.accent : btn.hover ? MODULE.insetHover : MODULE.inset}; `
                + `border: 2px solid ${on ? MODULE.stroke : MODULE.strokeSoft}; border-radius: ${px(3)}px;`);
            setVectorIcon(ic, icon, on ? MODULE.accentInk : MODULE.textDim);
            ic.remove_all_transitions();
            ic.ease({scale_x: btn.hover ? 1.12 : 1, scale_y: btn.hover ? 1.12 : 1,
                duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        };
        paint();
        btn.connect('notify::hover', paint);
        btn.connect('clicked', () => onClick(btn));
        btn.spSetOn = on => {
            btn._spOn = on;
            paint();
        };
        return btn;
    }

    setTheme(_theme) {}

    /* ---------------------------------------------------------- modèles */

    _updateModelLabel() {
        const model = this._settings.get_string('ai-model');
        const short = (model.split('/').pop() ?? model).replace(/[-_.]/g, ' ').toUpperCase();
        this._modelLabel.text = short.slice(0, 18);
    }

    _toggleModelMenu() {
        if (this._modelMenu.visible) {
            slideOut(this._modelMenu, {onComplete: () => this._panel?.requestRelayout?.()});
            return;
        }
        this._modelMenu.remove_all_children();
        const current = this._settings.get_string('ai-model');
        this._modelMenu.add_child(new St.Label({
            text: 'MODÈLE',
            style: `font-size: ${this._px(9)}px; font-weight: bold; letter-spacing: 1px; `
                + `color: ${MODULE.textMuted}; padding: 0 ${this._px(4)}px;`,
        }));
        const fill = ids => {
            if (this._destroyed || !this._modelMenu.visible)
                return;
            this._modelMenu.get_children().slice(1).forEach(c => c.destroy());
            for (const id of ids) {
                this._modelMenu.add_child(makeRow(id === current ? `● ${id}` : `   ${id}`, () => {
                    this._settings.set_string('ai-model', id);
                    this._updateModelLabel();
                    this._setStatus(`Modèle : ${id}`);
                    this._toggleModelMenu();
                }, {mono: true}));
            }
            this._panel?.requestRelayout?.();
        };
        if (this._modelIds) {
            fill(this._modelIds);
        } else {
            this._modelMenu.add_child(new St.Label({
                text: 'chargement…',
                style: `font-size: ${this._px(11)}px; color: ${MODULE.textMuted}; padding: ${this._px(4)}px;`,
            }));
            this._fetchModels().then(ids => {
                this._modelIds = ids;
                fill(ids);
            }).catch(e => {
                console.warn(`[sidepanel] assistant : liste des modèles : ${e}`);
                if (!this._destroyed)
                    fill([current]);
            });
        }
        slideIn(this._modelMenu);
        this._panel?.requestRelayout?.();
    }

    /** Modèles de chat du compte (sans audio ni garde-fous). */
    async _fetchModels() {
        const key = this._settings.get_string('ai-api-key').trim();
        if (!key)
            throw new Error('clé API manquante');
        const msg = Soup.Message.new('GET', MODELS_URL);
        msg.get_request_headers().append('Authorization', `Bearer ${key}`);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        if (msg.status_code !== 200)
            throw new Error(`HTTP ${msg.status_code}`);
        const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return (data.data ?? [])
            .filter(m => m.active !== false)
            .map(m => m.id)
            .filter(id => !/whisper|tts|orpheus|guard|safeguard|playai|compound/i.test(id))
            .sort((a, b) => a.localeCompare(b));
    }

    /* --------------------------------------------------- contexte actif */

    _probeMachine() {
        const os = /PRETTY_NAME="([^"]+)"/.exec(readFile('/etc/os-release'))?.[1] ?? 'Linux';
        const shell = GLib.path_get_basename(GLib.getenv('SHELL') ?? '/bin/bash');
        const tools = TOOLS_PROBE.filter(t => GLib.find_program_in_path(t));
        return {os, shell, tools, gnome: PACKAGE_VERSION};
    }

    _windowKind(win) {
        const c = (win?.get_wm_class?.() ?? '').toLowerCase();
        if (TERMINAL_CLASSES.some(t => c.includes(t)))
            return 'terminal';
        if (FILES_CLASSES.some(t => c.includes(t)))
            return 'files';
        return null;
    }

    _terminalWindows() {
        try {
            return global.display.get_tab_list(Meta.TabList.NORMAL, null)
                .filter(w => this._windowKind(w) === 'terminal');
        } catch (_e) {
            return [];
        }
    }

    /** Mémorise la fenêtre au premier plan (avant que le grab modal du
     * panneau ne la fasse perdre) et recalcule le contexte. */
    _captureFocus() {
        const w = global.display.focus_window;
        if (w)
            this._focusWin = w;
        this._refreshContext();
    }

    _refreshContext() {
        if (this._destroyed)
            return;
        const win = this._focusWin;
        const kind = this._windowKind(win);
        if (!kind) {
            this._ctx = null;
            this._paintContext();
            return;
        }
        const label = (win.get_wm_class() ?? kind).toLowerCase().replace(/^org\.gnome\./, '');
        if (kind === 'terminal') {
            this._ctx = {kind, label, win, ...this._terminalDetails(win)};
            this._paintContext();
            return;
        }
        /* gestionnaire de fichiers : le titre est le nom du dossier */
        const title = (win.get_title() ?? '').replace(/\s+[—–-]\s+.*$/, '').trim();
        this._ctx = {kind, label: 'fichiers', win, dir: null, title};
        this._paintContext();
        this._resolveFolderTitle(title).then(dir => {
            if (this._destroyed || this._ctx?.win !== win)
                return;
            this._ctx.dir = dir;
            this._paintContext();
        });
    }

    /** cwd du shell le plus récent, commande en cours, historique. */
    _terminalDetails(win) {
        const pid = win?.get_pid?.() ?? 0;
        const out = {dir: null, running: [], history: []};
        if (pid <= 0)
            return out;
        const {kids, comm} = processTree();
        const shells = (kids.get(pid) ?? []).filter(p => /^(bash|zsh|fish|sh|dash)$/.test(comm.get(p) ?? ''));
        const shell = shells.length ? Math.max(...shells) : (kids.get(pid) ?? [])[0] ?? pid;
        out.dir = readLink(`/proc/${shell}/cwd`) ?? readLink(`/proc/${pid}/cwd`);
        out.shell = comm.get(shell) ?? 'bash';
        /* ce qui tourne dans ce shell (npm run dev, python…), une ligne chacun */
        for (const child of kids.get(shell) ?? []) {
            const c = cmdline(child);
            if (c)
                out.running.push(c.slice(0, 80));
        }
        out.history = this._readHistory(out.shell);
        return out;
    }

    _readHistory(shell) {
        const home = GLib.get_home_dir();
        let lines = [];
        if (shell === 'zsh') {
            lines = readFile(`${home}/.zsh_history`).split('\n').map(l => l.replace(/^:\s*\d+:\d+;/, ''));
        } else if (shell === 'fish') {
            lines = readFile(`${home}/.local/share/fish/fish_history`).split('\n')
                .filter(l => l.startsWith('- cmd: ')).map(l => l.slice(7));
        } else {
            lines = readFile(GLib.getenv('HISTFILE') ?? `${home}/.bash_history`).split('\n')
                .filter(l => !/^#\d+$/.test(l));
        }
        const seen = new Set();
        const recent = [];
        for (let i = lines.length - 1; i >= 0 && recent.length < 8; i--) {
            const l = lines[i].trim();
            if (l && !seen.has(l)) {
                seen.add(l);
                recent.unshift(l.slice(0, 90));
            }
        }
        return recent;
    }

    /** Nom de dossier (titre Nautilus) → chemin, via `find` sous ~. */
    async _resolveFolderTitle(title) {
        const home = GLib.get_home_dir();
        if (!title || /^(home|dossier personnel|personal folder)$/i.test(title))
            return home;
        if (title.startsWith('/'))
            return title;
        const direct = `${home}/${title}`;
        if (GLib.file_test(direct, GLib.FileTest.IS_DIR))
            return direct;
        const out = await this._spawn(['timeout', '4', 'find', home, '-maxdepth', '5',
            '(', ...SKIP_DIRS.flatMap((d, i) => (i ? ['-o'] : []).concat(['-name', d])), ')', '-prune',
            '-o', '-type', 'd', '-name', title, '-print'], null);
        const hits = out.split('\n').filter(Boolean).sort((a, b) => a.length - b.length);
        return hits[0] ?? null;
    }

    _paintContext() {
        const c = this._ctx;
        if (!c) {
            this._ctxLabel.hide();
            return;
        }
        const dir = c.dir ? shortPath(c.dir) : (c.title ? `${c.title} ?` : '…');
        const running = c.running?.length ? `  ·  ${c.running[0]}` : '';
        this._ctxLabel.text = `▸ ${c.label}  ·  ${dir}${running}`;
        this._ctxLabel.show();
    }

    _contextDir() {
        return this._ctx?.dir ?? GLib.get_home_dir();
    }

    _systemPrompt() {
        const m = this._machine;
        const home = GLib.get_home_dir();
        const c = this._ctx;
        const lines = [
            `Tu es l'assistant du panneau latéral GNOME de ${GLib.get_user_name()}. Réponds en français, très concis : pas de préambule, pas de conclusion, pas de politesse.`,
            `Machine : ${m.os}, GNOME ${m.gnome}, shell ${m.shell}, ~ = ${home}. Outils CLI présents : ${m.tools.join(', ')}.`,
        ];
        if (c?.kind === 'terminal') {
            lines.push(`Contexte : un terminal (${c.label}) est au premier plan, dossier courant ${c.dir ?? home}.`);
            if (c.running?.length)
                lines.push(`Il exécute en ce moment : ${c.running.join(' | ')}.`);
            if (c.history?.length)
                lines.push(`Dernières commandes de l'utilisateur : ${c.history.join(' ; ')}`);
        } else if (c?.kind === 'files') {
            lines.push(`Contexte : le gestionnaire de fichiers est ouvert sur ${c.dir ?? `un dossier nommé « ${c.title} »`}.`);
        } else {
            lines.push('Contexte : aucun terminal ni dossier au premier plan ; dossier de référence ~.');
        }
        lines.push(
            `Les commandes que tu proposes seront collées puis exécutées dans un terminal ouvert dans ${this._contextDir()} : chemins relatifs à ce dossier ou absolus, pas de cd inutile.`,
            'Tu as des outils pour explorer toi-même les dossiers (list_dir, find_path, run_inspect' + (this._web ? ', web_search' : '') + ') : utilise-les sans demander à l\'utilisateur où sont les choses et sans annoncer que tu vas chercher. Ne lis jamais le contenu des fichiers.',
            'Format : chaque commande à lancer va SEULE dans un bloc ```bash (une commande par bloc, sans « $ », sans commentaire), avec au plus une phrase autour. Jamais de bloc de code pour autre chose que des commandes. Signale une commande destructive.',
        );
        return lines.join('\n');
    }

    /* ------------------------------------------------------------ outils */

    _tools() {
        const tools = [
            {type: 'function', function: {
                name: 'list_dir',
                description: 'Liste un dossier : sous-dossiers et fichiers (noms, tailles), jamais le contenu. depth 1 ou 2.',
                parameters: {type: 'object', properties: {
                    path: {type: 'string', description: 'Chemin absolu ou avec ~'},
                    depth: {type: 'integer'},
                    hidden: {type: 'boolean', description: 'inclure les éléments cachés'},
                }, required: ['path']},
            }},
            {type: 'function', function: {
                name: 'find_path',
                description: 'Cherche des dossiers ou fichiers par nom (sous-chaîne, insensible à la casse) sous un dossier (défaut ~).',
                parameters: {type: 'object', properties: {
                    name: {type: 'string'},
                    root: {type: 'string'},
                    type: {type: 'string', enum: ['dir', 'file', 'any']},
                }, required: ['name']},
            }},
            {type: 'function', function: {
                name: 'run_inspect',
                description: 'Exécute une commande EN LECTURE SEULE dans le dossier de contexte (ls, du, find, tree, wc, stat, df, git status/log/branch/diff…) et renvoie sa sortie. Refusée si elle modifie quoi que ce soit ou lit le contenu d\'un fichier.',
                parameters: {type: 'object', properties: {
                    command: {type: 'string'},
                    cwd: {type: 'string', description: 'dossier d\'exécution (défaut : contexte)'},
                }, required: ['command']},
            }},
        ];
        if (this._web) {
            tools.push({type: 'function', function: {
                name: 'web_search',
                description: 'Recherche sur le web (titres, URL, extraits).',
                parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']},
            }});
        }
        return tools;
    }

    async _runTool(call, cancellable) {
        const name = call.function?.name ?? '';
        let args = {};
        try {
            args = JSON.parse(call.function?.arguments || '{}');
        } catch (_e) {}
        try {
            switch (name) {
            case 'list_dir': {
                const path = expandHome(args.path);
                this._setStatus(`explore ${shortPath(path)}…`);
                return this._listDir(path, Math.min(2, Math.max(1, Number(args.depth) || 1)), Boolean(args.hidden));
            }
            case 'find_path': {
                this._setStatus(`cherche « ${args.name} »…`);
                const root = expandHome(args.root ?? '~');
                const type = args.type === 'dir' ? ['-type', 'd'] : args.type === 'file' ? ['-type', 'f'] : [];
                const out = await this._spawn(['timeout', '6', 'find', root, '-maxdepth', '7',
                    '(', ...SKIP_DIRS.flatMap((d, i) => (i ? ['-o'] : []).concat(['-name', d])), ')', '-prune',
                    '-o', ...type, '-iname', `*${String(args.name ?? '').replace(/[*?[]/g, '')}*`, '-print'], cancellable);
                const hits = out.split('\n').filter(Boolean).slice(0, 40);
                return hits.length ? hits.join('\n') : 'Aucun résultat.';
            }
            case 'run_inspect': {
                const cmd = String(args.command ?? '').trim();
                const cwd = expandHome(args.cwd ?? this._contextDir());
                const refused = this._inspectRefused(cmd);
                if (refused)
                    return `Refusé : ${refused}`;
                this._setStatus(`exécute ${cmd.slice(0, 40)}…`);
                const out = await this._spawn(['timeout', '8', 'bash', '-c', cmd], cancellable, cwd);
                return out.trim() || '(aucune sortie)';
            }
            case 'web_search':
                this._setStatus(`recherche web « ${args.query} »…`);
                return this._searchBing(String(args.query ?? ''), cancellable);
            default:
                return `Outil inconnu : ${name}`;
            }
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
            return `Erreur : ${e.message ?? e}`;
        }
    }

    /** Liste blanche : chaque segment (| && ; ||) commence par une commande
     * autorisée, pas de redirection ni de sous-commande git qui écrit. */
    _inspectRefused(cmd) {
        if (!cmd)
            return 'commande vide';
        if (/[><]|\$\(|`|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|\bsudo\b|\bcat\b|\bless\b|\bvim?\b|\bnano\b|\bcode\b/.test(cmd))
            return 'redirection, sous-shell, lecture de fichier ou commande qui modifie';
        for (const seg of cmd.split(/\|\||&&|;|\|/)) {
            const first = seg.trim().split(/\s+/)[0] ?? '';
            if (!INSPECT_ALLOWED.has(first))
                return `« ${first} » n'est pas dans la liste blanche`;
            if (first === 'git' && !INSPECT_GIT.test(seg.trim()))
                return 'seules les sous-commandes git en lecture sont permises';
            if (/^(head|tail|grep|rg|sed|awk)\b/.test(seg.trim()) && !/\|/.test(cmd) && !/^grep\s+-[a-zA-Z]*[lLc]\b/.test(seg.trim()))
                return 'lecture de contenu de fichier interdite (utilise grep -l ou wc)';
        }
        return null;
    }

    _listDir(path, depth, hidden) {
        const lines = [];
        const walk = (p, level) => {
            if (lines.length > 120)
                return;
            let iter;
            try {
                iter = Gio.File.new_for_path(p).enumerate_children(
                    'standard::name,standard::type,standard::size,standard::is-hidden',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                lines.push(`${'  '.repeat(level)}(inaccessible : ${e.message})`);
                return;
            }
            const entries = [];
            let info;
            while ((info = iter.next_file(null)) !== null) {
                if (!hidden && info.get_is_hidden())
                    continue;
                entries.push(info);
            }
            iter.close(null);
            entries.sort((a, b) => (b.get_file_type() === Gio.FileType.DIRECTORY) - (a.get_file_type() === Gio.FileType.DIRECTORY)
                || a.get_name().localeCompare(b.get_name(), undefined, {sensitivity: 'base'}));
            for (const e of entries.slice(0, 60)) {
                const isDir = e.get_file_type() === Gio.FileType.DIRECTORY;
                lines.push(`${'  '.repeat(level)}${e.get_name()}${isDir ? '/' : `  ${fmtSize(e.get_size())}`}`);
                if (isDir && level + 1 < depth && !SKIP_DIRS.includes(e.get_name()))
                    walk(`${p}/${e.get_name()}`, level + 1);
            }
            if (entries.length > 60)
                lines.push(`${'  '.repeat(level)}… (${entries.length - 60} de plus)`);
        };
        walk(path, 0);
        return lines.length ? `${shortPath(path, 80)}:\n${lines.join('\n')}` : `${shortPath(path, 80)} : vide`;
    }

    async _spawn(argv, cancellable, cwd = null) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        if (cwd)
            launcher.set_cwd(cwd);
        const proc = launcher.spawnv(argv);
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        const text = stdout ?? '';
        return text.length > TOOL_OUTPUT_CAP ? `${text.slice(0, TOOL_OUTPUT_CAP)}\n… (tronqué)` : text;
    }

    async _searchBing(query, cancellable) {
        if (!query)
            return 'Aucune requête.';
        const msg = Soup.Message.new('GET', `${BING_RSS}${encodeURIComponent(query)}`);
        msg.get_request_headers().append('User-Agent', UA);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        if (msg.status_code !== 200)
            return `Recherche impossible (HTTP ${msg.status_code}).`;
        const xml = new TextDecoder().decode(bytes.get_data());
        const items = [];
        const re = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = re.exec(xml)) !== null && items.length < 6) {
            const block = m[1];
            const title = decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1]);
            const link = decodeEntities(/<link>([\s\S]*?)<\/link>/.exec(block)?.[1]);
            const desc = decodeEntities(/<description>([\s\S]*?)<\/description>/.exec(block)?.[1]).slice(0, 200);
            if (title && link)
                items.push(`- ${title}\n  ${link}\n  ${desc}`);
        }
        return items.length ? `Résultats pour « ${query} » :\n${items.join('\n')}` : 'Aucun résultat.';
    }

    /* -------------------------------------------------------- messages */

    _setStatus(text, danger = false) {
        if (this._destroyed)
            return;
        this._status.text = text;
        this._status.set_style(`font-size: ${this._px(10)}px; `
            + `color: ${danger ? PALETTE.red : MODULE.textMuted};`);
    }

    _toggleWeb() {
        this._web = !this._web;
        this._webBtn.spSetOn(this._web);
        this._setStatus(this._web ? 'Recherche web activée' : 'Recherche web désactivée');
    }

    _clear() {
        this._stop();
        for (const turn of this._turns) {
            turn.user.actor.destroy();
            turn.assistant?.actor.destroy();
        }
        this._turns = [];
        this._setStatus('');
        this._syncEmpty();
        this._updateListHeight();
    }

    _syncEmpty() {
        if (this._turns.length === 0)
            this._scroll.height = 0;
    }

    _textLabel(markup, {mono = false, size = 12, color = MODULE.text} = {}) {
        const px = this._px;
        const label = new St.Label({
            x_expand: true,
            style: `font-size: ${px(size)}px; color: ${color}; `
                + (mono ? 'font-family: JetBrains Mono, Ubuntu Mono, DejaVu Sans Mono, monospace; ' : ''),
        });
        const ct = label.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;
        ct.set_markup(markup);
        return label;
    }

    /** Ligne de commande : texte (clic = copier) + flèche (clic = terminal). */
    _commandRow(seg) {
        const px = this._px;
        const jsx = this._jsx;
        const danger = DANGEROUS.test(seg.body);
        const row = new St.BoxLayout({x_expand: true, style: `spacing: ${px(6)}px;`});
        const code = new St.Button({
            x_expand: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.FILL,
            style: `background-color: ${PALETTE.navyDeep}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-left: 3px solid ${danger ? PALETTE.red : MODULE.accent}; `
                + `border-radius: ${px(3)}px; padding: ${px(6)}px ${px(8)}px;`,
        });
        code.set_child(this._textLabel(esc(seg.body), {mono: true, size: 11}));
        code.set_accessible_name('Copier la commande');
        code.connect('notify::hover', () => code.set_style(
            `background-color: ${code.hover ? MODULE.inset : PALETTE.navyDeep}; border: 2px solid ${code.hover ? MODULE.textDim : MODULE.strokeSoft}; `
            + `border-left: 3px solid ${danger ? PALETTE.red : MODULE.accent}; border-radius: ${px(3)}px; padding: ${px(6)}px ${px(8)}px;`));
        code.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, seg.body);
            this._setStatus('Commande copiée');
        });
        row.add_child(code);
        if (seg.shell) {
            const run = new St.Button({
                can_focus: true,
                width: jsx(34),
                y_align: Clutter.ActorAlign.FILL,
                style: `background-color: ${danger ? MODULE.inset : MODULE.accent}; `
                    + `border: 2px solid ${danger ? PALETTE.red : MODULE.stroke}; border-radius: ${px(3)}px;`,
            });
            const icon = vectorIcon('ui-send', danger ? PALETTE.red : MODULE.accentInk, px(15));
            icon.set_pivot_point(0.5, 0.5);
            run.set_child(icon);
            run.set_accessible_name(danger ? 'Coller dans le terminal (sans exécuter)' : 'Exécuter dans le terminal');
            run.connect('notify::hover', () => {
                icon.remove_all_transitions();
                icon.ease({translation_x: run.hover ? 3 * scaleFactor() : 0, duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            });
            run.connect('clicked', () => this._runInTerminal(seg.body, !danger));
            row.add_child(run);
        }
        return row;
    }

    /** Rendu d'une réponse : texte markdown-lite + lignes de commande. */
    _renderAssistant(entry, {final = false} = {}) {
        if (this._destroyed)
            return;
        if (final)
            entry.done = true;
        else if (entry.done)
            return;   /* un tick de flux en retard ne doit pas écraser le rendu final */
        entry.body.remove_all_children();
        const text = stripThink(entry.text);
        if (!text) {
            entry.body.add_child(this._textLabel(`<span foreground="${MODULE.textMuted}">${final ? '(pas de réponse)' : '▍'}</span>`));
            return;
        }
        if (!final) {
            entry.body.add_child(this._textLabel(`${esc(text)}<span foreground="${MODULE.accent}">▍</span>`));
            return;
        }
        for (const seg of splitSegments(text)) {
            if (seg.type === 'code')
                entry.body.add_child(this._commandRow(seg));
            else
                entry.body.add_child(this._textLabel(mdToMarkup(seg.body.trim())));
        }
    }

    _pushTurn(userText) {
        const px = this._px;
        const user = {text: userText};
        user.actor = this._textLabel(`<b>›</b>  ${esc(userText)}`, {size: 11, color: MODULE.textDim});
        const body = new St.BoxLayout({vertical: true, x_expand: true, style: `spacing: ${px(6)}px;`});
        const assistant = {text: '', actor: body, body};
        this._renderAssistant(assistant);
        this._list.add_child(user.actor);
        this._list.add_child(assistant.actor);
        this._turns.push({user, assistant});
        for (const a of [user.actor, assistant.actor]) {
            a.opacity = 0;
            a.translation_y = 6 * scaleFactor();
            a.ease({opacity: 255, translation_y: 0, duration: 360, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        while (this._turns.length > MAX_TURNS) {
            const old = this._turns.shift();
            for (const a of [old.user.actor, old.assistant.actor]) {
                a.remove_all_transitions();
                a.ease({opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => a.destroy()});
            }
        }
        this._syncEmpty();
        this._updateListHeight();
        this._timer(60, () => this._updateListHeight());   /* remesure une fois posé */
        return assistant;
    }

    _updateListHeight() {
        if (this._destroyed || !this._list.get_stage())
            return;
        const [, natural] = this._turns.length ? this._list.get_preferred_height(this._list.width || -1) : [0, 0];
        const target = Math.min(natural, this._jsx(LIST_CAP));
        if (this._scroll.height !== target)
            this._scroll.height = target;
        this._scrollToEnd();
        this._panel?.requestRelayout?.();
    }

    _scrollToEnd() {
        const adj = this._scroll.vadjustment ?? this._scroll.get_vscroll_bar?.()?.adjustment;
        if (adj)
            this._timer(30, () => (adj.value = Math.max(0, adj.upper - adj.page_size)));
    }

    _timer(ms, fn) {
        const id = timeoutAdd(ms, () => {
            this._timers.delete(id);
            if (!this._destroyed)
                fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    /* ---------------------------------------------------------- requête */

    _history() {
        const msgs = [];
        for (const turn of this._turns) {
            if (!turn.assistant?.done)
                continue;
            msgs.push({role: 'user', content: turn.user.text});
            msgs.push({role: 'assistant', content: stripThink(turn.assistant.text).slice(0, 2000)});
        }
        return msgs;
    }

    _send(rawText) {
        const text = String(rawText ?? '').trim();
        if (!text || this._busy || this._destroyed)
            return;
        const key = this._settings.get_string('ai-api-key').trim();
        if (!key) {
            this._setStatus('Clé API Groq manquante : Préférences → Modules → Assistant IA', true);
            return;
        }
        this._entry.set_text('');
        if (this._modelMenu.visible)
            this._toggleModelMenu();
        this._captureFocus();
        const prior = this._history();
        const entry = this._pushTurn(text);
        this._setBusy(true);
        this._setStatus('Rédaction…');
        const messages = [
            {role: 'system', content: this._systemPrompt()},
            ...prior,
            {role: 'user', content: text},
        ];
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        const started = GLib.get_monotonic_time();

        this._converse(key, messages, entry, cancellable).then(result => {
            if (this._destroyed || cancellable.is_cancelled())
                return;
            this._renderAssistant(entry, {final: true});
            const secs = (GLib.get_monotonic_time() - started) / 1e6;
            const toks = result?.usage?.completion_tokens;
            const rate = toks && result?.usage?.completion_time ? Math.round(toks / result.usage.completion_time) : null;
            this._setStatus([(result?.model ?? '').split('/').pop(), `${secs.toFixed(1)} s`,
                rate ? `${rate} tok/s` : null, result?.toolsUsed ? `${result.toolsUsed} outil${result.toolsUsed > 1 ? 's' : ''}` : null]
                .filter(Boolean).join(' · '));
        }).catch(e => {
            if (this._destroyed)
                return;
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || cancellable.is_cancelled()) {
                this._renderAssistant(entry, {final: true});
                this._setStatus('Arrêté');
            } else {
                console.warn(`[sidepanel] assistant : ${e}`);
                if (!stripThink(entry.text))
                    entry.text = `Erreur : ${e.message ?? e}`;
                this._renderAssistant(entry, {final: true});
                this._setStatus(`Erreur : ${e.message ?? e}`, true);
            }
        }).finally(() => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            this._setBusy(false);
            this._updateListHeight();
        });
    }

    /** Boucle : flux avec outils ; tant que le modèle appelle des outils,
     * on les exécute et on relance. */
    async _converse(key, messages, entry, cancellable) {
        const model = this._settings.get_string('ai-model');
        const tools = this._tools();
        const convo = [...messages];
        let usage = null;
        let toolsUsed = 0;
        for (let round = 0; round < MAX_ROUNDS; round++) {
            entry.text = '';
            const r = await this._stream(key, {
                model, messages: convo, stream: true, reasoning_format: 'hidden',
                tools, tool_choice: round >= MAX_ROUNDS - 2 ? 'none' : 'auto',
                max_tokens: MAX_TOKENS, temperature: 0.3,
            }, entry, cancellable);
            usage = r.usage ?? usage;
            const toolCalls = r.toolCalls.length ? r.toolCalls : parseInlineToolCalls(entry.text);
            if (!toolCalls.length || round === MAX_ROUNDS - 1)
                return {usage, model: r.model, toolsUsed};
            convo.push({role: 'assistant', content: stripThink(entry.text) || '', tool_calls: toolCalls});
            if (round === MAX_ROUNDS - 3)
                convo.push({role: 'system', content: 'Tu as assez exploré : réponds maintenant sans autre appel d\'outil.'});
            for (const call of toolCalls) {
                toolsUsed++;
                const result = await this._runTool(call, cancellable);
                convo.push({role: 'tool', tool_call_id: call.id, name: call.function?.name, content: result});
            }
        }
        return {usage, model, toolsUsed};
    }

    _paintStream(entry) {
        if (this._paintPending)
            return;
        this._paintPending = true;
        this._timer(STREAM_PAINT_MS, () => {
            this._paintPending = false;
            this._renderAssistant(entry);
            this._updateListHeight();
        });
    }

    _request(key, body) {
        const msg = Soup.Message.new('POST', API_URL);
        msg.get_request_headers().append('Authorization', `Bearer ${key}`);
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(bytes));
        msg._spKey = key;
        msg._spBody = body;
        return msg;
    }

    async _readAll(stream, cancellable) {
        const dis = new Gio.DataInputStream({base_stream: stream});
        const parts = [];
        for (;;) {
            const [line] = await dis.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
            if (line === null)
                break;
            parts.push(new TextDecoder().decode(line));
        }
        try {
            dis.close(null);
        } catch (_e) {}
        return parts.join('\n');
    }

    async _httpError(msg, stream, cancellable) {
        const status = msg.status_code;   /* get_status() lève sur un code hors énumération (429) */
        let detail = '';
        try {
            const body = await this._readAll(stream, cancellable);
            detail = JSON.parse(body)?.error?.message ?? body.slice(0, 160);
        } catch (_e) {}
        const err = new Error(`HTTP ${status}${detail ? ` — ${detail}` : ''}`);
        err.status = status;
        err.retryAfter = Number(msg.get_response_headers().get_one('retry-after')) || 0;
        return err;
    }

    /** Envoi avec jusqu'à deux nouveaux essais sur 429 (quota par minute). */
    async _sendWithRetry(first, cancellable) {
        let msg = first;
        for (let attempt = 0; ; attempt++) {
            const stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
            if (msg.status_code === 200)
                return stream;
            const err = await this._httpError(msg, stream, cancellable);
            if (err.status !== 429 || err.retryAfter > 25 || attempt >= 2)
                throw err;
            const wait = Math.max(2, Math.ceil(err.retryAfter || 5));
            this._setStatus(`Quota atteint, nouvel essai dans ${wait} s…`);
            await new Promise(resolve => this._timer(wait * 1000, resolve));
            if (cancellable.is_cancelled())
                throw err;
            msg = this._request(first._spKey, first._spBody);
        }
    }

    /** Flux SSE : remplit entry.text ; accumule les appels d'outils. */
    async _stream(key, body, entry, cancellable) {
        const msg = this._request(key, body);
        const stream = await this._sendWithRetry(msg, cancellable);
        const dis = new Gio.DataInputStream({base_stream: stream});
        const decoder = new TextDecoder();
        const calls = [];
        let usage = null;
        let model = body.model;
        for (;;) {
            const [raw] = await dis.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
            if (raw === null)
                break;
            const line = decoder.decode(raw).trim();
            if (!line.startsWith('data:'))
                continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]')
                break;
            let chunk;
            try {
                chunk = JSON.parse(payload);
            } catch (_e) {
                continue;
            }
            if (chunk.error)
                throw new Error(chunk.error.message ?? 'erreur du flux');
            usage = chunk.x_groq?.usage ?? chunk.usage ?? usage;
            model = chunk.model ?? model;
            const delta = chunk.choices?.[0]?.delta ?? {};
            if (delta.content) {
                entry.text += delta.content;
                this._paintStream(entry);
            }
            for (const tc of delta.tool_calls ?? []) {
                const i = tc.index ?? calls.length;
                calls[i] ??= {id: tc.id, type: 'function', function: {name: '', arguments: ''}};
                if (tc.id)
                    calls[i].id = tc.id;
                calls[i].function.name += tc.function?.name ?? '';
                calls[i].function.arguments += tc.function?.arguments ?? '';
            }
        }
        /* libérer la connexion : un corps non fermé bloque les requêtes
         * suivantes une fois les connexions par hôte épuisées */
        try {
            dis.close(null);
        } catch (_e) {}
        return {usage, model, toolCalls: calls.filter(Boolean)};
    }

    _stop() {
        this._cancellable?.cancel();
    }

    _setBusy(busy) {
        this._busy = busy;
        const px = this._px;
        setVectorIcon(this._sendIcon, busy ? 'ui-stop' : 'ui-send', MODULE.accentInk);
        this._sendIcon.remove_all_transitions();
        this._sendIcon.translation_x = 0;
        this._sendBtn.set_style(`background-color: ${busy ? MODULE.text : MODULE.accent}; `
            + `border: 2px solid ${MODULE.stroke}; border-radius: ${px(3)}px;`);
    }

    /* --------------------------------------------------------- terminal */

    _runInTerminal(cmd, execute) {
        this._panel?.leaveEditMode?.();
        const dir = this._contextDir();
        const wins = this._terminalWindows();
        const win = (this._ctx?.kind === 'terminal' && wins.includes(this._ctx.win)) ? this._ctx.win : wins[0];
        if (win) {
            /* le terminal n'est pas dans le dossier de contexte ⇒ on y va d'abord */
            const cwd = this._terminalDetails(win).dir;
            const text = cwd && cwd !== dir && this._ctx?.kind === 'files'
                ? `cd ${shellQuote(dir)} && ${cmd}` : cmd;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            win.activate(global.get_current_time());
            this._panel?.close?.(true);
            this._timer(350, () => this._pasteShortcut(execute));
            this._setStatus(execute ? 'Exécutée dans le terminal' : 'Collée (commande sensible, non exécutée)');
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, cmd);
        if (this._spawnTerminal(dir)) {
            this._panel?.close?.(true);
            this._setStatus('Terminal ouvert');
            let tries = 0;
            const poll = () => {
                const w = this._terminalWindows()[0];
                if (w) {
                    w.activate(global.get_current_time());
                    this._timer(400, () => this._pasteShortcut(execute));
                } else if (++tries < 15) {
                    this._timer(300, poll);
                }
            };
            this._timer(800, poll);
        } else {
            this._setStatus('Aucun terminal trouvé : commande copiée', true);
        }
    }

    _spawnTerminal(dir) {
        const pref = this._settings.get_string('ai-terminal').trim();
        const candidates = pref ? [pref] : Object.keys(TERMINAL_LAUNCH);
        for (const name of candidates) {
            if (!GLib.find_program_in_path(name))
                continue;
            const argv = TERMINAL_LAUNCH[GLib.path_get_basename(name)]?.(dir) ?? [name];
            try {
                Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
                return true;
            } catch (e) {
                console.warn(`[sidepanel] assistant : lancement de ${name} : ${e}`);
            }
        }
        return false;
    }

    /** Ctrl+Maj+V (puis Entrée) via un clavier virtuel Clutter. */
    _pasteShortcut(execute) {
        try {
            if (!this._vkbd) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._vkbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            const tap = keys => {
                for (const k of keys)
                    this._vkbd.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.PRESSED);
                for (const k of [...keys].reverse())
                    this._vkbd.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.RELEASED);
            };
            tap([Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]);
            if (execute)
                this._timer(160, () => tap([Clutter.KEY_Return]));
        } catch (e) {
            console.warn(`[sidepanel] assistant : clavier virtuel : ${e}`);
            this._setStatus('Collage automatique impossible : Ctrl+Maj+V dans le terminal', true);
        }
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._captureFocus();
        if (!this._focusId) {
            this._focusId = global.display.connect('notify::focus-window', () => {
                if (global.display.focus_window)
                    this._captureFocus();
            });
        }
        this._updateListHeight();
    }

    onClose() {
        this._panel?.leaveEditMode?.();
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._modelMenu.visible) {
            this._modelMenu.hide();
            this._modelMenu.opacity = 255;
            this._modelMenu.translation_y = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._stop();
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        for (const id of this._timers)
            sourceRemove(id);
        this._timers.clear();
        this._session.abort();
        this._vkbd = null;
        this._focusWin = null;
        this._ctx = null;
    }
}

export default {
    id: 'assistant',
    title: 'Assistant IA',
    short: 'IA',
    icon: 'ui-chat',
    build(ctx) {
        return new AssistantCard(ctx);
    },
};
