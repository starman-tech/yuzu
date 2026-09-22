# Writing a Yuzu module

A module is **one JavaScript file** that adds a card to the panel. It runs in
the GNOME Shell process (GJS, ES modules), is loaded without restarting the
shell, and can be shared with everyone through the
[community catalog](https://github.com/starman-tech/yuzu-modules).

- [Installing modules](#installing-modules)
- [The contract](#the-contract)
- [The `ctx` object](#the-ctx-object)
- [Rules that save you hours](#rules-that-save-you-hours)
- [Testing](#testing)
- [Publishing to the catalog](#publishing-to-the-catalog)

## Installing modules

| From | How |
|---|---|
| The catalog | Preferences → **Catalogue** → **Installer**. The file is checked against its SHA-256 and the card appears immediately. |
| A file | Preferences → **Modules** → **Importer un fichier…**, or the **＋** button in the panel → **Fichier…** |
| By hand | Drop the `.js` in `~/.config/yuzu/modules/`, then **＋** in the panel. |

Updates from the catalog are applied live: each version is saved under a new
file name (`<id>-<version>.js`), because GJS caches imported modules by URL
until the shell restarts.

## The contract

```js
// SPDX-License-Identifier: GPL-3.0-or-later
export default {
    id: 'my-module',          // unique, lowercase, a-z 0-9 -, 2–40 chars
    title: 'My module',       // shown in edit mode and in the library
    short: 'Mine',            // optional: label under the tile in grid view
    icon: 'starred-symbolic', // a GNOME icon name

    build(ctx) {
        const {St} = ctx;
        const actor = new St.Label({text: 'Hello'});

        return {
            actor,                 // required: the root St actor of the card
            setTheme(theme) {},    // optional: the theme changed, restyle
            onOpen() {},           // optional: panel opened → start timers
            onClose() {},          // optional: panel closed → stop timers
            destroy() {},          // optional: free EVERYTHING you created
        };
    },
};
```

Reserved ids (built-in modules): `player`, `tracker`, `market`, `todo`,
`sysmon`, `weather`, `calendar`, `launcher`, `assistant`.

The card frame (border, shadow, edit bar) is drawn by the panel. Your actor
only draws the inside: usually a vertical `St.BoxLayout` with
`padding: 14px 16px`.

`build()` may be called several times in a session: the panel rebuilds every
card when the layout changes (a module is added, the width changes…). Keep
state that must survive in a file (see `utils.configFile`).

## The `ctx` object

| Key | What it is |
|---|---|
| `St`, `Clutter`, `GLib`, `Gio` | The GI namespaces, already imported. |
| `api` | Version of this API (currently `1`). Only additions are made; check `ctx.api >= n` before using something newer. |
| `theme` | Current theme tokens: `text`, `textDim`, `textMuted`, `accent`, `accentInk`, `danger`, `cardTint`, `innerStroke`, `cardRadius`, `radius`, `strokeWidth`, `fontUI`, `fontDisplay`, `fontMono`. |
| `palette` | Colours for the inside of cards, following the theme (light or dark): `surface`, `surfaceStrong`, `inset`, `insetHover`, `stroke`, `strokeSoft`, `text`, `textDim`, `textMuted`, `accent`, `accentInk`, `positive`, `positiveBg`, `negative`, `negativeBg`. Read it when you build or in `setTheme()`, never copy it into a module-level constant. |
| `moduleWidth` | Width available for your card, in logical pixels. |
| `settings` | The extension's `Gio.Settings`. Read only; do not add keys. |
| `panel` | The panel. Useful: `panel.enterEditMode(clutterText)` for text entry (see below), `panel.close()`. |
| `extension` | The `Extension` object (`extension.path`, `extension.metadata`). |
| `style.labelStyle(theme, {size, color})` | CSS for the small uppercase monospace captions used by every card. |
| `style.cardStyle(theme, {padding, radius, shadow})` | CSS for an inner block with the theme's border. |
| `utils.timeoutAdd(ms, fn)` / `utils.sourceRemove(id)` | Timers. `sourceRemove` ignores `0` and returns `0`: `this._t = utils.sourceRemove(this._t)`. |
| `utils.scaleFactor()` | HiDPI factor. Multiply sizes you set **in JS** (`set_width`, `set_height`); CSS pixels are scaled for you. |
| `utils.configFile(name)` | `~/.config/yuzu/<name>`; the folder is created. |
| `utils.cacheDir(...parts)` | `~/.cache/yuzu/...`; created. |
| `utils.readJson(path, fallback)` / `utils.writeJson(path, value)` | JSON files, never throw on read. |
| `utils.newSession()` / `utils.fetchBytes(session, url, cancellable, headers)` | HTTP through libsoup 3. Declare every host you contact in `module.json` → `network`. |

You may also import GI libraries yourself (`gi://Pango`, `gi://Soup?version=3.0`,
`gi://Shell`, `gi://Meta`…) and `resource:///org/gnome/shell/ui/main.js`
(for `Main.notify`). You **cannot** import files of the extension (`../lib/…`):
your file lives in `~/.config`, not next to them.

## Rules that save you hours

1. **Stop what you start.** Every timer, signal on a global object
   (`global.display`, `Main.layoutManager`…), D-Bus proxy and Soup session must
   be released in `destroy()`. Refresh only while the panel is open
   (`onOpen` / `onClose`) unless the module is useless otherwise (a timer).
2. **Text entry needs a grab.** Without it GNOME sends keys to the focused
   window. On click, call `panel.enterEditMode(entry.clutter_text)`.
3. **Letter-spacing truncates labels.** St measures text without
   `letter-spacing`, so a spaced label ends with `…` although it fits. Set
   `label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE` on such labels.
4. **St is not the web.** No `linear-gradient(135deg)`, no `%` radius, no
   `opacity` or `transform` in CSS strings, no flexbox. Use
   `background-gradient-direction: vertical|horizontal`, pixel radii, and actor
   properties (`actor.opacity`, `actor.ease({...})`).
5. **Do not name fields like GObject properties.** In a class registered with
   `GObject.registerClass`, `this.content = …` sets Clutter's `content`
   property. Prefix private fields with `_`.
6. **Fail gently.** An exception in `build()` shows an error card that the user
   can remove; an exception in a timer callback is only logged. Catch network
   errors and show them in the card.

More pitfalls (in French), from building the built-in modules:
[`module-pitfalls.fr.md`](module-pitfalls.fr.md).

## Testing

```bash
git clone https://github.com/starman-tech/yuzu
cd yuzu
tools/nested.sh          # an isolated nested GNOME Shell with the extension
```

`tools/nested.sh` keeps its configuration in `.run/sandbox`, so your real
session is never touched. Copy your module to
`.run/sandbox/config/yuzu/modules/`, then use **＋** in the nested panel.
Logs: `.run/nested.log`.

Inside the nested shell, `tools/panel.sh 'code'` runs JavaScript with `p` bound
to the panel, and `tools/shot.sh name` saves a screenshot to `tools/shots/`.

## Publishing to the catalog

See [yuzu-modules/CONTRIBUTING.md](https://github.com/starman-tech/yuzu-modules/blob/main/CONTRIBUTING.md).
In short: a folder `modules/<id>/` with `<id>.js` and `module.json`, run
`tools/build-catalog.py`, open a pull request.
