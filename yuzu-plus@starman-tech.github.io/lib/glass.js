// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/glass.js — fond du panneau : aplat opaque + quadrillage + formes animées.
 *
 * Cinq familles de formes (réglables dans les préférences) :
 *   pixel     — blocs carrés qui dérivent par pas entiers, rendu NEAREST (défaut)
 *   liquid    — halos organiques qui dérivent
 *   orbs      — sphères nettes qui rebondissent
 *   waves     — bandes sinusoïdales superposées
 *   geometric — polygones en rotation
 *
 * Tout est peint sur une surface réduite puis étirée : le rééchantillonnage
 * divise le coût CPU par ~36. Pour « pixel », l'étirement se fait SANS
 * lissage (Cairo.Filter.NEAREST) : chaque pixel de la surface réduite
 * devient un carré net de DOWNSCALE px — c'est ce qui donne le grain pixel.
 *
 * applyBackdropBlur est conservé pour les thèmes qui le demanderaient
 * (blurSigma > 0) ; les thèmes brutal sont opaques et ne l'utilisent pas.
 */

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {SHAPES} from './theme.js';
import {roundedPath, scaleFactor, sourceRemove, timeoutAdd} from './utils.js';

const FRAME_MS = 50;      // 20 fps
const DOWNSCALE = 6;
const PIXEL_STEP_MS = 140;   // cadence des pas en mode pixel (mouvement saccadé voulu)

/** Applique (ou retire) le flou d'arrière-plan.
 *
 * ⚠️ Shell.BlurEffect en mode BACKGROUND est instable sur plusieurs pilotes
 * (NVIDIA sous X11 notamment) : il peut figer le shell. Désactivé par défaut,
 * activable explicitement dans les préférences, et sans effet si le thème a
 * blurSigma = 0. */
export function applyBackdropBlur(actor, theme, enabled) {
    actor.remove_effect_by_name('sp-blur');
    if (!enabled || !theme.blurSigma)
        return false;
    try {
        const effect = new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            brightness: theme.blurBrightness,
        });
        if ('sigma' in effect)
            effect.sigma = theme.blurSigma;
        else
            effect.radius = theme.blurSigma;
        actor.add_effect_with_name('sp-blur', effect);
        return true;
    } catch (e) {
        console.warn(`[yuzu] flou indisponible : ${e}`);
        return false;
    }
}

function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex || '').trim());
    if (!m)
        return null;
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/* Générateur pseudo-aléatoire déterministe : les blocs pixel gardent la
 * même disposition d'une image à l'autre. */
function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
}

export const LiquidBackground = GObject.registerClass(
class LiquidBackground extends St.DrawingArea {
    _init(theme, params = {}) {
        super._init({x_expand: true, y_expand: true, reactive: false});
        this._theme = theme;
        this._params = params;
        this._t = 0;
        this._timer = 0;
        this._blurAvailable = false;
        this._surface = null;
        this._pixelStep = 0;
        this._pixelAcc = 0;
        this.connect('repaint', area => this._paint(area));
        this.connect('destroy', () => this.stop());
    }

    setTheme(theme) {
        this._theme = theme;
        this._surface = null;
        this.queue_repaint();
    }

    /** {shape, speed, intensity, colors:[hex]} — vide = valeurs du thème */
    setParams(params) {
        this._params = params ?? {};
        this.queue_repaint();
    }

    setBlurAvailable(available) {
        this._blurAvailable = available;
        this.queue_repaint();
    }

    start() {
        if (this._timer)
            return;
        this._timer = timeoutAdd(FRAME_MS, () => {
            this._t += 0.024 * this._speed();
            /* en mode pixel, l'image n'avance que par pas : inutile de
             * repeindre entre deux pas */
            if (this._shape() === 'pixel') {
                this._pixelAcc += FRAME_MS * this._speed();
                if (this._pixelAcc < PIXEL_STEP_MS)
                    return GLib.SOURCE_CONTINUE;
                this._pixelAcc = 0;
                this._pixelStep++;
            }
            this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        this._timer = sourceRemove(this._timer);
    }

    /* --------------------------------------------------- paramètres */

    _speed() {
        const s = this._params.speed;
        return (s === undefined || s === null || s <= 0) ? (this._theme.speed ?? 1) : s;
    }

    _intensity() {
        const i = this._params.intensity;
        return (i === undefined || i === null || i < 0) ? (this._theme.blobAlpha ?? 0.5) : i;
    }

    _colors() {
        const custom = (this._params.colors ?? []).map(hexToRgb).filter(Boolean);
        return custom.length > 0 ? custom : (this._theme.blobs ?? [[0.4, 0.5, 0.9]]);
    }

    _shape() {
        const s = this._params.shape;
        return SHAPES.includes(s) ? s : 'pixel';
    }

    /* -------------------------------------------------------- rendu */

    _paint(area) {
        try {
            this._paintInner(area);
        } catch (e) {
            /* Une exception répétée dans un handler de repaint peut emporter le
             * shell : on arrête l'animation plutôt que de la relancer. */
            console.error(`[yuzu] rendu du fond interrompu : ${e}`);
            this.stop();
        }
    }

    _paintInner(area) {
        const [w, h] = area.get_surface_size();
        if (w <= 0 || h <= 0)
            return;
        const t = this._theme;
        const s = scaleFactor();
        const cr = area.get_context();

        /* Cairo peint en pixels de PÉRIPHÉRIQUE, alors que le border-radius
         * du CSS est mis à l'échelle par GNOME. */
        roundedPath(cr, 0, 0, w, h, t.radius * s);
        cr.clip();

        /* --- aplat de base : opaque, sauf si un flou est réellement actif --- */
        const [br, bg, bb] = t.base;
        cr.setSourceRGBA(br, bg, bb, this._blurAvailable && t.blurSigma ? 0.55 : 1);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        /* --- formes animées, peintes sur surface réduite --- */
        const shape = this._shape();
        const sw = Math.max(1, Math.ceil(w / DOWNSCALE));
        const sh = Math.max(1, Math.ceil(h / DOWNSCALE));
        if (!this._surface || this._surfaceW !== sw || this._surfaceH !== sh) {
            this._surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, sw, sh);
            this._surfaceW = sw;
            this._surfaceH = sh;
        }
        const scr = new Cairo.Context(this._surface);
        scr.setOperator(Cairo.Operator.CLEAR);
        scr.paint();
        scr.setOperator(Cairo.Operator.OVER);

        const colors = this._colors();
        const alpha = this._intensity();
        switch (shape) {
        case 'liquid':
            this._paintLiquid(scr, sw, sh, colors, alpha);
            break;
        case 'orbs':
            this._paintOrbs(scr, sw, sh, colors, alpha);
            break;
        case 'waves':
            this._paintWaves(scr, sw, sh, colors, alpha);
            break;
        case 'geometric':
            this._paintGeometric(scr, sw, sh, colors, alpha);
            break;
        default:
            this._paintPixel(scr, sw, sh, colors, alpha);
        }
        scr.$dispose();

        cr.save();
        cr.scale(w / sw, h / sh);
        cr.setSourceSurface(this._surface, 0, 0);
        cr.getSource().setFilter(shape === 'pixel' ? Cairo.Filter.NEAREST : Cairo.Filter.BILINEAR);
        cr.paint();
        cr.restore();

        /* --- quadrillage pixel : points tous les 12 px logiques --- */
        if (t.grid) {
            const step = 12 * s;
            const dot = Math.max(1, Math.round(s));
            cr.setSourceRGBA(1, 1, 1, 0.055);
            for (let y = step; y < h; y += step) {
                for (let x = step; x < w; x += step)
                    cr.rectangle(x, y, dot, dot);
            }
            cr.fill();
        }

        /* --- reflets « verre » (0 dans les thèmes brutal) --- */
        const gloss = t.gloss ?? 1;
        if (gloss > 0) {
            const g = new Cairo.LinearGradient(0, 0, 0, h * 0.55);
            g.addColorStopRGBA(0, 1, 1, 1, 0.16 * gloss);
            g.addColorStopRGBA(0.45, 1, 1, 1, 0.05 * gloss);
            g.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.setSource(g);
            cr.rectangle(0, 0, w, h * 0.55);
            cr.fill();
        }

        const grain = t.grain ?? 0;
        if (grain > 0) {
            const rnd = rng(991);
            cr.setSourceRGBA(1, 1, 1, 0.014 * grain);
            for (let i = 0; i < 120; i++) {
                cr.rectangle(rnd() * w, rnd() * h, 1.2, 1.2);
                cr.fill();
            }
        }

        cr.$dispose();
    }

    /* Blocs carrés (2 à 6 cellules) qui dérivent par pas entiers sur des
     * trajectoires sinusoïdales. Les positions sont arrondies à la cellule :
     * le mouvement est saccadé, comme un sprite. */
    _paintPixel(cr, w, h, colors, alpha) {
        const step = this._pixelStep;
        const rnd = rng(4242);
        const count = 14;
        for (let i = 0; i < count; i++) {
            const [r, g, b] = colors[i % colors.length];
            const size = 2 + Math.floor(rnd() * 5);
            const ox = rnd() * w;
            const oy = rnd() * h;
            const fx = 0.05 + rnd() * 0.08;
            const fy = 0.04 + rnd() * 0.07;
            const ax = w * (0.12 + rnd() * 0.25);
            const ay = h * (0.10 + rnd() * 0.22);
            const phase = rnd() * Math.PI * 2;

            const x = Math.floor(ox + Math.sin(step * fx + phase) * ax);
            const y = Math.floor(oy + Math.cos(step * fy + phase * 1.3) * ay);
            /* enroulement : un bloc qui sort revient de l'autre côté */
            const px = ((x % w) + w) % w;
            const py = ((y % h) + h) % h;

            const a = alpha * (0.55 + 0.45 * ((i * 7) % 10) / 10);
            cr.setSourceRGBA(r, g, b, a);
            cr.rectangle(px, py, size, size);
            cr.fill();
            /* ombre dure du bloc, décalée d'une cellule */
            cr.setSourceRGBA(0, 0, 0, a * 0.5);
            cr.rectangle(px + size, py + 1, 1, size);
            cr.rectangle(px + 1, py + size, size, 1);
            cr.fill();
        }
    }

    _paintLiquid(cr, w, h, colors, alpha) {
        for (let i = 0; i < colors.length; i++) {
            const [r, g, b] = colors[i];
            const phase = i * 1.7;
            const cx = w * (0.5 + 0.42 * Math.sin(this._t * (0.6 + i * 0.13) + phase));
            const cy = h * (0.5 + 0.40 * Math.cos(this._t * (0.45 + i * 0.11) + phase * 1.3));
            const radius = Math.max(w, h) * (0.42 + 0.12 * Math.sin(this._t * 0.5 + phase));
            const grad = new Cairo.RadialGradient(cx, cy, 0, cx, cy, radius);
            grad.addColorStopRGBA(0, r, g, b, alpha);
            grad.addColorStopRGBA(0.55, r, g, b, alpha * 0.35);
            grad.addColorStopRGBA(1, r, g, b, 0);
            cr.setSource(grad);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
    }

    _paintOrbs(cr, w, h, colors, alpha) {
        for (let i = 0; i < colors.length; i++) {
            const [r, g, b] = colors[i];
            const phase = i * 2.1;
            const cx = w * (0.5 + 0.36 * Math.sin(this._t * (0.9 + i * 0.2) + phase));
            const cy = h * (0.5 + 0.34 * Math.sin(this._t * (0.7 + i * 0.17) + phase * 1.7));
            const radius = Math.min(w, h) * (0.34 + 0.06 * Math.sin(this._t + phase));
            const grad = new Cairo.RadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
            grad.addColorStopRGBA(0, r, g, b, alpha * 1.15);
            grad.addColorStopRGBA(0.78, r, g, b, alpha * 0.75);
            grad.addColorStopRGBA(1, r, g, b, 0);
            cr.setSource(grad);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.fill();
        }
    }

    _paintWaves(cr, w, h, colors, alpha) {
        for (let i = 0; i < colors.length; i++) {
            const [r, g, b] = colors[i];
            const amplitude = h * 0.10;
            const base = h * (0.22 + i * (0.62 / Math.max(1, colors.length)));
            const grad = new Cairo.LinearGradient(0, base - amplitude, 0, h);
            grad.addColorStopRGBA(0, r, g, b, alpha * 0.95);
            grad.addColorStopRGBA(1, r, g, b, alpha * 0.15);
            cr.setSource(grad);
            cr.moveTo(0, h);
            for (let x = 0; x <= w; x += 2) {
                const y = base
                    + Math.sin(x * 0.055 + this._t * (1.1 + i * 0.25)) * amplitude
                    + Math.sin(x * 0.017 - this._t * 0.7) * amplitude * 0.45;
                cr.lineTo(x, y);
            }
            cr.lineTo(w, h);
            cr.closePath();
            cr.fill();
        }
    }

    _paintGeometric(cr, w, h, colors, alpha) {
        const cx = w / 2;
        const cy = h / 2;
        for (let i = 0; i < colors.length; i++) {
            const [r, g, b] = colors[i];
            const sides = 3 + (i % 4);
            const radius = Math.min(w, h) * (0.24 + i * 0.13);
            const rotation = this._t * (0.35 + i * 0.15) * (i % 2 ? -1 : 1);
            const drift = Math.sin(this._t * 0.5 + i) * w * 0.08;

            cr.newPath();
            for (let k = 0; k <= sides; k++) {
                const angle = rotation + (k / sides) * 2 * Math.PI;
                const x = cx + drift + Math.cos(angle) * radius;
                const y = cy + Math.sin(angle) * radius;
                if (k === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.closePath();

            const grad = new Cairo.LinearGradient(
                cx - radius, cy - radius, cx + radius, cy + radius);
            grad.addColorStopRGBA(0, r, g, b, alpha * 0.85);
            grad.addColorStopRGBA(1, r, g, b, alpha * 0.15);
            cr.setSource(grad);
            cr.fill();
        }
    }
});
