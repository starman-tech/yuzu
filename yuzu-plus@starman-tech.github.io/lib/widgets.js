// SPDX-License-Identifier: GPL-3.0-or-later
/* lib/widgets.js — boutons du panneau.
 *
 * Les couleurs, contours et ombres dures viennent de stylesheet.css
 * (transitions natives de St entre pseudo-classes : fluide, sans timer, et
 * sans toucher à l'allocation). Seul le MOUVEMENT est joué ici, en Clutter,
 * et toujours sur l'icône plutôt que sur le bouton : un scale Clutter ne
 * change pas l'allocation, un bouton qui grandit déborderait sur ses
 * voisins.
 *
 * Courbes : EASE_OUT_QUINT pour tout ce qui « arrive » (doux, sans rebond),
 * EASE_OUT_BACK réservé aux accents (rotation du +, punaise), EASE_OUT_QUAD
 * pour les appuis (courts).
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {PALETTE} from './theme.js';
import {setVectorIcon, vectorIcon} from './vectorIcons.js';
import {scaleFactor} from './utils.js';

let ICON_REST = PALETTE.beigeDim;      // icône au repos
let ICON_LIT = PALETTE.beige;          // survol / focus
let ICON_ACTIVE = PALETTE.navyDeep;    // encre sur bloc orange

/** Recale les couleurs d'icônes sur le thème ; à appeler AVANT de
 * construire les boutons (le panneau le fait dans _build). */
export function setIconPalette(theme) {
    ICON_REST = theme?.iconRest ?? PALETTE.beigeDim;
    ICON_LIT = theme?.iconLit ?? PALETTE.beige;
    ICON_ACTIVE = theme?.iconActive ?? PALETTE.navyDeep;
}

const EASE_IN = Clutter.AnimationMode.EASE_OUT_CUBIC;
const EASE_PRESS = Clutter.AnimationMode.EASE_OUT_QUAD;
const EASE_ACCENT = Clutter.AnimationMode.EASE_OUT_BACK;

/* Décalage de l'ombre dure des boutons (stylesheet.css : 3px 3px 0). À
 * l'appui, le CSS :active supprime l'ombre et le bouton est translaté
 * d'autant : il « s'enfonce » dans son ombre. */
const PUSH_PX = 3;

/** Enfoncement néo-brutal : le BOUTON entier se déplace sur son ombre. */
function wirePush(button) {
    const s = scaleFactor();
    button.connect('button-press-event', () => {
        button.remove_all_transitions();
        button.translation_x = PUSH_PX * s;
        button.translation_y = PUSH_PX * s;
        return Clutter.EVENT_PROPAGATE;
    });
    const release = () => {
        button.remove_all_transitions();
        button.ease({translation_x: 0, translation_y: 0, duration: 120, mode: EASE_PRESS});
        return Clutter.EVENT_PROPAGATE;
    };
    button.connect('button-release-event', release);
    button.connect('leave-event', release);
}

/** Appui : l'icône s'enfonce, le bouton ne bouge pas. */
function wirePress(button, target, {pressScale = 0.86} = {}) {
    button.connect('button-press-event', () => {
        target.remove_all_transitions();
        target.ease({scale_x: pressScale, scale_y: pressScale, duration: 90, mode: EASE_PRESS});
        return Clutter.EVENT_PROPAGATE;
    });
    const release = () => {
        target.remove_all_transitions();
        target.ease({scale_x: 1, scale_y: 1, duration: 260, mode: EASE_ACCENT});
        return Clutter.EVENT_PROPAGATE;
    };
    button.connect('button-release-event', release);
    button.connect('leave-event', release);
}

/* ------------------------------------------------------ bouton générique */

/* --------------------------------------------- bouton vectoriel animé
 *
 * motion :
 *   'spin'        rotation 90° (croix « + » qui devient « × »)
 *   'tilt'        bascule de 20° (punaise)
 *   'nudge'       léger recul-avance (crayon)
 *   'nudge-up'    monte de 3 px (flèche haut)
 *   'nudge-down'  descend de 3 px (flèche bas)
 *   'pop'         échelle simple (défaut)
 */
export function makeVectorButton({
    icon, color = ICON_REST, litColor = ICON_LIT, activeColor = ICON_ACTIVE,
    size = 30, iconSize = 16, motion = 'pop', tooltip = null, onClick = () => {},
}) {
    const s = scaleFactor();
    const button = new St.Button({
        style_class: 'sp-vec-btn',
        width: size * s,
        height: size * s,
        can_focus: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const iconActor = vectorIcon(icon, color, iconSize);
    iconActor.set_pivot_point(0.5, 0.5);
    button.set_child(iconActor);
    if (tooltip)
        button.set_accessible_name(tooltip);

    button._spIcon = iconActor;
    button._spName = icon;
    button._spActive = false;

    const paint = () => {
        const lit = button.hover || button.has_key_focus();
        setVectorIcon(iconActor, button._spName,
            button._spActive ? activeColor : lit ? litColor : color);
    };

    const rest = () => {
        iconActor.remove_all_transitions();
        iconActor.ease({
            rotation_angle_z: button._spActive && motion === 'spin' ? 45 : 0,
            scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
            duration: 280, mode: EASE_IN,
        });
    };

    const enter = () => {
        iconActor.remove_all_transitions();
        const params = {duration: 300, mode: EASE_ACCENT};
        switch (motion) {
        case 'spin':
            Object.assign(params, {rotation_angle_z: 90});
            break;
        case 'tilt':
            Object.assign(params, {rotation_angle_z: -20, scale_x: 1.08, scale_y: 1.08});
            break;
        case 'nudge':
            Object.assign(params, {translation_x: 2, scale_x: 1.08, scale_y: 1.08});
            break;
        case 'nudge-up':
            Object.assign(params, {translation_y: -3 * s, scale_x: 1.1, scale_y: 1.1});
            break;
        case 'nudge-down':
            Object.assign(params, {translation_y: 3 * s, scale_x: 1.1, scale_y: 1.1});
            break;
        default:
            Object.assign(params, {scale_x: 1.14, scale_y: 1.14});
        }
        iconActor.ease(params);
    };

    button.connect('notify::hover', () => {
        paint();
        if (button.hover)
            enter();
        else
            rest();
    });
    button.connect('key-focus-in', paint);
    button.connect('key-focus-out', paint);
    wirePress(button, iconActor);
    button.connect('clicked', () => onClick(button));

    button.spSetActive = active => {
        button._spActive = active;
        if (active)
            button.add_style_class_name('sp-vec-on');
        else
            button.remove_style_class_name('sp-vec-on');
        paint();
        if (!button.hover)
            rest();
    };
    button.spSetColors = (base, active) => {
        color = base;
        activeColor = active ?? base;
        paint();
    };
    button.spSetTheme = () => {};
    return button;
}

/* -------------------------------------------------------------- pastilles */

/** Pastille de texte. variant : 'ghost' (défaut) | 'accent' | 'danger'. */
export function makePill(text, _theme, onClick = null, {variant = 'ghost'} = {}) {
    const styleClass = variant === 'accent' ? 'sp-pill-accent'
        : variant === 'danger' ? 'sp-pill-danger' : 'sp-pill';
    if (!onClick)
        return new St.Label({text, style_class: styleClass});
    const pill = new St.Button({label: text, style_class: styleClass, can_focus: true});
    wirePush(pill);
    pill.connect('clicked', () => onClick(pill));
    pill.spSetTheme = () => {};
    return pill;
}

/** Ligne de liste pleine largeur (sélecteur d'import). */
export function makeRow(text, onClick, {mono = false} = {}) {
    const row = new St.Button({
        label: text,
        style_class: 'sp-row',
        can_focus: true,
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
    });
    if (!mono)
        row.get_child()?.set_style?.('letter-spacing: 0.5px;');
    wirePush(row);
    row.connect('clicked', () => onClick(row));
    return row;
}

/* ------------------------------------------------------------- entrées */

/** Apparition en cascade : glisse depuis la droite en s'éclaircissant. */
export function popIn(actor, delay = 0, {distance = 16, duration = 420} = {}) {
    const s = scaleFactor();
    actor.remove_all_transitions();
    actor.opacity = 0;
    actor.translation_x = distance * s;
    actor.ease({
        opacity: 255,
        translation_x: 0,
        delay,
        duration,
        mode: EASE_IN,
    });
}

/** Apparition verticale (volets, sélecteur) : descend en s'éclaircissant. */
export function slideIn(actor, {distance = 8, duration = 360, delay = 0} = {}) {
    const s = scaleFactor();
    actor.remove_all_transitions();
    actor.show();
    actor.opacity = 0;
    actor.translation_y = -distance * s;
    actor.ease({opacity: 255, translation_y: 0, delay, duration, mode: EASE_IN});
}

/** Disparition verticale, puis hide(). */
export function slideOut(actor, {distance = 8, duration = 200, onComplete = null} = {}) {
    const s = scaleFactor();
    actor.remove_all_transitions();
    actor.ease({
        opacity: 0, translation_y: -distance * s, duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
            actor.hide();
            actor.translation_y = 0;
            onComplete?.();
        },
    });
}

/* ═══════════════════════════════════════════════════════════════════════
 * BOUTONS DE L'EN-TÊTE
 * ═══════════════════════════════════════════════════════════════════════ */

/** Bouton « + » : cercle bordé de 24 px, croix qui pivote à 90° au survol. */
export function makeAddButton({size = 24, iconSize = 14, tooltip, onClick}) {
    /* width/height sont des propriétés d'acteur : GNOME ne les met PAS à
     * l'échelle, contrairement aux px du CSS. */
    const s = scaleFactor();
    const button = new St.Button({
        style_class: 'sp-hdr-add',
        width: size * s,
        height: size * s,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const icon = vectorIcon('hdr-add', ICON_REST, iconSize);
    icon.set_pivot_point(0.5, 0.5);
    button.set_child(icon);
    if (tooltip)
        button.set_accessible_name(tooltip);

    button._spIcon = icon;
    button._spForceOpen = false;

    const render = () => {
        const open = button._spForceOpen;
        const lit = button.hover || open;
        setVectorIcon(icon, 'hdr-add', open ? ICON_ACTIVE : lit ? ICON_LIT : ICON_REST);
        icon.remove_all_transitions();
        icon.ease({
            rotation_angle_z: open ? 45 : lit ? 90 : 0,
            duration: 340,
            mode: EASE_ACCENT,
        });
    };

    button.connect('notify::hover', render);
    wirePush(button);
    button.connect('clicked', () => onClick(button));
    button.spSetOpen = open => {
        button._spForceOpen = open;
        if (open)
            button.add_style_class_name('sp-open');
        else
            button.remove_style_class_name('sp-open');
        render();
    };
    return button;
}

/** Bouton d'action carré de 32 px : tasse, éditer, épingler, réglages. */
export function makeActionButton({icon, tooltip, onClick, size = 32}) {
    const s = scaleFactor();
    const button = new St.Button({
        style_class: 'sp-hdr-act',
        width: size * s,
        height: size * s,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const iconActor = vectorIcon(icon, ICON_REST, 16);
    iconActor.set_pivot_point(0.5, 0.5);
    button.set_child(iconActor);
    if (tooltip)
        button.set_accessible_name(tooltip);
    button.set_pivot_point(0.5, 0.5);

    button._spIcon = iconActor;
    button._spName = icon;
    button._spActive = false;

    const render = () => {
        const active = button._spActive;
        const color = active ? ICON_ACTIVE : button.hover ? ICON_LIT : ICON_REST;
        /* la punaise épinglée s'épaissit (second tracé) et bascule */
        const name = (active && icon === 'hdr-pin') ? 'hdr-pin-on' : icon;
        setVectorIcon(iconActor, name, color);
        iconActor.remove_all_transitions();
        iconActor.ease({
            rotation_angle_z: active && icon === 'hdr-pin' ? 15 : 0,
            scale_x: active ? 1.08 : button.hover ? 1.06 : 1,
            scale_y: active ? 1.08 : button.hover ? 1.06 : 1,
            duration: 260,
            mode: EASE_IN,
        });
    };

    button.connect('notify::hover', render);
    wirePush(button);
    wirePress(button, iconActor, {pressScale: 0.86});
    button.connect('clicked', () => onClick(button));

    /* bascule d'état : petit sursaut 1 → 1.12 → 1 sur l'icône */
    const bump = () => {
        iconActor.remove_all_transitions();
        iconActor.set_scale(1, 1);
        iconActor.ease({
            scale_x: 1.22, scale_y: 1.22,
            duration: 140, mode: EASE_PRESS,
            onComplete: render,
        });
    };

    button.spSetActive = (active, {animate = false} = {}) => {
        button._spActive = active;
        if (active)
            button.add_style_class_name('is-pinned');
        else
            button.remove_style_class_name('is-pinned');
        if (animate)
            bump();
        else
            render();
    };

    return button;
}
