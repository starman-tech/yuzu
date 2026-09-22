// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/market.js — Ticker de marché & actualités, maquette « Apple
 * Liquid Glass ».
 *
 * Données réelles, aucune valeur inventée :
 *   • Les quatre actifs (BTC, ETH, SPY, S&P 500) — l'endpoint public que
 *     yfinance lui-même interroge en coulisses (query1.finance.yahoo.com,
 *     sans clé). yfinance est une bibliothèque Python : inutilisable telle
 *     quelle depuis une extension GJS, mais c'est exactement un habillage
 *     autour de cette API — s'y brancher directement donne les mêmes
 *     données, actions et cryptomonnaies unifiées sous un seul fournisseur,
 *     avec un vrai intraday (5 min) même pour les actions, ce que ni
 *     CoinGecko ni Stooq (les sources de la version précédente) ne
 *     permettaient ensemble.
 *   • Actualités — Google News en RSS, filtré par requête spécifique à
 *     l'actif sélectionné (« Bitcoin », « Ethereum », « S&P 500 »…),
 *     rechargé à chaque changement d'actif. Pas de clé requise ; en
 *     contrepartie le lien de chaque article passe par une redirection
 *     news.google.com plutôt que l'URL directe de l'éditeur — géré tel
 *     quel, ça reste cliquable.
 *
 * Écarts imposés par St par rapport au CSS de référence — mêmes limites que
 * les autres modules du projet, voir modules/tracker.js :
 *   • `backdrop-filter` n'existe pas → teinte de verre posée directement,
 *     le flou vient déjà du panneau.
 *   • `transition`/`@keyframes` → tout est animé en JS via Clutter.ease().
 *   • le graphique SVG de la maquette est reconstruit en Cairo, à partir
 *     des VRAIES séries de prix plutôt que des chemins figés du HTML.
 *
 * Mise à l'échelle : k pour la proportion du design (maquette à 380px),
 * s pour le HiDPI — voir SKILL.md du projet, section « deux facteurs
 * d'échelle ».
 */

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {fetchText, newSession, scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';
import {MODULE} from '../lib/theme.js';
import {vectorIcon} from '../lib/vectorIcons.js';

const DESIGN_WIDTH = 380;
const PRICE_REFRESH_S = 120;     // 2 min — large marge sous les limites gratuites
const NEWS_REFRESH_S = 300;      // les titres ne changent pas toutes les minutes
const NEWS_ROTATE_MS = 3500;

/* User-Agent obligatoire : Yahoo rejette les requêtes sans en-tête
 * navigateur reconnaissable. */
const YAHOO_HEADERS = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) sidepanel/2.0'};

/* hausse = lime (accent de la palette), baisse = corail */

const TIMEFRAMES = ['24H', '7D', '30D'];

/* range/interval du endpoint chart Yahoo par fenêtre. « range » n'accepte
 * qu'un jeu de valeurs énumérées (pas de "7d" ni "30d" bruts) : la fenêtre
 * « 7D » couvre donc 5 jours de bourse (~1 semaine calendaire côté
 * actions), et « 30D » un mois — approximations mineures, assumées. */
const YAHOO_TIMEFRAME = {
    '24H': {range: '1d', interval: '5m'},
    '7D': {range: '5d', interval: '1h'},
    '30D': {range: '1mo', interval: '1d'},
};

/* Yahoo Finance couvre actions ET cryptomonnaies sous la même API — une
 * simplification réelle par rapport à la version précédente (CoinGecko +
 * Stooq combinés). newsQuery alimente la recherche Google News filtrée par
 * actif. */
const ASSETS = {
    BTC: {name: 'Bitcoin', symbol: 'BTC-USD', newsQuery: 'Bitcoin'},
    ETH: {name: 'Ethereum', symbol: 'ETH-USD', newsQuery: 'Ethereum'},
    SOL: {name: 'Solana', symbol: 'SOL-USD', newsQuery: 'Solana crypto'},
    SPY: {name: 'SPY', symbol: 'SPY', newsQuery: 'SPY ETF'},
    SNP: {name: 'S&P 500', symbol: '^GSPC', newsQuery: 'S&P 500'},
    NVDA: {name: 'Nvidia', symbol: 'NVDA', newsQuery: 'Nvidia action'},
    AAPL: {name: 'Apple', symbol: 'AAPL', newsQuery: 'Apple action bourse'},
    GOLD: {name: 'Or', symbol: 'GC=F', newsQuery: 'cours de l\'or'},
    EUR: {name: 'EUR / USD', symbol: 'EURUSD=X', newsQuery: 'euro dollar'},
};
const ASSET_ORDER = ['BTC', 'ETH', 'SOL', 'SPY', 'SNP', 'NVDA', 'AAPL', 'GOLD', 'EUR'];

function fmtUsd(value) {
    if (value === null || value === undefined || Number.isNaN(value))
        return '—';
    const abs = Math.abs(value);
    const digits = abs >= 1 ? 2 : 4;
    return value.toLocaleString('en-US', {
        style: 'currency', currency: 'USD',
        minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
}

function fmtSigned(value) {
    if (value === null || value === undefined || Number.isNaN(value))
        return '—';
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${fmtUsd(Math.abs(value))}`;
}

function fmtPct(value) {
    if (value === null || value === undefined || Number.isNaN(value))
        return '—';
    const arrow = value >= 0 ? '▲' : '▼';
    return `${arrow} ${Math.abs(value).toFixed(2)}%`;
}

/* ---------------------------------------------------------- graphique */

/* Courbe lissée par spline de Catmull-Rom convertie en Bézier cubique —
 * un choix standard pour tracer une ligne douce à travers des points de
 * données réels, contrairement aux chemins SVG figés de la maquette. */
function smoothPath(cr, points) {
    if (points.length < 2) {
        if (points.length === 1)
            cr.moveTo(points[0][0], points[0][1]);
        return;
    }
    const p = points;
    cr.moveTo(p[0][0], p[0][1]);
    for (let i = 0; i < p.length - 1; i++) {
        const p0 = p[Math.max(0, i - 1)];
        const p1 = p[i];
        const p2 = p[i + 1];
        const p3 = p[Math.min(p.length - 1, i + 2)];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6;
        const c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6;
        const c2y = p2[1] - (p3[1] - p1[1]) / 6;
        cr.curveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    }
}

const MarketChart = GObject.registerClass(
class MarketChart extends St.DrawingArea {
    _init(height) {
        super._init({x_expand: true, height, reactive: false});
        this._series = [];      // valeurs brutes (prix), ordre chronologique
        this._colorHex = MODULE.positive;
        this.connect('repaint', area => this._paint(area));
    }

    setSeries(series) {
        this._series = series ?? [];
        this.queue_repaint();
    }

    setColor(hex) {
        this._colorHex = hex;
        this.queue_repaint();
    }

    _paint(area) {
        const [w, h] = area.get_surface_size();
        if (w <= 0 || h <= 0 || this._series.length < 2)
            return;
        const cr = area.get_context();

        const min = Math.min(...this._series);
        const max = Math.max(...this._series);
        const span = Math.max(max - min, max * 0.0005, 1e-9);
        const n = this._series.length;

        const points = this._series.map((v, i) => [
            (i / (n - 1)) * w,
            h - ((v - min) / span) * h * 0.86 - h * 0.07,
        ]);

        const r = parseInt(this._colorHex.slice(1, 3), 16) / 255;
        const g = parseInt(this._colorHex.slice(3, 5), 16) / 255;
        const b = parseInt(this._colorHex.slice(5, 7), 16) / 255;

        /* zone dégradée sous la courbe */
        cr.save();
        smoothPath(cr, points);
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();
        const grad = new Cairo.LinearGradient(0, 0, 0, h);
        grad.addColorStopRGBA(0, r, g, b, 0.40);
        grad.addColorStopRGBA(1, r, g, b, 0.0);
        cr.setSource(grad);
        cr.fill();
        cr.restore();

        /* ligne */
        smoothPath(cr, points);
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(Math.max(1.5, h * 0.035));
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.stroke();

        cr.$dispose();
    }
});

/* -------------------------------------------------------------- module */

class MarketCard {
    constructor(ctx) {
        this._settings = ctx.settings;
        /* largeur distribuée par le panneau : lui seul connaît la place
         * réellement disponible (padding + barre de défilement) */
        this._moduleWidth = ctx.moduleWidth;
        this._token = 'BTC';
        this._timeframe = '24H';
        this._cache = {};            // cache[token][timeframe] = {price,changePct,changeAbs,series}
        this._newsCache = {};        // newsCache[token] = [{title,link,time}, …]
        this._newsItems = [];        // items actuellement affichés (= newsCache[token])
        this._newsIndex = 0;
        this._newsGen = 0;           // annule les réponses d'actualités obsolètes
        this._expanded = false;
        this._dropdownOpen = false;
        this._destroyed = false;
        this._priceTimer = 0;
        this._newsTimer = 0;
        this._rotateTimer = 0;
        this._session = newSession();
        this._fetchGen = 0;           // annule les réponses tardives obsolètes

        this._build();
        this._refreshPrice(true);
        this._refreshNews(true);
    }

    /* ------------------------------------------------------------- UI */

    _build() {
        const s = scaleFactor();
        const logicalWidth = this._moduleWidth
            ?? this._settings.get_int('player-width');
        const k = logicalWidth / DESIGN_WIDTH;
        const px = v => Math.max(1, Math.round(v * k));
        const jsx = v => Math.max(1, Math.round(v * k * s));
        this._px = px;
        this._jsx = jsx;

        /* Racine en BinLayout : le volet déroulant se superpose au contenu
         * plutôt que de pousser le reste de la carte vers le bas — même
         * mécanisme que le sélecteur de sortie audio du lecteur. */
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });

        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
            style: `background-color: ${MODULE.surface}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(22)}px; `
                + `spacing: ${px(16)}px; `
                + `color: ${MODULE.text};`,
        });
        this.actor.add_child(content);

        /* ---- en-tête + sélecteur d'actif ---- */
        const header = new St.BoxLayout({x_expand: true});
        this._assetLabel = new St.Label({
            text: ASSETS[this._token].name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(14)}px; color: ${MODULE.textMuted};`,
        });

        this._dropdownBtn = new St.Button({
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${MODULE.inset}; `
                + `border: 2px solid ${MODULE.stroke}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(6)}px ${px(14)}px;`,
        });
        const dropdownBox = new St.BoxLayout({style: `spacing: ${px(8)}px;`});
        this._tokenLabel = new St.Label({
            text: this._token,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(13)}px; font-weight: bold; color: ${MODULE.text};`,
        });
        this._arrow = new St.Label({
            text: '▾',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(10)}px; color: ${MODULE.textMuted};`,
        });
        this._arrow.set_pivot_point(0.5, 0.5);
        dropdownBox.add_child(this._tokenLabel);
        dropdownBox.add_child(this._arrow);
        this._dropdownBtn.set_child(dropdownBox);
        this._dropdownBtn.connect('clicked', () => this._toggleDropdown());

        this._refreshBtn = new St.Button({
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(4)}px; margin-right: ${px(6)}px;`,
        });
        this._refreshIcon = vectorIcon('ui-refresh', MODULE.textDim, px(14));
        this._refreshIcon.set_pivot_point(0.5, 0.5);
        this._refreshBtn.set_child(this._refreshIcon);
        this._refreshBtn.set_accessible_name('Actualiser');
        this._refreshBtn.connect('clicked', () => {
            this._refreshIcon.remove_all_transitions();
            this._refreshIcon.rotation_angle_z = 0;
            this._refreshIcon.ease({rotation_angle_z: 360, duration: 600,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO});
            this._refreshPrice(true);
            this._refreshNews(true);
        });

        header.add_child(this._assetLabel);
        header.add_child(this._refreshBtn);
        header.add_child(this._dropdownBtn);
        content.add_child(header);

        /* ---- prix + variation ---- */
        const priceSection = new St.BoxLayout({
            vertical: true, x_expand: true, style: `spacing: ${px(4)}px;`,
        });
        this._priceLabel = new St.Label({
            text: '—',
            style: `font-size: ${px(34)}px; font-weight: bold; `
                + `letter-spacing: -1px; color: ${MODULE.text};`,
        });
        const variationRow = new St.BoxLayout({style: `spacing: ${px(8)}px;`});
        this._badgeAbs = this._makeBadge(px);
        this._badgePct = this._makeBadge(px);
        variationRow.add_child(this._badgeAbs);
        variationRow.add_child(this._badgePct);
        priceSection.add_child(this._priceLabel);
        priceSection.add_child(variationRow);
        content.add_child(priceSection);

        /* ---- graphique ---- */
        this._chart = new MarketChart(jsx(70));
        content.add_child(this._chart);

        /* ---- onglets de temps ---- */
        const tabs = new St.BoxLayout({
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${px(16)}px; padding-top: ${px(4)}px;`,
        });
        this._tabButtons = {};
        for (const tf of TIMEFRAMES) {
            const btn = new St.Button({
                label: tf,
                can_focus: true,
                style: `font-size: ${px(12)}px; font-weight: bold; `
                    + `color: ${MODULE.textMuted}; padding: ${px(4)}px ${px(10)}px; `
                    + `border-radius: ${px(3)}px; background: none; border: none;`,
            });
            btn.connect('clicked', () => this._selectTimeframe(tf));
            this._tabButtons[tf] = btn;
            tabs.add_child(btn);
        }
        content.add_child(tabs);

        /* ---- synthèse : variation 24 h de chaque actif, cliquable ---- */
        this._strip = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: `spacing: ${px(4)}px;`,
        });
        content.add_child(this._strip);
        this._stripChips = {};
        let stripRow = null;
        ASSET_ORDER.forEach((key, index) => {
            if (index % 5 === 0) {
                stripRow = new St.BoxLayout({x_expand: true, style: `spacing: ${px(4)}px;`});
                this._strip.add_child(stripRow);
            }
            const chip = new St.Button({
                label: key,
                can_focus: true,
                x_expand: true,
                style: `font-size: ${px(10)}px; font-weight: bold; color: ${MODULE.textMuted}; `
                    + `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                    + `border-radius: ${px(3)}px; padding: ${px(2)}px ${px(6)}px;`,
            });
            chip.set_accessible_name(`Afficher ${ASSETS[key].name}`);
            chip.connect('clicked', () => this._selectToken(key));
            stripRow.add_child(chip);
            this._stripChips[key] = chip;
        });

        /* ---- actualités ---- */
        const newsModule = new St.BoxLayout({
            vertical: true, x_expand: true,
            style: `background-color: ${MODULE.inset}; `
                + `border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(12)}px ${px(16)}px; `
                + `spacing: ${px(8)}px;`,
        });
        const newsHeader = new St.BoxLayout({x_expand: true});
        newsHeader.add_child(new St.Label({
            text: 'ACTUALITÉS EN DIRECT',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(11)}px; font-weight: bold; `
                + `letter-spacing: 0.5px; color: ${MODULE.textMuted};`,
        }));
        this._expandBtn = new St.Button({
            label: 'Tout afficher',
            can_focus: true,
            style: `background: none; border: none; `
                + `color: ${MODULE.accent}; font-size: ${px(11)}px; font-weight: bold;`,
        });
        this._expandBtn.connect('clicked', () => this._toggleExpanded());
        newsHeader.add_child(this._expandBtn);
        newsModule.add_child(newsHeader);

        this._tickerViewport = new St.Widget({
            clip_to_allocation: true,
            x_expand: true,
            height: jsx(24),
            layout_manager: new Clutter.BinLayout(),
        });
        this._tickerTrack = new St.BoxLayout({
            vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._tickerViewport.add_child(this._tickerTrack);
        newsModule.add_child(this._tickerViewport);

        this._newsList = new St.BoxLayout({
            vertical: true, x_expand: true, style: `spacing: ${px(2)}px;`,
        });
        this._newsScroll = new St.ScrollView({
            x_expand: true,
            height: jsx(140),
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._newsScroll.set_child(this._newsList);
        this._newsScroll.hide();
        newsModule.add_child(this._newsScroll);

        content.add_child(newsModule);

        /* ---- volet déroulant du sélecteur d'actif ---- */
        this._buildDropdownMenu(px, jsx);

        this._applyTrendColors();
    }

    _makeBadge(px) {
        return new St.Label({
            text: '—',
            style: `background-color: ${MODULE.inset}; color: ${MODULE.textMuted}; `
                + `padding: ${px(2)}px ${px(8)}px; border-radius: ${px(3)}px; `
                + `font-size: ${px(12)}px; font-weight: bold;`,
        });
    }

    _buildDropdownMenu(px, jsx) {
        /* La superposition (le volet doit flotter au-dessus du contenu
         * plutôt que le repousser) reste gérée par le BinLayout racine.
         * Mais l'ALIGNEMENT à droite, lui, ne passe plus par x_align sur
         * un enfant de BinLayout — signalé comme non respecté en pratique.
         * À la place : une ligne horizontale classique avec un espaceur
         * extensible à gauche, qui repousse le menu contre le bord droit
         * par construction — le même principe que la barre de progression
         * alignée à gauche via BoxLayout plutôt que via une propriété
         * d'alignement qu'on espère voir suivie. */
        this._menuWrap = new St.BoxLayout({
            vertical: true,
            visible: false,
            x_expand: true, y_expand: false,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START,
        });
        this._menuWrap.add_child(new St.Widget({height: jsx(38)}));   // sous le bouton

        const menuRow = new St.BoxLayout({x_expand: true});
        menuRow.add_child(new St.Widget({x_expand: true}));           // repousse à droite

        this._menu = new St.BoxLayout({
            vertical: true,
            style: `width: ${px(150)}px; `
                + `background-color: ${MODULE.surfaceStrong}; `
                + `border: 2px solid ${MODULE.stroke}; `
                + `border-radius: ${px(MODULE.radius)}px; `
                + `padding: ${px(6)}px; spacing: ${px(2)}px;`,
        });
        this._menuItems = {};
        for (const key of ASSET_ORDER) {
            const item = new St.Button({
                label: ASSETS[key].name,
                x_expand: true,
                can_focus: true,
                style: `padding: ${px(8)}px ${px(12)}px; font-size: ${px(13)}px; `
                    + `color: ${MODULE.textMuted}; border-radius: ${px(3)}px; background: none; border: none;`,
            });
            item.connect('clicked', () => this._selectToken(key));
            this._menuItems[key] = item;
            this._menu.add_child(item);
        }
        menuRow.add_child(this._menu);
        this._menuWrap.add_child(menuRow);
        this.actor.add_child(this._menuWrap);
        this._updateMenuActiveState();
    }

    setTheme(_theme) {}   // maquette figée, indépendante du thème du panneau

    /* -------------------------------------------------- interactions */

    _toggleDropdown() {
        this._dropdownOpen = !this._dropdownOpen;
        this._arrow.remove_all_transitions();
        this._arrow.ease({
            rotation_angle_z: this._dropdownOpen ? 180 : 0,
            duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._menu.remove_all_transitions();
        if (this._dropdownOpen) {
            this._menuWrap.show();
            this._menu.opacity = 0;
            this._menu.translation_y = -this._jsx(8);
            this._menu.ease({
                opacity: 255, translation_y: 0,
                duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            });
        } else {
            this._menu.ease({
                opacity: 0, translation_y: -this._jsx(8),
                duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._menuWrap.hide(),
            });
        }
    }

    _selectToken(key) {
        this._token = key;
        this._tokenLabel.text = key;
        this._assetLabel.text = ASSETS[key].name;
        this._updateMenuActiveState();
        if (this._dropdownOpen)
            this._toggleDropdown();
        this._render();
        this._ensureData();
        this._refreshNews(false);   // les actualités sont filtrées par actif
    }

    _updateMenuActiveState() {
        const px = this._px;
        for (const [key, item] of Object.entries(this._menuItems)) {
            const active = key === this._token;
            item.set_style(
                `padding: ${px(8)}px ${px(12)}px; font-size: ${px(13)}px; `
                + `border-radius: ${px(3)}px; background: none; border: none; `
                + (active
                    ? `color: ${MODULE.accentInk}; font-weight: bold; background-color: ${MODULE.accent};`
                    : `color: ${MODULE.textMuted};`));
        }
    }

    _selectTimeframe(tf) {
        this._timeframe = tf;
        this._render();
        this._ensureData();
    }

    _toggleExpanded() {
        this._expanded = !this._expanded;
        this._expandBtn.label = this._expanded ? 'Réduire' : 'Tout afficher';
        this._tickerViewport.visible = !this._expanded;
        this._newsScroll.visible = this._expanded;
        if (this._expanded)
            this._stopRotation();
        else
            this._startRotation();
    }

    /* -------------------------------------------------------- rendu */

    _render() {
        if (this._destroyed)
            return;
        const entry = this._cache[this._token]?.[this._timeframe];

        for (const [tf, btn] of Object.entries(this._tabButtons)) {
            const active = tf === this._timeframe;
            btn.set_style(
                `font-size: ${this._px(12)}px; font-weight: bold; `
                + `padding: ${this._px(4)}px ${this._px(10)}px; `
                + `border-radius: ${this._px(3)}px; border: none; `
                + (active
                    ? `background-color: ${MODULE.accent}; color: ${MODULE.accentInk};`
                    : `background: none; color: ${MODULE.textMuted};`));
        }

        if (!entry) {
            this._priceLabel.text = this._loading ? '…' : '—';
            this._badgeAbs.text = '—';
            this._badgePct.text = '—';
            this._chart.setSeries([]);
            return;
        }

        this._priceLabel.text = fmtUsd(entry.price);
        this._badgeAbs.text = fmtSigned(entry.changeAbs);
        this._badgePct.text = fmtPct(entry.changePct);
        this._chart.setSeries(entry.series);
        this._applyTrendColors(entry.changePct >= 0);
        this._renderStrip();
    }

    _renderStrip() {
        if (this._destroyed || !this._stripChips)
            return;
        const px = this._px;
        for (const key of ASSET_ORDER) {
            const chip = this._stripChips[key];
            const e = this._cache[key]?.['24H'];
            const active = key === this._token;
            const pct = e ? e.changePct : null;
            chip.label = pct === null ? key : `${key} ${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(1)}%`;
            const color = pct === null ? MODULE.textMuted : pct >= 0 ? MODULE.positive : MODULE.negative;
            chip.set_style(`font-size: ${px(10)}px; font-weight: bold; `
                + `color: ${active ? MODULE.accentInk : color}; `
                + `background-color: ${active ? MODULE.accent : MODULE.inset}; `
                + `border: 2px solid ${active ? MODULE.stroke : MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(2)}px ${px(6)}px;`);
        }
    }

    /** Charge, une par une et espacées, les variations 24 h de tous les
     * actifs pour la synthèse. */
    _preloadStrip() {
        const missing = ASSET_ORDER.filter(k => !this._cache[k]?.['24H']);
        missing.forEach((key, i) => {
            timeoutAdd(200 + i * 350, () => {
                if (!this._destroyed)
                    this._preload(key, '24H');
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _applyTrendColors(positive = true) {
        const px = this._px;
        const color = positive ? MODULE.positive : MODULE.negative;
        const bg = positive ? MODULE.positiveBg : MODULE.negativeBg;
        const badgeStyle = `padding: ${px(2)}px ${px(8)}px; border-radius: ${px(3)}px; `
            + `font-size: ${px(12)}px; font-weight: bold; `
            + `background-color: ${bg}; color: ${color};`;
        this._badgeAbs?.set_style(badgeStyle);
        this._badgePct?.set_style(badgeStyle);
        this._chart?.setColor(color);
    }

    /* --------------------------------------------------------- données */

    _ensureData() {
        if (!this._cache[this._token]?.[this._timeframe])
            this._refreshPrice(false);
    }

    async _refreshPrice(force) {
        if (this._destroyed)
            return;
        const gen = ++this._fetchGen;
        const token = this._token;
        const timeframe = this._timeframe;
        const asset = ASSETS[token];
        this._loading = true;
        if (!this._cache[token]?.[timeframe])
            this._render();

        try {
            const entry = await this._fetchYahoo(asset, timeframe);
            if (gen !== this._fetchGen || this._destroyed)
                return;
            this._cache[token] ??= {};
            this._cache[token][timeframe] = entry;
        } catch (e) {
            if (!this._destroyed)   // annulée par destroy() : rien à signaler
                console.warn(`[sidepanel] market ${token}/${timeframe} : ${e}`);
        } finally {
            this._loading = false;
            if (gen === this._fetchGen && !this._destroyed)
                this._render();
        }

        if (force) {
            /* précharge silencieusement les deux autres fenêtres pour un
             * changement d'onglet instantané */
            for (const tf of TIMEFRAMES) {
                if (tf !== timeframe)
                    this._preload(token, tf);
            }
        }
    }

    async _preload(token, timeframe) {
        if (this._cache[token]?.[timeframe])
            return;
        try {
            const asset = ASSETS[token];
            const entry = await this._fetchYahoo(asset, timeframe);
            if (this._destroyed)
                return;
            this._cache[token] ??= {};
            this._cache[token][timeframe] = entry;
            if (token === this._token && timeframe === this._timeframe)
                this._render();
            else if (timeframe === '24H')
                this._renderStrip();
        } catch (_e) {
            /* préchargement silencieux : un échec n'est pas grave, le
             * changement d'onglet redemandera la donnée */
        }
    }

    /** Endpoint chart public de Yahoo Finance — celui que yfinance
     * interroge en coulisses. Couvre actions et cryptomonnaies sous la
     * même API, avec un vrai intraday (5 min) pour les deux. */
    async _fetchYahoo(asset, timeframe) {
        const {range, interval} = YAHOO_TIMEFRAME[timeframe];
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${asset.symbol}`
            + `?range=${range}&interval=${interval}`;
        const data = JSON.parse(await fetchText(this._session, url, null, YAHOO_HEADERS));

        const result = data?.chart?.result?.[0];
        if (!result)
            throw new Error(`réponse Yahoo vide pour ${asset.symbol}`);

        const closes = (result.indicators?.quote?.[0]?.close ?? [])
            .filter(v => v !== null && v !== undefined && !Number.isNaN(v));
        if (closes.length < 2)
            throw new Error(`historique insuffisant pour ${asset.symbol}`);

        const price = result.meta?.regularMarketPrice ?? closes[closes.length - 1];
        const past = closes[0];
        const changePct = ((price - past) / past) * 100;
        const changeAbs = price - past;

        return {price, changePct, changeAbs, series: closes};
    }

    /* ------------------------------------------------------- actualités */

    /** Google News, filtré par la requête propre à l'actif sélectionné.
     * force=true recharge même si un cache existe déjà (bouton actualiser,
     * ouverture du panneau) ; sinon un cache existant est simplement
     * réaffiché sans nouvelle requête. */
    async _refreshNews(force) {
        if (this._destroyed)
            return;
        const token = this._token;

        if (!force && this._newsCache[token]) {
            this._newsItems = this._newsCache[token];
            this._buildTicker();
            return;
        }

        const gen = ++this._newsGen;
        const query = encodeURIComponent(ASSETS[token].newsQuery);
        const url = `https://news.google.com/rss/search?q=${query}`
            + `&hl=fr-FR&gl=FR&ceid=FR:fr`;

        /* évite de laisser affichés les titres de l'actif précédent le
         * temps que la requête aboutisse */
        this._newsItems = [];
        this._showNewsLoading();

        try {
            const xml = await fetchText(this._session, url);
            if (gen !== this._newsGen || this._destroyed)
                return;   // l'actif a changé pendant la requête
            const items = this._parseRss(xml).slice(0, 6);
            if (items.length > 0) {
                this._newsCache[token] = items;
                if (token === this._token) {
                    this._newsItems = items;
                    this._buildTicker();
                }
            }
        } catch (e) {
            /* carte détruite : la requête a été annulée, rien à afficher */
            if (this._destroyed)
                return;
            console.warn(`[sidepanel] actualités indisponibles (${token}) : ${e}`);
            if (gen === this._newsGen && !this._newsCache[token])
                this._showNewsError();
        }
    }

    /* Extraction légère, défensive : un flux RSS mal formé ne doit jamais
     * faire planter le module, seulement afficher moins de titres. */
    _parseRss(xml) {
        const items = [];
        const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
        for (const block of blocks) {
            const titleMatch = block.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
            const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
            const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
            const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? '').trim()
                .replace(/&amp;/g, '&').replace(/&#039;/g, "'")
                .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            if (!title)
                continue;
            const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
            items.push({
                title,
                link: linkMatch?.[1]?.trim() ?? '',
                time: pubDate && !Number.isNaN(pubDate.getTime())
                    ? this._relativeTime(pubDate) : '',
            });
        }
        return items;
    }

    _relativeTime(date) {
        const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
        if (minutes < 1)
            return 'À l\'instant';
        if (minutes < 60)
            return `Il y a ${minutes}m`;
        const hours = Math.round(minutes / 60);
        if (hours < 24)
            return `Il y a ${hours}h`;
        return `Il y a ${Math.round(hours / 24)}j`;
    }

    _buildTicker() {
        const px = this._px;
        this._tickerTrack.destroy_all_children();
        this._newsList.destroy_all_children();

        const makeRow = (item, forTicker) => {
            const row = new St.Button({
                x_expand: true,
                can_focus: true,
                style: forTicker
                    ? `background: none; border: none;`
                    : `background: none; border: none; `
                      + `border-bottom: 2px solid ${MODULE.strokeSoft}; `
                      + `padding: ${px(6)}px 0;`,
            });
            if (forTicker)
                row.height = this._jsx(24);
            const line = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER,
                style: `spacing: ${px(10)}px;`});
            const title = new St.Label({
                text: item.title,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(forTicker ? 13 : 12)}px; `
                    + `font-weight: ${forTicker ? 'bold' : 'normal'}; color: ${MODULE.text};`,
            });
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            title.clutter_text.line_wrap = false;
            const time = new St.Label({
                text: item.time,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(11)}px; color: ${MODULE.textMuted};`,
            });
            line.add_child(title);
            line.add_child(time);
            row.set_child(line);
            if (item.link) {
                row.connect('clicked',
                    () => Gio.AppInfo.launch_default_for_uri(item.link, null));
            }
            return row;
        };

        for (const item of this._newsItems) {
            this._tickerTrack.add_child(makeRow(item, true));
            this._newsList.add_child(makeRow(item, false));
        }
        /* clone du premier titre à la fin : permet la boucle du bandeau
         * sans saut visible, comme dans la maquette */
        if (this._newsItems.length > 0)
            this._tickerTrack.add_child(makeRow(this._newsItems[0], true));

        this._newsIndex = 0;
        this._tickerTrack.translation_y = 0;
        if (!this._expanded)
            this._startRotation();
    }

    _showNewsLoading() {
        this._stopRotation();
        this._tickerTrack.destroy_all_children();
        this._tickerTrack.add_child(new St.Label({
            text: 'Chargement…',
            style: `font-size: ${this._px(12)}px; color: ${MODULE.textMuted}; `
                + `height: ${this._jsx(24)}px;`,
        }));
    }

    _showNewsError() {
        this._tickerTrack.destroy_all_children();
        this._tickerTrack.add_child(new St.Label({
            text: 'Actualités indisponibles',
            style: `font-size: ${this._px(12)}px; color: ${MODULE.textMuted}; `
                + `height: ${this._jsx(24)}px;`,
        }));
    }

    _startRotation() {
        this._stopRotation();
        if (this._newsItems.length <= 1)
            return;
        this._rotateTimer = timeoutAdd(NEWS_ROTATE_MS, () => {
            if (this._destroyed || this._expanded)
                return GLib.SOURCE_CONTINUE;
            this._newsIndex++;
            this._tickerTrack.remove_all_transitions();
            this._tickerTrack.ease({
                translation_y: -this._newsIndex * this._jsx(24),
                duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                onComplete: () => {
                    if (this._newsIndex === this._newsItems.length) {
                        this._newsIndex = 0;
                        this._tickerTrack.translation_y = 0;
                    }
                },
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRotation() {
        this._rotateTimer = sourceRemove(this._rotateTimer);
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._refreshPrice(true);
        this._refreshNews(true);
        this._preloadStrip();
        if (!this._expanded)
            this._startRotation();

        if (!this._priceTimer) {
            this._priceTimer = timeoutAdd(PRICE_REFRESH_S * 1000, () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._refreshPrice(false);
                return GLib.SOURCE_CONTINUE;
            });
        }
        if (!this._newsTimer) {
            this._newsTimer = timeoutAdd(NEWS_REFRESH_S * 1000, () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._refreshNews(true);   // force : sinon le cache ne se
                return GLib.SOURCE_CONTINUE;   // rafraîchit jamais tout seul
            });
        }
    }

    onClose() {
        this._priceTimer = sourceRemove(this._priceTimer);
        this._newsTimer = sourceRemove(this._newsTimer);
        this._stopRotation();
        if (this._dropdownOpen)
            this._toggleDropdown();
    }

    destroy() {
        this._destroyed = true;
        this._fetchGen++;   // invalide toute réponse encore en vol
        this._priceTimer = sourceRemove(this._priceTimer);
        this._newsTimer = sourceRemove(this._newsTimer);
        this._stopRotation();
        this._session?.abort();
        this._session = null;
    }
}

export default {
    id: 'market',
    title: 'Marché & actualités',
    short: 'Marché',
    icon: 'ui-chart',
    build(ctx) {
        return new MarketCard(ctx);
    },
};
