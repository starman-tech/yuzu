// SPDX-License-Identifier: GPL-3.0-or-later
/* modules/weather.js — météo via Open-Meteo (gratuit, sans clé).
 *
 *   1. géocodage de la ville (clé `weather-location`) :
 *      geocoding-api.open-meteo.com/v1/search
 *   2. prévisions : api.open-meteo.com/v1/forecast — conditions actuelles
 *      + 5 jours (min/max, code météo WMO)
 *
 * La dernière réponse est mise en cache dans ~/.cache/yuzu/weather.json
 * pour un affichage instantané à l'ouverture ; rafraîchi toutes les 15 min
 * panneau ouvert, et dès que la ville change dans les préférences.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {MODULE} from '../lib/theme.js';
import {ensureDir, fetchText, newSession, scaleFactor, sourceRemove, timeoutAdd} from '../lib/utils.js';

const DESIGN_WIDTH = 380;
const REFRESH_MS = 15 * 60 * 1000;

/* Codes météo WMO → libellé + glyphe. */
const WMO = [
    [[0], 'Ciel dégagé', '☀'],
    [[1], 'Plutôt dégagé', '🌤'],
    [[2], 'Partiellement nuageux', '⛅'],
    [[3], 'Couvert', '☁'],
    [[45, 48], 'Brouillard', '🌫'],
    [[51, 53, 55, 56, 57], 'Bruine', '🌦'],
    [[61, 63, 65, 66, 67], 'Pluie', '🌧'],
    [[71, 73, 75, 77], 'Neige', '❄'],
    [[80, 81, 82], 'Averses', '🌧'],
    [[85, 86], 'Averses de neige', '🌨'],
    [[95, 96, 99], 'Orage', '⛈'],
];

function describe(code) {
    const hit = WMO.find(([codes]) => codes.includes(code));
    return hit ? {label: hit[1], glyph: hit[2]} : {label: '—', glyph: '·'};
}

function dayName(iso) {
    try {
        const [y, m, d] = iso.split('-').map(Number);
        return GLib.DateTime.new_local(y, m, d, 12, 0, 0).format('%a').replace('.', '');
    } catch (_e) {
        return iso;
    }
}

class WeatherCard {
    constructor(ctx) {
        this._settings = ctx.settings;
        this._moduleWidth = ctx.moduleWidth;
        this._session = newSession();
        this._timer = 0;
        this._gen = 0;
        this._destroyed = false;
        this._cacheFile = `${ensureDir(`${GLib.get_user_cache_dir()}/yuzu`)}/weather.json`;

        this._build();
        this._loadCache();
        this._settingsId = this._settings.connect('changed::weather-location', () => this._refresh(true));
        this._refresh(false);
    }

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
                + `padding: ${px(20)}px; spacing: ${px(12)}px; color: ${MODULE.text};`,
        });

        /* en-tête : ville + statut */
        const header = new St.BoxLayout({x_expand: true});
        this._cityLabel = new St.Label({
            text: 'MÉTÉO',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(13)}px; font-weight: bold; letter-spacing: 1px; `
                + `color: ${MODULE.textDim};`,
        });
        this._cityLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._statusLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(10)}px; color: ${MODULE.textMuted};`,
        });
        header.add_child(this._cityLabel);
        header.add_child(this._statusLabel);
        this.actor.add_child(header);

        /* actuel : glyphe + température + description */
        const now = new St.BoxLayout({x_expand: true, style: `spacing: ${px(14)}px;`});
        this._glyph = new St.Label({
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${px(40)}px;`,
        });
        const nowText = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._tempLabel = new St.Label({
            text: '—°',
            style: `font-size: ${px(34)}px; font-weight: bold; letter-spacing: -1px; color: ${MODULE.text};`,
        });
        this._descLabel = new St.Label({
            text: 'Chargement…',
            style: `font-size: ${px(13)}px; color: ${MODULE.textDim};`,
        });
        this._descLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        nowText.add_child(this._tempLabel);
        nowText.add_child(this._descLabel);
        now.add_child(this._glyph);
        now.add_child(nowText);
        this.actor.add_child(now);

        /* détails : vent, humidité, min/max du jour */
        this._detailRow = new St.BoxLayout({x_expand: true, style: `spacing: ${px(6)}px;`});
        this._detailWind = this._chip('💨 —');
        this._detailHum = this._chip('💧 —');
        this._detailRange = this._chip('↕ —');
        for (const c of [this._detailWind, this._detailHum, this._detailRange])
            this._detailRow.add_child(c);
        this.actor.add_child(this._detailRow);

        /* prévisions 5 jours */
        this._daysRow = new St.BoxLayout({
            x_expand: true,
            style: `spacing: ${px(4)}px; padding-top: ${px(4)}px;`,
        });
        this._dayCells = [];
        for (let i = 0; i < 5; i++) {
            const cell = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style: `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                    + `border-radius: ${px(3)}px; padding: ${px(6)}px ${px(2)}px; spacing: ${px(2)}px;`,
            });
            const name = new St.Label({
                text: '—',
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(10)}px; font-weight: bold; color: ${MODULE.textMuted};`,
            });
            const glyph = new St.Label({
                text: '·',
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(16)}px;`,
            });
            const range = new St.Label({
                text: '—',
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${px(10)}px; font-weight: bold; color: ${MODULE.text};`,
            });
            cell.add_child(name);
            cell.add_child(glyph);
            cell.add_child(range);
            this._daysRow.add_child(cell);
            this._dayCells.push({cell, name, glyph, range});
        }
        this.actor.add_child(this._daysRow);
    }

    _chip(text) {
        const px = this._px;
        return new St.Label({
            text,
            style: `font-size: ${px(11)}px; font-weight: bold; color: ${MODULE.textDim}; `
                + `background-color: ${MODULE.inset}; border: 2px solid ${MODULE.strokeSoft}; `
                + `border-radius: ${px(3)}px; padding: ${px(3)}px ${px(8)}px;`,
        });
    }

    setTheme(_theme) {}

    /* ---------------------------------------------------------- données */

    _loadCache() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._cacheFile);
            if (ok)
                this._render(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (_e) {}
    }

    _saveCache(data) {
        try {
            GLib.file_set_contents(this._cacheFile, JSON.stringify(data));
        } catch (_e) {}
    }

    async _refresh(force) {
        if (this._destroyed)
            return;
        const gen = ++this._gen;
        const city = (this._settings.get_string('weather-location') || 'Paris').trim();
        this._statusLabel.text = '…';

        try {
            const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search'
                + `?name=${encodeURIComponent(city)}&count=1&language=fr&format=json`;
            const geo = JSON.parse(await fetchText(this._session, geoUrl));
            const place = geo?.results?.[0];
            if (!place)
                throw new Error(`ville introuvable : ${city}`);
            if (gen !== this._gen || this._destroyed)
                return;

            const url = 'https://api.open-meteo.com/v1/forecast'
                + `?latitude=${place.latitude}&longitude=${place.longitude}`
                + '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m'
                + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
                + '&timezone=auto&forecast_days=5';
            const data = JSON.parse(await fetchText(this._session, url));
            if (gen !== this._gen || this._destroyed)
                return;

            const model = {
                city: place.name,
                country: place.country_code ?? '',
                fetched: Date.now(),
                current: data.current,
                daily: data.daily,
            };
            this._saveCache(model);
            this._render(model);
        } catch (e) {
            if (!this._destroyed)   // annulée par destroy() : rien à signaler
                console.warn(`[yuzu] météo : ${e}`);
            if (gen === this._gen && !this._destroyed) {
                this._statusLabel.text = 'hors ligne';
                if (this._descLabel.text === 'Chargement…')
                    this._descLabel.text = String(e.message ?? e);
            }
        }
        void force;
    }

    _render(m) {
        if (this._destroyed || !m?.current)
            return;
        const cur = m.current;
        const now = describe(cur.weather_code);
        this._cityLabel.text = `${m.city}${m.country ? ` · ${m.country}` : ''}`.toUpperCase();
        this._glyph.text = now.glyph;
        this._tempLabel.text = `${Math.round(cur.temperature_2m)}°`;
        this._descLabel.text = now.label;
        this._detailWind.text = `💨 ${Math.round(cur.wind_speed_10m)} km/h`;
        this._detailHum.text = `💧 ${Math.round(cur.relative_humidity_2m)} %`;

        const d = m.daily ?? {};
        const times = d.time ?? [];
        if (times.length > 0) {
            this._detailRange.text = `↕ ${Math.round(d.temperature_2m_min[0])}° / ${Math.round(d.temperature_2m_max[0])}°`;
        }
        this._dayCells.forEach((cell, i) => {
            if (i >= times.length) {
                cell.cell.hide();
                return;
            }
            cell.cell.show();
            cell.name.text = i === 0 ? 'auj.' : dayName(times[i]);
            cell.glyph.text = describe(d.weather_code[i]).glyph;
            cell.range.text = `${Math.round(d.temperature_2m_min[i])}°/${Math.round(d.temperature_2m_max[i])}°`;
        });

        const age = Math.round((Date.now() - (m.fetched ?? Date.now())) / 60000);
        this._statusLabel.text = age < 1 ? 'à jour' : `il y a ${age} min`;
    }

    /* ------------------------------------------------------------ hooks */

    onOpen() {
        this._refresh(false);
        if (this._timer)
            return;
        this._timer = timeoutAdd(REFRESH_MS, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._refresh(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    onClose() {
        this._timer = sourceRemove(this._timer);
    }

    destroy() {
        this._destroyed = true;
        this._gen++;
        this._timer = sourceRemove(this._timer);
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._session?.abort();
        this._session = null;
    }
}

export default {
    id: 'weather',
    title: 'Météo',
    short: 'Météo',
    icon: 'ui-weather',
    build(ctx) {
        return new WeatherCard(ctx);
    },
};
