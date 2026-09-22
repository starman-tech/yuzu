# Contributing

Thanks for helping! Bug reports, fixes, translations and modules are all
welcome. Issues and pull requests can be written in English or French.

## Where does my change go?

| You want to… | Repository |
|---|---|
| Add a card anyone can install | [sidepanel-modules](https://github.com/starman-tech/sidepanel-modules) — see its CONTRIBUTING |
| Fix the panel, a built-in module, the preferences, the installer | this one |

## Set up

```bash
git clone https://github.com/starman-tech/sidepanel
cd sidepanel
tools/nested.sh          # nested GNOME Shell running your working copy
```

`tools/nested.sh` installs the working copy into `.run/sandbox` and starts a
nested shell whose configuration, data, cache and dconf database all live
there: your own session is never modified. Restart it to load code changes
(`--reset` starts from an empty sandbox). Logs go to `.run/nested.log`.

While it runs:

```bash
tools/panel.sh 'p.open(); p._pinned = true'   # run JS with p = the panel
tools/shot.sh my-shot                          # screenshot → tools/shots/my-shot.png
tools/fake-mpris.py                            # a fake MPRIS player for the player card
```

## Before opening a pull request

```bash
tools/lint.sh
```

It checks JavaScript syntax, identifiers used without being imported (the bug
class that most often puts the extension in `ERROR` state), the GSettings
schema and `metadata.json`. CI runs the same script.

Then, with `tools/nested.sh` running:

```bash
tools/smoke.sh
```

It opens the panel, switches theme, width and view, toggles edit mode,
disables and re-enables the extension, and fails if the log gained any JS or
St/GLib critical error. What it cannot check, test by hand in the nested
shell when your change touches it:

- the preferences (`gnome-extensions prefs sidepanel@fgaudioso.dev` from a
  terminal pointed at the nested bus, or the settings button of the panel);
- installing, updating and removing a catalog module;
- typing in a text field (to-do, quick note): keys must reach the panel;
- how it looks: `tools/shot.sh` in both themes.

## Code rules

- Match the surrounding code: 4-space indentation, single quotes, comments
  in French explaining *why*.
- Every timer, signal connection, D-Bus subscription and Soup session is
  released in `destroy()` / `disable()`. Use `timeoutAdd` / `sourceRemove`
  from `lib/utils.js`.
- Files written to disk go through `configFile()` / `cacheDir()`.
- `prefs.js` runs in a separate GTK process: it must not import anything that
  imports `St`, `Clutter` or `Main`. `lib/catalog.js` and `lib/theme.js` are
  shared on purpose and must stay that way.
- New built-in module: add it to `BUILTINS` in `lib/registry.js`, to
  `builtins.json` (title, description, default, network, privacy) and, if it
  should be on by default, to the `module-order` default in the schema.
- New settings key: add it to the schema with a summary; `install.sh` and
  `tools/nested.sh` compile the schema for you.
- Adding something to `ctx` for modules: bump `MODULE_API` in `lib/panel.js`
  and document it in `docs/MODULES.md`. Never remove or change an existing
  entry, catalog modules depend on it.

## Translations

The interface is only in French for now. Strings are not yet wrapped in
`gettext`; that is the first step, and a welcome pull request. The
`gettext-domain` in `metadata.json` is already `sidepanel@fgaudioso.dev`.

## The extensions.gnome.org edition

`tools/build.sh --ego` builds `dist/ego/sidepanel@starman-tech.github.io.zip`
from the same source, through `tools/edition.py`:

- lines between `// #if full` and `// #endif` (or `<!-- #if full -->` in the
  schema) are removed; lines of an `// #else` branch are written commented
  with `//: ` so the source stays valid, and are uncommented;
- `modules/assistant.js`, `lib/rewrite.js` and `lib/catalog.js` are dropped;
- the community modules (`../sidepanel-modules`, or `SIDEPANEL_MODULES=…`) are
  copied into `modules/community/` and become built-in modules, off by default;
- long design comments are trimmed, `metadata.json` gets the EGO UUID.

Anything that loads code at run time, spawns processes, simulates input or
reads the clipboard must stay inside `#if full`. Test the EGO zip with
`tools/nested.sh --ego` then `tools/smoke.sh`.

## Releases

1. Bump `version` and `version-name` in `sidepanel@fgaudioso.dev/metadata.json`,
   and add an entry to `CHANGELOG.md`.
2. Commit, then tag: `git tag v5.1 && git push --tags`.
3. The *Release* workflow builds the zip with `tools/build.sh` and attaches it
   to a GitHub release; `install.sh` always installs the latest release.
