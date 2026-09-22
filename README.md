# Side Panel

A floating side panel for GNOME Shell, made of cards you choose: a media
player, a time tracker, a to-do list, a system monitor, weather, a calendar,
your favourite apps… and any module from the
[community catalog](https://github.com/starman-tech/sidepanel-modules),
installed in one click without restarting the shell.

<p align="center">
  <img src="docs/screenshots/panel.png" width="420" alt="Side Panel in the dark and light themes">
  <img src="docs/screenshots/catalog.png" width="380" alt="The community catalog in the preferences">
</p>

**GNOME Shell 46 · 47 · 48 · 49** — X11 and Wayland.
The interface is in French for now ([translations welcome](CONTRIBUTING.md#translations)).
[Lire en français](README.fr.md).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/starman-tech/sidepanel/main/install.sh | bash
```

The installer asks which modules you want, then tells you how to activate the
extension (log out and back in on Wayland, `Alt+F2` → `r` on X11). No `sudo`,
nothing written outside your home folder.

<details>
<summary>Other ways to install</summary>

**From a clone** (to follow `main` or to hack on it):

```bash
git clone https://github.com/starman-tech/sidepanel
cd sidepanel
./install.sh                          # asks which modules to enable
./install.sh --defaults               # or: default modules, no questions
./install.sh --modules player,todo,weather
```

**From a release zip**: download `sidepanel@fgaudioso.dev-v*.zip` from the
[releases](https://github.com/starman-tech/sidepanel/releases), then

```bash
gnome-extensions install --force sidepanel@fgaudioso.dev-v*.zip
```

and log out / log in. You will be offered to pick your modules on first launch.

**Uninstall**: `./install.sh --uninstall` (your data stays in
`~/.config/sidepanel`).
</details>

## Use

| | |
|---|---|
| Open | Move the pointer to the right edge of the screen, or press `Super+P` (also pins it) |
| Pin | The pin button keeps the panel open |
| Rearrange | The pencil button, then drag a card, or use its arrows |
| Put a card away | Edit mode → *ranger*: it goes to the library at the bottom, one click brings it back |
| Grid view | The grid button shows modules as app icons; a click opens one full-size |
| Add modules | **＋** → *Catalogue*, or Preferences → *Catalogue* |
| Stay awake with the lid closed | The coffee cup button (see below) |

## Modules

Pick them in Preferences → **Modules**, or when running `install.sh`.

| Module | What it does | Network |
|---|---|---|
| Lecteur (player) | MPRIS player (Spotify, Firefox, VLC…): cover art, accent colour taken from the cover, audio output switcher, favourites | cover art URLs sent by the player |
| Suivi du temps (tracker) | Time spent per application today, measured locally from the focused window | — |
| Tâches (todo) | To-do list | — |
| Système (sysmon) | CPU, memory, disk, load, uptime from `/proc` | — |
| Météo (weather) | Current conditions and 5-day forecast | open-meteo.com |
| Calendrier (calendar) | Clock and month grid | — |
| Favoris (launcher) | Your dock's favourite applications | — |
| Marché & actualités (market) | BTC, ETH, SPY, S&P 500 intraday and related headlines | Yahoo Finance, Google News |
| Assistant IA (assistant) · *off by default* | Groq chat that knows your terminal's folder and suggests commands | api.groq.com |

**Community modules** — Pomodoro, network speed, quick note, clock… — are
listed in Preferences → **Catalogue**. Each file is checked against the
SHA-256 published in the catalog before it is loaded, and updates apply
live. [Write your own](docs/MODULES.md): it is a single JavaScript file.

### Privacy

Everything is local unless listed in the *Network* column above. Two
features send your data to a third party, and both are **off until you turn
them on**:

- **Assistant IA** sends to Groq the working directory of the terminal in the
  foreground, its running command and its last history lines, and can run
  read-only commands (`ls`, `find`, `git status`…) to explore folders.
- **Réécriture de la sélection** (a global shortcut, `Ctrl+M` by default)
  sends the selected text to Groq to correct, translate, rephrase or
  summarise it, and pastes the result.

Both need your own Groq API key (Preferences → *Réglages*). It is stored in
GSettings, readable by any program running as your user.

Community modules run inside GNOME Shell with your permissions. Catalog
entries are reviewed before they are merged, their source is one click away
in the preferences, and the catalog shows which hosts each one contacts —
still, only install what you trust.

### Stay awake with the lid closed

The coffee cup button blocks suspend on lid close: the screen locks and turns
off, but your builds, downloads and terminals keep running. It uses two
inhibitors (logind `handle-lid-switch` and gnome-session `suspend`) that are
released automatically if the shell stops; nothing is changed on the system.
Check with `systemd-inhibit --list | grep -i "side panel"`. The setting
persists across reboots: turn it off before putting the laptop in a bag.

This is why the extension also runs on the lock screen (`unlock-dialog`
session mode): otherwise GNOME would disable it — and release the
inhibitor — at the very moment the lid closes. The panel itself is removed
while the screen is locked.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gnome-extensions enable` says the extension doesn't exist | The shell has not rescanned yet: log out and in (Wayland) or `Alt+F2` → `r` (X11) |
| A card shows **ERREUR** | The module failed to load; the message is on the card, and *Retirer* removes it. Full log: `journalctl -b -o cat /usr/bin/gnome-shell \| grep -i sidepanel` |
| Nothing happens at the screen edge | Increase *Zone de déclenchement* in Preferences → *Panneau*, or use `Super+P` |
| The catalog is unreachable | Offline: the last downloaded copy is shown. Behind a proxy: GNOME's proxy settings apply |
| No cover art | The player does not publish `mpris:artUrl` (common with browsers) |
| Suspend still happens with the cup on | `systemd-inhibit --list` must list *Side Panel … handle-lid-switch … block* |
| Background blur freezes the shell | Some drivers (NVIDIA on X11 in particular) do not cope: turn off *Flou de l'arrière-plan* in Preferences → *Style* |

## Development

```bash
tools/nested.sh      # isolated nested GNOME Shell running the working copy
tools/lint.sh        # syntax, missing imports, GSettings schema, metadata
tools/build.sh       # dist/sidepanel@fgaudioso.dev-v<version>.zip
```

`tools/nested.sh` keeps its configuration, data and dconf database in
`.run/sandbox`, so testing never touches your session. See
[CONTRIBUTING.md](CONTRIBUTING.md) and, for the internals,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (in French).

## License

[GPL-3.0-or-later](LICENSE).
