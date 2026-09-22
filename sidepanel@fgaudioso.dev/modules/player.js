// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/player.js — lecteur audio.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DEUX FACTEURS D'ÉCHELLE, À NE JAMAIS CONFONDRE
 *
 *   k = largeur voulue / 480   → facteur de PROPORTION du design.
 *       La maquette de référence est dessinée pour 480×270. Pour obtenir
 *       une carte plus petite sans rien déformer, on multiplie CHAQUE
 *       mesure du design par k (polices, marges, rayons, boutons). On
 *       obtient une miniature exacte, pas une version écrasée.
 *
 *   s = facteur d'échelle HiDPI (St.ThemeContext.scale_factor)
 *       GNOME multiplie automatiquement les px du CSS et les icon_size,
 *       mais PAS les tailles fixées via les propriétés d'acteur
 *       (actor.width = 100). Seules celles-ci doivent être × s.
 *
 *   → px(v)  : mesures CSS et icon_size          = v × k
 *   → jsx(v) : propriétés d'acteur (width/height) = v × k × s
 * ═══════════════════════════════════════════════════════════════════════
 */

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {setVectorIcon, vectorIcon} from '../lib/vectorIcons.js';
import {MODULE, MODULE_ON_ART, PALETTE} from '../lib/theme.js';
import {
    Marquee, clamp, configDir, configFile, ensureDir, extractPastelAccent,
    fetchBytes, hashString, newSession, scaleFactor, sourceRemove,
    timeoutAdd,
} from '../lib/utils.js';

const DESIGN_WIDTH = 480;
const DESIGN_HEIGHT = 300;   // 270 dans la maquette + une rangée de commandes

/* repli quand aucune pochette : accent lime, encre pétrole (palette du panneau) */
const PASTEL_FALLBACK = PALETTE.orange;
const INK = PALETTE.navyDeep;

/* ------------------------------------------------------------------ D-Bus */

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2';
const PLAYER_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const PlayerIfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/><method name="Next"/><method name="Previous"/>
    <method name="Seek"><arg type="x" direction="in"/></method>
    <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <signal name="Seeked"><arg type="x"/></signal>
  </interface>
</node>`;

const AppIfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIfaceXml);
const AppProxy = Gio.DBusProxy.makeProxyWrapper(AppIfaceXml);

function metaValue(metadata, key, fallback) {
    const v = metadata?.[key];
    if (v === undefined || v === null)
        return fallback;
    try {
        return v.deep_unpack ? v.deep_unpack() : v;
    } catch (_e) {
        return fallback;
    }
}

function formatSigned(seconds, sign) {
    const total = Math.max(0, Math.round(Math.abs(seconds)));
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${sign}${m}:${sec.toString().padStart(2, '0')}`;
}

/* ---------------------------------------------- barre de progression plate */

const ProgressLine = GObject.registerClass(
class ProgressLine extends St.DrawingArea {
    _init(height) {
        super._init({x_expand: true, height, reactive: true, track_hover: true});
        this._progress = 0;
        this._lineWidth = 4;
        this._dotRadius = 6;
        this._dotBase = 6;
        this._accent = [1, 1, 1];
        this.connect('repaint', area => this._paint(area));
        this.connect('notify::hover',
            () => this._animateDot(this.hover ? this._dotBase * 1.2 : this._dotBase));
    }

    /* Cairo dessine en pixels de périphérique : ces mesures intègrent donc
     * déjà k ET s, contrairement au CSS. */
    setMetrics(lineWidth, dotRadius) {
        this._lineWidth = lineWidth;
        this._dotBase = dotRadius;
        this._dotRadius = dotRadius;
        this.queue_repaint();
    }

    /** Couleur de la piste : blanche sur une pochette, celle du thème sinon. */
    setTrack(rgba) {
        this._trackRGBA = rgba;
        this.queue_repaint();
    }

    setAccent(rgb) {
        this._accent = rgb;
        this.queue_repaint();
    }

    setProgress(value) {
        this._progress = clamp(value, 0, 1);
        this.queue_repaint();
    }

    _animateDot(target) {
        const steps = 6;
        let i = 0;
        const start = this._dotRadius;
        this._dotTimer = sourceRemove(this._dotTimer);
        this._dotTimer = timeoutAdd(12, () => {
            i++;
            if (!this.mapped && !this.visible) {
                this._dotTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._dotRadius = start + (target - start) * (i / steps);
            this.queue_repaint();
            if (i >= steps) {
                this._dotTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopTimer() {
        this._dotTimer = sourceRemove(this._dotTimer);
    }

    _paint(area) {
        const [w, h] = area.get_surface_size();
        if (w <= 0)
            return;
        const cr = area.get_context();
        const mid = h / 2;
        const pad = this._dotRadius;
        const usable = Math.max(1, w - pad * 2);
        const x = pad + usable * this._progress;
        const [r, g, b] = this._accent;

        cr.setLineCap(Cairo.LineCap.ROUND);

        cr.setSourceRGBA(...(this._trackRGBA ?? [1, 1, 1, 0.25]));
        cr.setLineWidth(this._lineWidth);
        cr.moveTo(pad, mid);
        cr.lineTo(w - pad, mid);
        cr.stroke();

        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(this._lineWidth);
        cr.moveTo(pad, mid);
        cr.lineTo(x, mid);
        cr.stroke();

        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(x, mid, this._dotRadius, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    }
});

/* ---------------------------------------------------- boîte de défilement */

/* Boîte qui ne réclame AUCUNE largeur : sans cela, un titre non ellipsé
 * impose sa largeur minimale à toute la rangée, la boîte grandit avec lui
 * et rien n'est découpé. Ici elle prend l'espace restant (x_expand), le
 * label déborde dedans, clip_to_allocation coupe, et Marquee fait défiler. */
const ClipBox = GObject.registerClass(
class ClipBox extends St.BoxLayout {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
});

/* ---------------------------------------------------- volume en blocs */

const VOLUME_STEPS = 10;

const VolumeBlocks = GObject.registerClass(
class VolumeBlocks extends St.BoxLayout {
    _init(jsx, px, onChange) {
        super._init({reactive: true, track_hover: true, style: `spacing: ${px(3)}px;`});
        this._onChange = onChange;
        this._level = 0;
        this._blocks = [];
        this._accent = '#ffffff';
        this._offColor = 'rgba(230, 213, 183, 0.18)';
        this._size = jsx(9);
        this._radius = px(1);
        for (let i = 0; i < VOLUME_STEPS; i++) {
            const block = new St.Widget({width: this._size, height: this._size, reactive: false});
            this._blocks.push(block);
            this.add_child(block);
        }
        this.connect('button-press-event', (_a, ev) => {
            this._dragging = true;
            this._pick(ev);
            return Clutter.EVENT_STOP;
        });
        this.connect('motion-event', (_a, ev) => {
            if (this._dragging)
                this._pick(ev);
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('button-release-event', () => {
            this._dragging = false;
            return Clutter.EVENT_STOP;
        });
        this.connect('leave-event', () => {
            this._dragging = false;
            return Clutter.EVENT_PROPAGATE;
        });
        this._paint();
    }

    _pick(event) {
        const [x] = event.get_coords();
        const [wx] = this.get_transformed_position();
        const width = this.get_transformed_size()[0] || this.width || 1;
        const frac = clamp((x - wx) / width, 0, 1);
        const level = Math.ceil(frac * VOLUME_STEPS) / VOLUME_STEPS;
        this.setLevel(level);
        this._onChange?.(level);
    }

    setAccent(hex) {
        this._accent = hex;
        this._paint();
    }

    setLevel(frac) {
        this._level = clamp(frac, 0, 1);
        this._paint();
    }

    _paint() {
        const lit = Math.round(this._level * VOLUME_STEPS);
        this._blocks.forEach((block, i) => {
            const on = i < lit;
            block.set_style(`border-radius: ${this._radius}px; `
                + `background-color: ${on ? this._accent : this._offColor};`);
        });
    }

    /** Couleur des blocs éteints : dépend du fond (pochette ou thème). */
    setOffColor(color) {
        this._offColor = color;
        this._paint();
    }
});

/* ------------------------------------------------------------- le module */

class PlayerCard {
    constructor(ctx) {
        this._settings = ctx.settings;
        /* largeur distribuée par le panneau : lui seul connaît la place
         * réellement disponible (padding + barre de défilement) */
        this._moduleWidth = ctx.moduleWidth;
        this._players = new Map();
        this._active = null;
        this._metadata = {};
        this._status = 'Stopped';
        this._position = 0;
        this._length = 0;
        this._artUrl = '';
        this._accent = PASTEL_FALLBACK;
        this._accentRgb = [0.96, 0.31, 0.11];
        this._favorites = new Set();
        this._dragging = false;
        this._positionTimer = 0;
        this._session = newSession();
        this._artCancel = null;
        this._cacheDir = ensureDir(`${GLib.get_user_cache_dir()}/sidepanel/art`);
        this._favFile = configFile('player-favorites.json');

        this._loadFavorites();
        this._build();
        this._watchBus();
        this._watchAudioOutput();
    }

    /* ------------------------------------------------------------- UI */

    _build() {
        const s = scaleFactor();
        const logicalWidth = this._moduleWidth
            ?? this._settings.get_int('player-width');
        const k = logicalWidth / DESIGN_WIDTH;
        const logicalHeight = Math.round(DESIGN_HEIGHT * k);

        this._k = k;
        this._s = s;
        const px = v => Math.max(1, Math.round(v * k));
        const jsx = v => Math.max(1, Math.round(v * k * s));
        this._px = px;
        this._jsx = jsx;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: logicalWidth * s,
            height: logicalHeight * s,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
            /* Pas de box-shadow ni de contour ici : l'un et l'autre sont
             * posés par ModuleCard (lib/card.js) autour du module. */
            style: `border-radius: ${px(MODULE.radius)}px;`,
        });

        this._radius = px(MODULE.radius);
        this._art = new St.Widget({
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
        });
        this.actor.add_child(this._art);

        /* Voile sombre : sans lui, un titre blanc posé sur une pochette
         * claire devient illisible. La maquette avait un fond uni sombre. */
        this._scrim = new St.Widget({
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
        });
        this.actor.add_child(this._scrim);

        const root = new St.BoxLayout({
            vertical: true,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
            style: `padding: ${px(24)}px ${px(28)}px;`,
        });
        this.actor.add_child(root);

        /* ---- haut : logo + pilule périphérique ---- */
        const topRow = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.START});
        this._appIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: px(30),
        });
        /* un clic sur le logo ramène l'application du lecteur au premier plan */
        this._appButton = new St.Button({
            child: this._appIcon,
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            style: 'background: none; border: none; padding: 0;',
        });
        this._appButton.set_accessible_name('Ouvrir le lecteur');
        this._appButton.connect('clicked', () => this._raiseApp());

        this._devicePill = new St.Button({
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        const pillBox = new St.BoxLayout({style: `spacing: ${px(8)}px;`});
        this._pillIcon = vectorIcon('headphones', INK, px(18));
        this._pillLabel = new St.Label({
            text: '—',
            y_align: Clutter.ActorAlign.CENTER,
            style: `max-width: ${px(150)}px; color: ${INK}; `
                + `font-size: ${px(14)}px; font-weight: bold;`,
        });
        this._pillLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._pillLabel.clutter_text.line_wrap = false;
        pillBox.add_child(this._pillIcon);
        pillBox.add_child(this._pillLabel);
        this._devicePill.set_child(pillBox);
        this._devicePill.set_pivot_point(0.5, 0.5);
        this._devicePill.connect('notify::hover', () => this._devicePill.ease({
            scale_x: this._devicePill.hover ? 1.04 : 1,
            scale_y: this._devicePill.hover ? 1.04 : 1,
            duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }));
        this._devicePill.connect('clicked', () => this._toggleDeviceChooser());

        topRow.add_child(this._appButton);
        topRow.add_child(this._devicePill);
        root.add_child(topRow);

        root.add_child(new St.Widget({y_expand: true}));

        /* ---- milieu : titre / artiste + gros bouton ---- */
        const midRow = new St.BoxLayout({
            x_expand: true, y_align: Clutter.ActorAlign.END,
            style: `spacing: ${px(14)}px; padding-bottom: ${px(4)}px;`,
        });
        const textBox = new St.BoxLayout({
            vertical: true, x_expand: true, y_align: Clutter.ActorAlign.END,
        });

        /* BoxLayout et non BinLayout : une boîte horizontale empile ses
         * enfants depuis la gauche, ce qui garantit l'alignement du titre
         * sur l'artiste. Avec BinLayout, le label se retrouvait centré. */
        this._titleClip = new ClipBox({
            clip_to_allocation: true,
            x_expand: true,
            height: jsx(36),
        });
        this._titleLabel = new St.Label({
            text: 'Aucune lecture',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(26)}px; font-weight: bold; color: ${MODULE.text}; `
                + `letter-spacing: -0.5px;`,
        });
        this._titleLabel.clutter_text.line_alignment = Pango.Alignment.LEFT;
        /* PAS d'ellipse : St.Label ellipse par défaut, et un titre coupé en
         * « … » ne défile pas — sa largeur minimale doit rester celle du
         * texte entier pour que la boîte le laisse déborder sous le clip,
         * et que le défilement (Marquee) révèle la suite. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = false;
        this._titleClip.add_child(this._titleLabel);
        this._marquee = new Marquee(this._titleLabel, {pxPerSec: 28});
        this._titleClip.connect('notify::width', () => this._updateMarquee());

        this._artistLabel = new St.Label({
            text: 'Lance Spotify ou un autre lecteur',
            style: `font-size: ${px(15)}px; color: ${MODULE.textDim}; `
                + `padding-top: ${px(4)}px;`,
        });
        textBox.add_child(this._titleClip);
        textBox.add_child(this._artistLabel);

        this._playButton = new St.Button({
            width: jsx(72),
            height: jsx(72),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._playIcon = vectorIcon('play-triangle', INK, px(28));
        this._playButton.set_child(this._playIcon);
        this._playButton.set_pivot_point(0.5, 0.5);
        this._playButton.connect('notify::hover', () => this._playButton.ease({
            scale_x: this._playButton.hover ? 1.06 : 1,
            scale_y: this._playButton.hover ? 1.06 : 1,
            duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }));
        this._playButton.connect('clicked', () => this._call('PlayPause'));

        midRow.add_child(textBox);
        midRow.add_child(this._playButton);
        root.add_child(midRow);

        root.add_child(new St.Widget({y_expand: true}));

        /* ---- bas ---- */
        const bottomRow = new St.BoxLayout({
            x_expand: true, style: `spacing: ${px(16)}px;`,
        });

        this._favButton = this._bareButton('plus-circle', 'Ajouter aux favoris',
            () => this._toggleFavorite());

        const progressBox = new St.BoxLayout({
            vertical: true, x_expand: true, style: `spacing: ${px(6)}px;`,
        });
        this._progress = new ProgressLine(jsx(16));
        this._progress.setMetrics(Math.max(2, 4 * k * s), Math.max(3, 6 * k * s));
        this._progress.connect('button-press-event', (_a, ev) => {
            this._dragging = true;
            this._seekFromEvent(ev, false);
            return Clutter.EVENT_STOP;
        });
        this._progress.connect('motion-event', (_a, ev) => {
            if (this._dragging)
                this._seekFromEvent(ev, true);
            return Clutter.EVENT_PROPAGATE;
        });
        this._progress.connect('button-release-event', (_a, ev) => {
            if (this._dragging) {
                this._dragging = false;
                this._seekFromEvent(ev, false);
            }
            return Clutter.EVENT_STOP;
        });
        this._progress.connect('leave-event', () => {
            this._dragging = false;
            return Clutter.EVENT_PROPAGATE;
        });

        const timeRow = new St.BoxLayout({x_expand: true});
        const timeStyle = `font-size: ${px(12)}px; font-weight: bold; color: ${MODULE.textDim};`;
        this._elapsedLabel = new St.Label({text: '0:00', style: timeStyle});
        this._remainingLabel = new St.Label({
            text: '-0:00', x_expand: true, x_align: Clutter.ActorAlign.END, style: timeStyle,
        });
        timeRow.add_child(this._elapsedLabel);
        timeRow.add_child(this._remainingLabel);
        progressBox.add_child(this._progress);
        progressBox.add_child(timeRow);

        this._prevButton = this._bareButton('skip-back', 'Précédent',
            () => this._call('Previous'));
        this._nextButton = this._bareButton('skip-forward', 'Suivant',
            () => this._call('Next'));
        this._shuffleButton = this._bareButton('ui-shuffle', 'Lecture aléatoire',
            () => this._toggleShuffle());
        /* L'icône « ((o)) » de la maquette est celle de la diffusion vers un
         * appareil (Spotify Connect), pas de la lecture aléatoire. */
        this._castButton = this._bareButton('podcast', 'Choisir la sortie audio',
            () => this._toggleDeviceChooser());
        this._loopButton = this._bareButton('repeat', 'Répétition',
            () => this._cycleLoop());

        bottomRow.add_child(this._favButton);
        bottomRow.add_child(progressBox);
        bottomRow.add_child(this._prevButton);
        bottomRow.add_child(this._nextButton);
        root.add_child(bottomRow);

        /* ---- rangée de commandes : aléatoire, répétition, sortie, volume ---- */
        const ctrlRow = new St.BoxLayout({
            x_expand: true, y_align: Clutter.ActorAlign.END,
            style: `spacing: ${px(10)}px; padding-top: ${px(6)}px;`,
        });
        ctrlRow.add_child(this._shuffleButton);
        ctrlRow.add_child(this._loopButton);
        ctrlRow.add_child(this._castButton);

        ctrlRow.add_child(new St.Widget({x_expand: true}));

        /* Volume en BLOCS (pixel) : rien à voir avec la barre de
         * progression, et lisible d'un coup d'œil. Clic sur un bloc = ce
         * niveau ; molette = ±5 %. */
        this._volumeIcon = vectorIcon('ui-volume', this._accent, px(18));
        this._volumeIcon.set_y_align(Clutter.ActorAlign.CENTER);
        this._volume = new VolumeBlocks(jsx, px, frac => this._setVolume(frac));
        this._volume.set_y_align(Clutter.ActorAlign.CENTER);
        this._volume.connect('scroll-event', (_a, ev) => {
            const dir = ev.get_scroll_direction();
            const step = dir === Clutter.ScrollDirection.UP ? 0.05
                : dir === Clutter.ScrollDirection.DOWN ? -0.05 : 0;
            if (step !== 0)
                this._setVolume(clamp((this._volumeFrac ?? 0) + step, 0, 1));
            return Clutter.EVENT_STOP;
        });
        ctrlRow.add_child(this._volumeIcon);
        ctrlRow.add_child(this._volume);
        root.add_child(ctrlRow);

        this._buildDeviceChooser();
        this._applyAccent(this._accent);
        this._setArtFile(null);
    }

    _bareButton(iconName, tooltip, onClick) {
        const {_px: px, _jsx: jsx} = this;
        const button = new St.Button({
            style: 'background-color: transparent; border: none;',
            width: jsx(36),
            height: jsx(36),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = vectorIcon(iconName, this._accent, px(24));
        icon.set_pivot_point(0.5, 0.5);
        button.set_child(icon);
        button.set_accessible_name(tooltip);

        button._spIconName = iconName;
        button._spIcon = icon;
        button._spActive = false;

        button.connect('notify::hover', () => icon.ease({
            scale_x: button.hover ? 1.15 : 1,
            scale_y: button.hover ? 1.15 : 1,
            duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }));
        button.connect('clicked', () => onClick());
        return button;
    }

    setTheme(_theme) {}

    /** État d'un petit bouton : actif = bloc accent plein avec icône encre,
     * inactif = icône accent seule, atténuée. */
    _setBareActive(button, active) {
        if (!button)
            return;
        const px = this._px;
        button._spActive = active;
        button.set_style(active
            ? `background-color: ${this._accent}; border: none; border-radius: ${px(MODULE.radius)}px;`
            : 'background-color: transparent; border: none;');
        setVectorIcon(button._spIcon, button._spIconName, active ? INK : this._accent);
        button._spIcon.opacity = active ? 255 : 190;
    }

    /* ------------------------------------------------- couleur d'accent */

    _applyAccent(hex) {
        this._accent = hex;
        this._accentRgb = [
            parseInt(hex.slice(1, 3), 16) / 255,
            parseInt(hex.slice(3, 5), 16) / 255,
            parseInt(hex.slice(5, 7), 16) / 255,
        ];
        const px = this._px;

        /* seul le pictogramme de repli prend l'accent : l'icône réelle de
         * l'application (fichier .desktop du lecteur) reste intacte */
        if (!this._appIcon.gicon || this._appIconIsFallback)
            this._setFallbackAppIcon();
        this._devicePill.set_style(
            `background-color: ${hex}; border-radius: ${px(MODULE.radius)}px; `
            + `border: ${px(2)}px solid ${INK}; `
            + `padding: ${px(6)}px ${px(16)}px;`);
        this._playButton.set_style(
            `border-radius: ${px(MODULE.radius)}px; background-color: ${hex}; `
            + `border: ${px(3)}px solid ${INK};`);
        this._progress.setAccent(this._accentRgb);

        /* Les icônes du bas portent la couleur dérivée de la pochette ;
         * les boutons à état gardent leur rendu actif/inactif. */
        for (const button of [this._prevButton, this._nextButton, this._castButton])
            setVectorIcon(button._spIcon, button._spIconName, hex);
        for (const button of [this._favButton, this._shuffleButton, this._loopButton])
            this._setBareActive(button, Boolean(button._spActive));
        setVectorIcon(this._volumeIcon, 'ui-volume', hex);
        this._volume?.setAccent(hex);

        this._applyAppIcon(this._players.get(this._active));
    }

    /* ------------------------------------------- sélecteur de sortie audio */

    _buildDeviceChooser() {
        const px = this._px;
        this._deviceOverlay = new St.BoxLayout({
            vertical: true,
            visible: false,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
            style: `background-color: ${MODULE.surfaceStrong}; `
                + `border-radius: ${this._radius}px; padding: ${px(16)}px ${px(20)}px;`,
        });

        const header = new St.BoxLayout({x_expand: true});
        const title = new St.Label({
            text: 'Sortie audio',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(15)}px; font-weight: bold; color: ${MODULE.text};`,
        });
        const close = new St.Button({
            label: '✕',
            can_focus: true,
            style: `color: ${MODULE.text}; font-size: ${px(15)}px; `
                + `background: none; border: none;`,
        });
        close.connect('clicked', () => this._toggleDeviceChooser(false));
        header.add_child(title);
        header.add_child(close);
        this._deviceOverlay.add_child(header);

        this._deviceList = new St.BoxLayout({
            vertical: true, x_expand: true,
            style: `spacing: ${px(6)}px; padding-top: ${px(10)}px;`,
        });
        const scroll = new St.ScrollView({
            x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scroll.set_child(this._deviceList);
        this._deviceOverlay.add_child(scroll);

        this.actor.add_child(this._deviceOverlay);
    }

    _toggleDeviceChooser(force) {
        const show = force ?? !this._deviceOverlay.visible;
        if (show) {
            this._populateDevices();
            this._deviceOverlay.opacity = 0;
            this._deviceOverlay.show();
            this._deviceOverlay.ease({
                opacity: 255, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._deviceOverlay.ease({
                opacity: 0, duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._deviceOverlay.hide(),
            });
        }
    }

    _populateDevices() {
        const px = this._px;
        this._deviceList.destroy_all_children();

        let sinks = [];
        try {
            sinks = this._mixer?.get_sinks() ?? [];
        } catch (_e) {}

        if (sinks.length === 0) {
            this._deviceList.add_child(new St.Label({
                text: 'Aucune sortie détectée.',
                style: `color: ${MODULE.textDim}; font-size: ${px(13)}px;`,
            }));
            return;
        }

        let currentId = -1;
        try {
            currentId = this._mixer?.get_default_sink()?.get_id() ?? -1;
        } catch (_e) {}

        for (const sink of sinks) {
            const name = sink.get_description() || sink.get_name();
            const isCurrent = sink.get_id() === currentId;
            const row = new St.Button({
                x_expand: true,
                can_focus: true,
                style: `border-radius: ${px(MODULE.radius)}px; padding: ${px(9)}px ${px(12)}px; `
                    + `background-color: ${isCurrent ? this._accent : MODULE.inset}; `
                    + `color: ${isCurrent ? INK : MODULE.text}; `
                    + `font-size: ${px(13)}px;`,
            });
            const rowBox = new St.BoxLayout({x_expand: true, style: `spacing: ${px(8)}px;`});
            rowBox.add_child(vectorIcon('headphones', isCurrent ? INK : MODULE.text, px(16)));
            const label = new St.Label({
                text: name,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            rowBox.add_child(label);
            row.set_child(rowBox);
            row.connect('clicked', () => {
                this._setDefaultSink(sink);
                this._toggleDeviceChooser(false);
            });
            this._deviceList.add_child(row);
        }
    }

    _setDefaultSink(sink) {
        try {
            this._mixer?.set_default_sink(sink);
            this._refreshOutputName();
        } catch (e) {
            console.error(`[sidepanel] changement de sortie : ${e}`);
        }
    }

    /* --------------------------------------------------------- D-Bus */

    _watchBus() {
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', MPRIS_PREFIX,
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _s, _o, _i, _sig, params) => {
                const [name, , newOwner] = params.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner)
                    this._addPlayer(name);
                else
                    this._removePlayer(name);
            });

        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deep_unpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    console.error(`[sidepanel] ListNames: ${e}`);
                }
            });
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;
        const entry = {
            player: null, app: null, gicon: null,
            identity: busName.replace(`${MPRIS_PREFIX}.`, ''),
        };
        this._players.set(busName, entry);

        new PlayerProxy(Gio.DBus.session, busName, PLAYER_PATH, (proxy, error) => {
            if (error || !this._players.has(busName)) {
                this._players.delete(busName);
                return;
            }
            entry.player = proxy;
            entry.propsId = proxy.connect('g-properties-changed', () => {
                if (this._active === busName)
                    this._sync();
                else
                    this._pick();
            });
            entry.seekId = proxy.connectSignal('Seeked', (_p, _s, [pos]) => {
                if (this._active === busName) {
                    this._position = pos;
                    this._updateProgress();
                }
            });
            this._pick();
        });

        new AppProxy(Gio.DBus.session, busName, PLAYER_PATH, (proxy, error) => {
            if (error || !this._players.has(busName))
                return;
            entry.app = proxy;
            try {
                entry.identity = proxy.Identity || entry.identity;
            } catch (_e) {}
            try {
                const desktop = proxy.DesktopEntry;
                if (desktop) {
                    const appSystem = Shell.AppSystem.get_default();
                    const app = appSystem.lookup_app(`${desktop}.desktop`)
                        ?? appSystem.lookup_app(`${desktop.toLowerCase()}.desktop`);
                    entry.gicon = app?.get_icon() ?? null;
                }
            } catch (_e) {}
            if (this._active === busName)
                this._applyAppIcon(entry);
        });
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry)
            return;
        if (entry.player) {
            if (entry.propsId)
                entry.player.disconnect(entry.propsId);
            if (entry.seekId)
                entry.player.disconnectSignal(entry.seekId);
        }
        this._players.delete(busName);
        if (this._active === busName)
            this._active = null;
        this._pick();
    }

    _pick() {
        const preferred = (this._settings.get_string('preferred-player') || '').toLowerCase();
        let best = null;
        let bestScore = -1;
        for (const [busName, entry] of this._players) {
            if (!entry.player)
                continue;
            let status = 'Stopped';
            try {
                status = entry.player.PlaybackStatus ?? 'Stopped';
            } catch (_e) {}
            let score = status === 'Playing' ? 4 : status === 'Paused' ? 2 : 0;
            if (preferred && busName.toLowerCase().includes(preferred))
                score += 8;
            if (score > bestScore) {
                bestScore = score;
                best = busName;
            }
        }
        if (best !== this._active) {
            this._active = best;
            this._position = 0;
        }
        this._sync();
    }

    get _player() {
        return this._active ? this._players.get(this._active)?.player : null;
    }

    _call(method) {
        try {
            this._player?.[`${method}Remote`]();
        } catch (e) {
            console.error(`[sidepanel] ${method}: ${e}`);
        }
    }

    _applyAppIcon(entry) {
        if (entry?.gicon) {
            this._appIconIsFallback = false;
            this._appIcon.gicon = entry.gicon;
            return;
        }
        this._setFallbackAppIcon();
    }

    _setFallbackAppIcon() {
        this._appIconIsFallback = true;
        setVectorIcon(this._appIcon, 'ui-music', this._accent);
    }

    /* ------------------------------------------------------------ sync */

    _sync() {
        if (this._destroyed)
            return;
        const player = this._player;
        if (!player) {
            this._titleLabel.text = 'Aucune lecture';
            this._artistLabel.text = 'Lance Spotify ou un autre lecteur';
            this._status = 'Stopped';
            this._length = 0;
            this._position = 0;
            setVectorIcon(this._playIcon, 'play-triangle', INK);
            this._setBareActive(this._loopButton, false);
            this._setBareActive(this._shuffleButton, false);
            this._setArtFile(null);
            this._updateProgress();
            this._updateFavoriteState();
            this._stopTimers();
            return;
        }

        try {
            this._metadata = player.Metadata ?? {};
        } catch (_e) {
            this._metadata = {};
        }
        try {
            this._status = player.PlaybackStatus ?? 'Stopped';
        } catch (_e) {
            this._status = 'Stopped';
        }

        const artists = metaValue(this._metadata, 'xesam:artist', []);
        this._titleLabel.text = metaValue(this._metadata, 'xesam:title', 'Titre inconnu');
        this._artistLabel.text = (Array.isArray(artists) ? artists.join(', ') : artists) || '—';
        this._length = metaValue(this._metadata, 'mpris:length', 0) || 0;
        this._applyAppIcon(this._players.get(this._active));
        this._updateMarquee();
        this._updateFavoriteState();

        const playing = this._status === 'Playing';
        setVectorIcon(this._playIcon, playing ? 'pause-bars' : 'play-triangle', INK);

        try {
            this._setBareActive(this._loopButton, (player.LoopStatus ?? 'None') !== 'None');
        } catch (_e) {}
        try {
            this._setBareActive(this._shuffleButton, Boolean(player.Shuffle));
        } catch (_e) {}

        this._loadArt(metaValue(this._metadata, 'mpris:artUrl', ''));
        this._fetchPosition();

        if (playing)
            this._startTimers();
        else
            this._stopTimers();
    }

    _updateMarquee() {
        if (this._titleClip.width > 0)
            this._marquee.update(this._titleClip.width);
    }

    /* --------------------------------------------------- sortie audio */

    _watchAudioOutput() {
        try {
            this._mixer = new Gvc.MixerControl({name: 'SidePanel'});
            this._mixerStateId = this._mixer.connect('state-changed', (_c, state) => {
                if (state === Gvc.MixerControlState.READY)
                    this._refreshOutputName();
            });
            this._mixerSinkId = this._mixer.connect('default-sink-changed',
                () => this._refreshOutputName());
            this._mixer.open();
        } catch (e) {
            console.warn(`[sidepanel] Gvc indisponible : ${e}`);
            if (!this._destroyed)
                this._pillLabel.text = 'Sortie audio';
        }
    }

    _refreshOutputName() {
        if (this._destroyed)
            return;
        try {
            const sink = this._mixer?.get_default_sink();
            const name = sink?.get_description() ?? sink?.get_name();
            if (name)
                this._pillLabel.text = name;
        } catch (_e) {}
        this._watchSinkVolume();
    }

    /* ------------------------------------------------------------ volume */

    /** Suit le volume du périphérique par défaut (Gvc). */
    _watchSinkVolume() {
        let sink = null;
        try {
            sink = this._mixer?.get_default_sink() ?? null;
        } catch (_e) {}
        if (sink === this._volSink)
            return this._syncVolume();
        if (this._volSink && this._volSinkId) {
            try {
                this._volSink.disconnect(this._volSinkId);
            } catch (_e) {}
        }
        this._volSink = sink;
        this._volSinkId = sink ? sink.connect('notify::volume', () => this._syncVolume()) : 0;
        this._syncVolume();
    }

    _syncVolume() {
        if (this._destroyed || !this._volume || !this._volSink)
            return;
        try {
            const max = this._mixer.get_vol_max_norm() || 65536;
            this._volumeFrac = clamp(this._volSink.volume / max, 0, 1);
            this._volume.setLevel(this._volumeFrac);
        } catch (_e) {}
    }

    _setVolume(frac) {
        if (!this._volSink || !this._mixer)
            return;
        try {
            const max = this._mixer.get_vol_max_norm() || 65536;
            this._volumeFrac = clamp(frac, 0, 1);
            this._volume.setLevel(this._volumeFrac);
            this._volSink.volume = Math.round(this._volumeFrac * max);
            this._volSink.push_volume();
        } catch (e) {
            console.warn(`[sidepanel] volume : ${e}`);
        }
    }

    /* Ramène la fenêtre du lecteur actif au premier plan. */
    _raiseApp() {
        const entry = this._players.get(this._active);
        let desktop = null;
        try {
            desktop = entry?.app?.DesktopEntry ?? null;
        } catch (_e) {}
        if (!desktop)
            return;
        const appSystem = Shell.AppSystem.get_default();
        const app = appSystem.lookup_app(`${desktop}.desktop`)
            ?? appSystem.lookup_app(`${desktop.toLowerCase()}.desktop`);
        try {
            app?.activate();
        } catch (e) {
            console.warn(`[sidepanel] activation de ${desktop} : ${e}`);
        }
    }

    _toggleShuffle() {
        const player = this._player;
        if (!player)
            return;
        try {
            player.Shuffle = !player.Shuffle;
        } catch (e) {
            console.error(`[sidepanel] Shuffle : ${e}`);
        }
    }

    /* ----------------------------------------------------------- favoris */

    async _loadFavorites() {
        try {
            const file = Gio.File.new_for_path(this._favFile);
            const [ok, bytes] = await new Promise(resolve => {
                file.load_contents_async(null, (f, res) => {
                    try {
                        resolve(f.load_contents_finish(res));
                    } catch (_e) {
                        resolve([false, null]);
                    }
                });
            });
            if (ok)
                this._favorites = new Set(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (_e) {}
        /* lecture asynchrone : la carte a pu être reconstruite entre-temps */
        if (!this._destroyed)
            this._updateFavoriteState();
    }

    _saveFavorites() {
        try {
            configDir();
            GLib.file_set_contents(this._favFile, JSON.stringify([...this._favorites]));
        } catch (_e) {}
    }

    _trackKey() {
        const artists = metaValue(this._metadata, 'xesam:artist', []);
        const title = metaValue(this._metadata, 'xesam:title', '');
        const artist = Array.isArray(artists) ? artists.join(', ') : artists;
        return title ? `${title}—${artist}` : null;
    }

    _toggleFavorite() {
        const key = this._trackKey();
        if (!key)
            return;
        if (this._favorites.has(key))
            this._favorites.delete(key);
        else
            this._favorites.add(key);
        this._saveFavorites();
        this._updateFavoriteState();
    }

    _updateFavoriteState() {
        if (!this._favButton)
            return;
        const key = this._trackKey();
        const liked = !!key && this._favorites.has(key);
        this._setBareActive(this._favButton, liked);
    }

    /* --------------------------------------------------------- pochette */

    async _loadArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        this._artCancel?.cancel();
        this._artCancel = null;

        if (!url) {
            this._setArtFile(null);
            return;
        }
        if (url.startsWith('file://')) {
            this._setArtFile(GLib.uri_unescape_string(url.slice(7), null));
            return;
        }
        if (!url.startsWith('http')) {
            this._setArtFile(null);
            return;
        }

        const path = `${this._cacheDir}/${hashString(url)}.img`;
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._setArtFile(path);
            return;
        }
        this._artCancel = new Gio.Cancellable();
        try {
            const bytes = await fetchBytes(this._session, url, this._artCancel);
            GLib.file_set_contents(path, bytes.get_data());
            if (this._artUrl === url && !this._destroyed)
                this._setArtFile(path);
        } catch (_e) {
            /* annulée par destroy() ou par une nouvelle pochette : ne rien toucher */
            if (this._artUrl === url && !this._destroyed)
                this._setArtFile(null);
        } finally {
            this._artCancel = null;
        }
    }

    /** Couleurs du texte posé sur la carte : claires sur une pochette,
     * celles du thème sinon. */
    _restyleText(pal) {
        const px = this._px;
        this._textPal = pal;
        this._titleLabel.set_style(`font-size: ${px(26)}px; font-weight: bold; color: ${pal.text}; `
            + 'letter-spacing: -0.5px;');
        this._artistLabel.set_style(`font-size: ${px(15)}px; color: ${pal.textDim}; `
            + `padding-top: ${px(4)}px;`);
        const timeStyle = `font-size: ${px(12)}px; font-weight: bold; color: ${pal.textDim};`;
        this._elapsedLabel.set_style(timeStyle);
        this._remainingLabel.set_style(timeStyle);
        this._progress?.setTrack?.(pal === MODULE_ON_ART
            ? [1, 1, 1, 0.25] : [0.118, 0.133, 0.239, 0.18]);
        this._volume?.setOffColor(pal === MODULE_ON_ART
            ? 'rgba(230, 213, 183, 0.18)' : MODULE.strokeSoft);
    }

    _setArtFile(path) {
        if (!this._art)
            return;
        const has = path && GLib.file_test(path, GLib.FileTest.EXISTS);
        const r = this._radius;

        this._art.set_style(has
            ? `border-radius: ${r}px; background-size: cover; `
              + `background-position: center; `
              + `background-image: url("file://${encodeURI(path)}");`
            : `border-radius: ${r}px; background-color: ${MODULE.strokeSoft};`);

        /* Voile plus dense à gauche, là où se trouvent titre et artiste. */
        /* Avec pochette : voile sombre, plus dense à gauche où se trouvent
         * titre et artiste, et texte clair quel que soit le thème. Sans
         * pochette : la carte suit le thème (fond et texte de la palette). */
        this._scrim.set_style(has
            ? `border-radius: ${r}px;
               background-gradient-direction: horizontal;
               background-gradient-start: rgba(18, 21, 42, 0.90);
               background-gradient-end: rgba(18, 21, 42, 0.45);`
            : `border-radius: ${r}px; background-color: ${MODULE.surface};`);
        this._restyleText(has ? MODULE_ON_ART : MODULE);

        this._applyAccent(has ? extractPastelAccent(path) : PASTEL_FALLBACK);
    }

    /* --------------------------------------------------------- position */

    _fetchPosition() {
        const player = this._player;
        if (!player)
            return;
        player.call('org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            Gio.DBusCallFlags.NONE, 800, null,
            (proxy, res) => {
                try {
                    const [variant] = proxy.call_finish(res).deep_unpack();
                    this._position = variant.deep_unpack();
                    this._updateProgress();
                } catch (_e) {}
            });
    }

    _startTimers() {
        if (this._positionTimer)
            return;
        this._positionTimer = timeoutAdd(1000, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            if (!this._dragging) {
                this._position += 1000000;
                this._updateProgress();
            }
            this._ticks = (this._ticks ?? 0) + 1;
            if (this._ticks % 5 === 0)
                this._fetchPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimers() {
        this._positionTimer = sourceRemove(this._positionTimer);
    }

    _updateProgress() {
        /* Appelé par un timer et par des retours D-Bus asynchrones : ces
         * appels peuvent survenir après la destruction du module, sur des
         * acteurs déjà libérés. */
        if (this._destroyed || !this._progress)
            return;
        const frac = this._length > 0 ? this._position / this._length : 0;
        this._progress.setProgress(frac);
        this._elapsedLabel.text = formatSigned(this._position / 1e6, '');
        this._remainingLabel.text = this._length > 0
            ? formatSigned((this._length - this._position) / 1e6, '-')
            : '-0:00';
    }

    _seekFromEvent(event, previewOnly) {
        if (this._length <= 0)
            return;
        const [x] = event.get_coords();
        const [wx] = this._progress.get_transformed_position();
        const width = this._progress.get_transformed_size()[0] || this._progress.width;
        const frac = clamp((x - wx) / width, 0, 1);
        const target = Math.round(frac * this._length);
        this._position = target;
        this._updateProgress();
        if (previewOnly)
            return;
        const trackId = metaValue(this._metadata, 'mpris:trackid', null);
        try {
            if (trackId)
                this._player?.SetPositionRemote(trackId, target);
        } catch (e) {
            console.error(`[sidepanel] seek: ${e}`);
        }
    }

    _cycleLoop() {
        const player = this._player;
        if (!player)
            return;
        const order = ['None', 'Playlist', 'Track'];
        try {
            const current = player.LoopStatus ?? 'None';
            player.LoopStatus = order[(order.indexOf(current) + 1) % order.length];
        } catch (e) {
            console.error(`[sidepanel] LoopStatus : ${e}`);
        }
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._fetchPosition();
        this._updateMarquee();
        this._refreshOutputName();
        if (this._status === 'Playing')
            this._startTimers();
    }

    onClose() {
        this._marquee.stop();
        this._toggleDeviceChooser(false);
    }

    destroy() {
        this._destroyed = true;
        this._stopTimers();
        this._artCancel?.cancel();
        this._progress?.stopTimer();

        if (this._nameOwnerId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = 0;
        }
        for (const busName of [...this._players.keys()])
            this._removePlayer(busName);

        if (this._volSink && this._volSinkId) {
            try {
                this._volSink.disconnect(this._volSinkId);
            } catch (_e) {}
            this._volSink = null;
            this._volSinkId = 0;
        }
        if (this._mixer) {
            if (this._mixerStateId)
                this._mixer.disconnect(this._mixerStateId);
            if (this._mixerSinkId)
                this._mixer.disconnect(this._mixerSinkId);
            try {
                this._mixer.close();
            } catch (_e) {}
            this._mixer = null;
        }

        this._marquee?.destroy();
        this._session?.abort();
        this._session = null;
    }
}

export default {
    id: 'player',
    title: 'Lecteur',
    short: 'Lecteur',
    icon: 'audio-x-generic-symbolic',
    build(ctx) {
        return new PlayerCard(ctx);
    },
};
