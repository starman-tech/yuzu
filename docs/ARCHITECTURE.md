# Side Panel — guide pour les IA de code

Ce fichier décrit **où se trouve chaque chose et ce qu'elle fait** dans
l'extension. Lis-le avant de toucher au code. Il est écrit pour un agent qui
connaît JavaScript mais pas forcément GNOME Shell / GJS / St / Clutter.

---

## 0. Nouveautés de la v5 (à lire en premier)

- **Catalogue** : `lib/catalog.js`, partagé shell/préférences (Gio, GLib,
  Soup seulement). Téléchargement vérifié par SHA-256, fichier installé sous
  `<id>-<version>.js` (le cache d'`import()` de GJS est par URI), index dans
  `~/.config/sidepanel/catalog-installed.json`. Les préférences écrivent
  `module-paths` ; le panneau écoute cette clé et importe à chaud
  (`_loadImportedModules({show: true})`).
- **Choix des modules** : `builtins.json` (lu par `prefs.js` et `install.sh`),
  un interrupteur par module = présence dans `module-order`. La grille
  n'affiche que les modules activés.
- **Thèmes** : `MODULE` (lib/theme.js) est un objet VIVANT recalé par
  `applyModulePalette(theme)` ; changer de thème reconstruit les cartes
  (`_switchTheme`). Ne jamais recopier une couleur de `MODULE` dans une
  constante de niveau module. Variantes CSS claires sous `.sp-light`.
  Le lecteur utilise `MODULE_ON_ART` (sombre) quand une pochette est affichée.
- **Largeur des modules** : `moduleWidth()` est corrigée par
  `_calibrateWidth()`, qui mesure le premier cadre alloué.
- **API des modules** : `ctx.api` (1), `ctx.palette`, `ctx.style`,
  `ctx.utils` — voir `docs/MODULES.md`. On n'y retire jamais rien.
- **Opt-in** : assistant IA désactivé par défaut, réécriture Ctrl+M derrière
  `rewrite-enabled`. Données dans `~/.config/sidepanel` (migration depuis
  `mon-extension` dans `configDir()`).
- **Hors scène** : ne jamais lire `width` d'un acteur St qui n'est pas sur la
  scène (St-CRITICAL) ; tester `get_stage()` d'abord. Après un `await`,
  tester `this._destroyed` avant de toucher un acteur.

## 1. Ce qu'est ce projet

- **Extension GNOME Shell 46 à 49** (X11 ou Wayland), UUID `sidepanel@fgaudioso.dev`.
- Un **panneau flottant** qui sort du bord droit de l'écran (survol du bord ou
  `Super+P`), rendu « verre dépoli » avec fond animé peint en Cairo.
- Le panneau est une **pile de cartes**. Chaque carte est un **module** :
  9 modules intégrés (`modules/`, métadonnées dans `builtins.json`) + les
  modules du catalogue communautaire ou n'importe quel `.js` déposé dans
  `~/.config/sidepanel/modules/`, chargés à chaud.
- Langage : **GJS** (JavaScript ESM tournant dans le processus de gnome-shell).
  Pas de npm ni de bundler. Vérifications : `tools/lint.sh` (statique) et
  `tools/smoke.sh` (parcours dans le shell imbriqué de `tools/nested.sh`).
  L'UI n'est **pas** du HTML : ce sont des acteurs **St** (widgets) et
  **Clutter** (scène/animations). Le CSS est le sous-ensemble limité de St.
- Toute la doc, les commentaires et les libellés sont **en français**. Continue
  en français.

Deux processus distincts, à ne pas mélanger :

| Processus | Fichiers | Bibliothèques disponibles |
|---|---|---|
| gnome-shell (l'extension) | `extension.js`, `lib/*`, `modules/*`, `examples/*` | St, Clutter, Shell, Meta, Cairo, Gio, GLib, Soup, GdkPixbuf, Gvc |
| préférences (fenêtre séparée) | `prefs.js` | Gtk4, Adw, Gio, GLib, Gdk — **jamais St ni Clutter** |

`lib/theme.js` est le seul module partagé par les deux : il ne doit importer
**aucune** bibliothèque GI.

---

## 2. Carte des fichiers

```
sidepanel@fgaudioso.dev/
├── metadata.json          identité, versions shell, session-modes (user + unlock-dialog)
├── extension.js           point d'entrée : enable()/disable(), crée KeepAwake + SidePanel
├── prefs.js               fenêtre de préférences (Adw/Gtk4), 4 pages
├── stylesheet.css         classes St (boutons, en-tête, pastilles) — transitions natives
├── schemas/…gschema.xml   toutes les clés GSettings (voir §7)
├── install.sh             rsync vers ~/.local/share/gnome-shell/extensions + compile schéma
├── check-imports.py       lint maison : identifiant utilisé sans import (cause d'ERROR)
├── README.md              doc utilisateur (partiellement obsolète, voir §9)
├── lib/
│   ├── panel.js           ★ LE CŒUR : classe SidePanel (UI, géométrie, ouverture, modules, drag, grab clavier, raccourci)
│   ├── card.js            ModuleCard : enveloppe d'un module + barre d'édition (monter/descendre/ranger/retirer/glisser)
│   ├── registry.js        ModuleRegistry : catalogue des modules intégrés + import() dynamique des scripts utilisateur
│   ├── glass.js           LiquidBackground (fond animé Cairo, 4 formes) + applyBackdropBlur (Shell.BlurEffect)
│   ├── theme.js           THEMES (4 thèmes = jetons), SHAPES, fabriques de style CSS
│   ├── widgets.js         fabriques de boutons : makeAddButton, makeActionButton, makeVectorButton, makePill, popIn, makeButton
│   ├── vectorIcons.js     icônes SVG inline → fichiers .svg cachés, recolorables (vectorIcon / setVectorIcon)
│   ├── keepAwake.js       KeepAwake : verrous logind + gnome-session « rester allumé capot fermé »
│   ├── rewrite.js         SmartRewrite : raccourci global (Ctrl+M), lit la sélection, l'envoie à Groq selon le préfixe (~ # > ! ? $ =), colle le résultat à la place (clavier virtuel), bandeau `.sp-toast`
│   └── utils.js           timers, clamp/lerp, fetch Soup, extractPastelAccent, scaleFactor, roundedPath, Marquee
├── modules/               modules intégrés (chacun exporte {id, title, icon, build(ctx)})
│   ├── player.js          lecteur MPRIS : pochette, accent extrait, précédent/suivant, aléatoire, répétition, sortie audio + volume (Gvc), favoris, clic logo ⇒ appli au premier plan
│   ├── tracker.js         suivi du temps par application (focus-window + titres), pause, total 7 jours (historique 14 j), 100 % local
│   ├── market.js          9 actifs (BTC, ETH, SOL, SPY, S&P 500, NVDA, AAPL, or, EUR/USD) via Yahoo Finance, bandeau de synthèse 24 h, actualités Google News, bouton actualiser
│   ├── todo.js            liste de tâches : saisie (grab modal), édition en place (double-clic), purge des terminées, persistance JSON
│   ├── sysmon.js          CPU / mémoire / disque / charge / uptime depuis /proc et Gio, 100 % local
│   ├── weather.js         météo Open-Meteo (géocodage + prévisions 5 j), ville dans `weather-location`, cache disque
│   ├── calendar.js        horloge + calendrier mensuel navigable, aujourd'hui en bloc orange
│   └── launcher.js        grille des applis favorites GNOME (`org.gnome.shell favorite-apps`), clic ⇒ lance et ferme le panneau
│   └── assistant.js       chat IA Groq (flux SSE, outils list_dir/find_path/run_inspect/web_search, contexte du terminal ou du gestionnaire de fichiers au premier plan, commandes ⇒ collées et exécutées dans le terminal via clavier virtuel)
└── examples/              modules de démonstration copiables dans le dossier utilisateur
    ├── clock.js           horloge (timer + setTheme)
    └── quicknote.js       champ de texte (montre enterEditMode + persistance)
```

Taille : ~8 800 lignes. Les plus gros : `modules/player.js` (1 119),
`lib/panel.js` (1 022), `modules/market.js` (900), `modules/todo.js` (756).

---

## 3. Flux d'exécution

```
gnome-shell active l'extension
  └─ extension.js  enable()
       ├─ new KeepAwake(settings)          lib/keepAwake.js  (indépendant du panneau, survit à l'écran verrouillé)
       └─ _syncPanel()                     écoute Main.sessionMode 'updated'
            └─ new SidePanel(extension)    lib/panel.js      (détruit quand l'écran est verrouillé, recréé après)
                 ├─ new ModuleRegistry()   lib/registry.js   (4 intégrés enregistrés dans le constructeur)
                 ├─ _build()               crée _edge (bande de survol) + _actor (racine verre) et les ajoute au chrome
                 │    ├─ LiquidBackground  lib/glass.js
                 │    ├─ en-tête           makeAddButton / makeActionButton  (lib/widgets.js)
                 │    ├─ St.ScrollView → _scrollContent → _stack (cartes) + _picker + _library
                 │    ├─ _applyTheme()
                 │    ├─ _buildCards()     pour chaque id de 'module-order' non caché :
                 │    │     descriptor.build(ctx) → instance → new ModuleCard(descriptor, instance, theme)
                 │    └─ _relayout()       taille + position depuis la zone de travail
                 ├─ _loadImportedModules() import() des chemins de 'module-paths', puis _rebuildCards()
                 ├─ settings 'changed'    → RESTYLE ⇒ _applyTheme() | STRUCTURAL ⇒ _rebuild() | toggle-panel ⇒ _rebindShortcut()
                 └─ _bindShortcut()       Main.wm.addKeybinding('toggle-panel')
```

**Ouverture / fermeture** (`panel.js` `open()` l.783, `close()` l.820) :
- Survol de `_edge` ⇒ `open()` si `show-on-hover`. Quitter `_actor` ⇒ `_scheduleHide()` (délai `hide-delay`).
- `open()` : translation_x → 0 (rebond `EASE_OUT_BACK` si `bounce`), cartes en cascade via `popIn`, `_background.start()`, `card.onPanelOpened()` pour chaque carte.
- `close()` refuse si épinglé, si grab clavier actif, ou si drag en cours (`_shouldStayOpen()` l.874). `close(true)` force.
- `toggle()` (raccourci) ouvre **et épingle**, ou désépingle et ferme.
- Mode édition ⇒ épingle automatiquement (`setEditMode` l.863).

**Mode « applis »** (`view-mode = 'grid'`, bouton grille de l'en-tête ou préférences) : `_buildCards()` délègue à `_buildGrid()` qui pose une grille de tuiles (3 colonnes, `.sp-tile` + bloc d'icône `.sp-tile-icon`) pour **tous** les modules connus (`_gridDescriptors()` : ordre de `module-order`, puis le reste). Un clic (`_openTile`) construit le module **à la demande** (`_gridCard`, cache `_gridCards` jusqu'à la prochaine reconstruction), fait bondir la tuile, estompe la grille puis fait monter la carte dans `_focus` (`EASE_OUT_EXPO`) ; l'en-tête passe en « retour + titre du module ». `_closeFocus()` fait l'inverse (Échap aussi). `onPanelOpened/Closed` ne sont relayés qu'au module ouvert.

**Réactions aux réglages** (`panel.js` l.21-29) :
- `RESTYLE` = theme, backdrop-blur, bg-* ⇒ `_applyTheme()` seulement (pas de reconstruction).
- `STRUCTURAL` = panel-width, panel-margin, edge-width, module-order, module-hidden, player-width, player-height, card-spacing, **view-mode** ⇒ `_rebuild()` = `_teardownUI()` + `_build()` (tous les modules sont **détruits et reconstruits**).

**Cycle de vie d'un module** : `build(ctx)` une fois par (re)construction → `setTheme(t)` à chaque changement de thème → `onOpen()` / `onClose()` à chaque ouverture/fermeture du panneau → `destroy()` lors d'un `_rebuild()` ou de la désactivation. Les modules **doivent** arrêter leurs timers dans `onClose()` et tout libérer dans `destroy()` (D-Bus, Soup, signaux `global.display`).

---

## 4. Détail par fichier

### `extension.js` (40 l.)
`enable()` crée `KeepAwake` puis surveille `Main.sessionMode` : panneau détruit quand `isLocked`, recréé sinon. `metadata.json` déclare `unlock-dialog` précisément pour que le verrou « rester allumé » ne tombe pas au verrouillage.

### `lib/panel.js` — classe `SidePanel`
| Zone | Méthodes | Rôle |
|---|---|---|
| Constantes l.21-40 | `STRUCTURAL`, `RESTYLE`, `PADDING_LEFT=14`, `PADDING_RIGHT=4`, `SCROLLBAR_WIDTH=10`, `VERTICAL_BREATHING=28` | source unique des marges internes ; `moduleWidth()` en dépend |
| UI l.84-275 | `_build()`, `_connect()` | construit edge + racine + en-tête (＋, titre « Panneau », tasse/crayon/punaise/réglages) + scroll + picker + bibliothèque |
| Thème l.279-324 | `_applyTheme()`, `_backgroundParams()` | applique `panelStyle`, inset du calque de flou, styles du picker/bibliothèque, `card.setTheme()` |
| Modules l.328-434 | `_loadImportedModules()`, `moduleWidth()`, `_moduleContext()`, `_buildCards()`, `_errorCard()`, `_rebuildCards()` | `ctx` fourni aux modules : `{St, Clutter, GLib, Gio, theme, settings, panel, extension, moduleWidth}` ; un module qui lève une exception donne une carte d'erreur rouge avec bouton « Retirer » |
| Drag l.438-504 | `_beginDrag()`, `_updateDrag()`, `_endDrag()` | réordonne `_stack` par position Y de la souris ; enregistre `module-order` au relâchement |
| Ordre l.506-556 | `_moveModule()`, `_stowModule()`, `_restoreModule()`, `_removeModule()`, `_renderLibrary()` | tout passe par les clés `module-order` / `module-hidden` / `module-paths` ⇒ déclenche `_rebuild()` |
| Import l.560-714 | `_togglePicker()`, `_importFile()`, `_addToPanel()`, `_browseForModule()` (zenity), `_adoptFile()`, `_copyExamples()` | le picker liste les `.js` du dossier utilisateur non encore chargés + les modules connus absents du panneau |
| Géométrie l.722-775 | `_closedOffset()`, `requestRelayout()`, `_relayout()` | hauteur = hauteur naturelle du contenu, bornée par la zone de travail et `panel-max-height` ; position calculée depuis `getWorkAreaForMonitor` (respecte docks) ; **tout est × scaleFactor()** |
| Ouverture l.779-901 | `open()`, `close()`, `toggle()`, `setPinned()`, `setEditMode()`, `_shouldStayOpen()`, `_scheduleHide()`, `_cancelHide()` | voir §3 |
| Clavier l.907-945 | `enterEditMode(focusActor)`, `leaveEditMode()` | `Main.pushModal` sur `_actor` + clic hors panneau ⇒ sortie. **Obligatoire pour tout St.Entry** |
| Raccourci l.949-959 | `_bindShortcut()`, `_rebindShortcut()` | |
| Cycle l.963-1021 | `_rebuild()`, `_teardownUI()`, `destroy()` | `_teardownUI` déconnecte tout, retire du chrome, détruit acteurs (⇒ `ModuleCard._onDestroy` ⇒ `instance.destroy()`) |

Signaux globaux écoutés : `Main.layoutManager 'monitors-changed'`, `global.display 'workareas-changed'`, `panelBox 'notify::height'` ⇒ `_relayout()`.

### `lib/card.js` — `ModuleCard extends St.BoxLayout`
Vertical : `[_editBar (cachée)] + [_body]`. `_body` est un BinLayout : `_shadow` (bloc plein translaté de `shadowOffset`) sous `_frame` (contour `strokeWidth` + fond `cardTint`) qui contient `instance.actor`. La carte pose `margin_right`/`margin_bottom` = décalage pour réserver l'ombre dans la colonne. L'ombre est un acteur et non un `box-shadow` (un box-shadow sur un acteur à image de fond est peint en rectangle). Signaux : `move-requested(±1)`, `stow-requested`, `remove-requested`, `drag-begin`. « Retirer » seulement pour les modules non intégrés.
### `lib/registry.js` — `ModuleRegistry`
- `BUILTINS = [player, tracker, market, todo]` (ordre d'import, pas ordre d'affichage).
- `userModuleDir()` = `~/.config/sidepanel/modules/` (créé si absent).
- `listFiles()` : `.js` du dossier. `loadFile(path)` : `await import('file://…')`, valide `{id, build}`, refuse un id déjà pris par un intégré. `loadAll(paths)` ignore les fichiers disparus.
- Descripteur enregistré = `{...mod, builtin: bool, source: 'intégré' | chemin}`.

### `lib/glass.js`
- `applyBackdropBlur` conservé mais inactif avec les thèmes brutal (`blurSigma: 0`).
- `LiquidBackground extends St.DrawingArea` : aplat **opaque** `base`, formes animées sur surface `DOWNSCALE=6` fois plus petite, timer 20 fps uniquement panneau ouvert. 5 peintres : **`_paintPixel`** (défaut : 14 blocs carrés qui dérivent par pas entiers toutes les `PIXEL_STEP_MS=140` ms, étirés en `Cairo.Filter.NEAREST` ⇒ pixels nets, avec ombre dure d'une cellule), `_paintLiquid`, `_paintOrbs`, `_paintWaves`, `_paintGeometric`. Puis quadrillage de points tous les 12 px si `theme.grid`, reflets si `theme.gloss > 0`, grain si `theme.grain > 0`.
- Paramètres : thème surchargé par `bg-shape`, `bg-speed` (>0), `bg-intensity` (≥0), `bg-colors` (non vide).
### `lib/theme.js`
**Direction artistique : NÉO-BRUTALISME PIXEL, sombre.** Aplats opaques (plus de verre ni de flou), contours 3 px, ombres portées dures (décalage, zéro flou), coins 4–6 px, typographie monospace, titres en capitales. Palette exportée dans `PALETTE` : Space Cadet `#1E223D` (base, `navyLight #2A2F52` surfaces, `navyDeep #12152A` ombres/encre), Gargoyle Gas `#E6D5B7` (texte, contours, `beigeDim` secondaire), Orange `#F54F1B` (accent), rouge `#FF3B3B` (danger).

`THEMES` = `brutal` (défaut, sombre) et `brutal-light` (base beige). Jetons : `radius`, `cardRadius`, `strokeWidth`, `shadow` (ombre dure du panneau), **`shadowOffset`** + **`cardShadow`** (ombre dure des blocs, posée par `ModuleCard` et `cardStyle`), `blurSigma` (0), `base`, `tint`, `stroke`, `innerStroke`, `cardTint`, `cardStroke`, `text`, `textDim`, `textMuted`, `accent`, `accentInk`, `danger`, `blobs`, `blobAlpha`, `speed`, **`grid`** (quadrillage pixel), **`gloss`** (reflets, 0), `grain`, `fontUI`/`fontMono` (monospace partout).

Fabriques : `panelStyle(t)`, `cardStyle(t, {padding, radius, shadow})`, `labelStyle(t, {size, color})`. Pour les modules intégrés : **`MODULE`** (surface, stroke, inset, text, accent, positive/negative, `radius` = 4 px logiques avant facteur k, `strokeWidth` = 2 pour les sous-blocs). Les modules ne dessinent **plus** leur contour externe : c'est `ModuleCard` qui pose cadre et ombre.
### `lib/widgets.js`
Couleurs d'icônes : `beigeDim` au repos, `beige` au survol/focus, `navyDeep` sur bloc orange actif. Courbes : `EASE_OUT_EXPO` pour ce qui arrive, `EASE_OUT_BACK` pour les accents, `EASE_OUT_QUAD` pour les appuis. **`wirePush(button)`** : à l'appui le bouton entier se translate de `PUSH_PX=3` px pendant que le CSS `:active` supprime son ombre dure ⇒ il « s'enfonce » dans son ombre (pastilles, lignes, ＋, boutons d'en-tête). `wirePress()` enfonce en plus l'icône.
- `makeAddButton` (`spSetOpen` ⇒ `.sp-open`, bloc orange, croix à 45°), `makeActionButton` (`spSetActive` ⇒ `.is-pinned`), `makeVectorButton` (barre d'édition, `motion`), `makePill(text, theme, onClick, {variant: ghost|accent|danger})`, `makeRow(text, onClick, {mono})`, `popIn` (glisse depuis la droite), `slideIn`/`slideOut` (volets), `makeButton` (compat, inutilisé).
### `lib/vectorIcons.js`
`ICONS` (tracés de la maquette : `hdr-*`, `plus-circle`, `skip-*`, `podcast`, `repeat`, `headphones`, `pause-bars`, `play-triangle`, `spotify-glyph`) + `OWN_ICONS` (jeu maison `ui-*` : plus, edit, pin, settings, clock, chart, refresh, lock, code, globe, terminal, palette, window, chat, browser, up, down, stow, close, grip, todo, trash). Chaque couple (nom, couleur) est écrit une fois dans `~/.cache/sidepanel/vector-icons/<md5>.svg` puis chargé en `Gio.FileIcon`. API : `vectorIcon(name, hex, size)` → `St.Icon` ; `setVectorIcon(icon, name, hex)` recolore. Une icône inconnue **lève** une exception (module en erreur).

### `lib/keepAwake.js` — `KeepAwake`
Suit la clé `keep-awake`. `_acquire()` prend en parallèle : logind `Inhibit('handle-lid-switch', …, 'block')` (fd gardé ouvert) + gnome-session `Inhibit(flag SUSPEND=4)` (cookie). `_release()` ferme le fd et `Uninhibit`. Compteur `_generation` pour ignorer une réponse arrivée après désactivation. Vérif : `systemd-inhibit --list | grep -i "side panel"`.

### `lib/rewrite.js` — `SmartRewrite`
Créé par `extension.js` à côté de `KeepAwake` (indépendant du panneau). `Main.wm.addKeybinding('rewrite-shortcut')`. Flux : lecture de la sélection PRIMARY (repli CLIPBOARD) → `detectMode` sur le premier caractère (`MODES` : fix, improve `~`, instruct `#`, translate `>xx`, summarize `!`, answer `?` (ajoute sous la question), shell `$`, compute `=`) → POST Groq non-flux (modèle `ai-model`, `reasoning_format: 'hidden'`, retiré si 400) → `stripResult` (balises, tirets longs) → CLIPBOARD + Ctrl+V par `Clutter.VirtualInputDevice` (Ctrl+Maj+V si la fenêtre est un terminal) → restauration du presse-papiers précédent après 1,5 s. **Piège mortel** : `St.Clipboard.get_text()` appelé dans le rappel d'un autre `get_text()` fait segfaulter gnome-shell ; chaque lecture part d'un `GLib.idle_add` (`_readClipboard`). 429 ⇒ attente `retry-after` (2 essais).

### `lib/utils.js`
`timeoutAdd(ms, fn)` / `sourceRemove(id)` (renvoie 0), `clamp`, `lerp`, `ensureDir`, `hashString` (MD5), `formatUs`, `newSession()` (Soup 3, timeout 15 s), `fetchBytes` / `fetchText(session, url, cancellable, headers)`, `rgbToHex`, `extractPastelAccent(path)` (moyenne 24×24 + mix 0.68 vers blanc), `scaleFactor()`, `roundedPath(cr, …)`, classe `Marquee(label)` (défilement d'un titre trop long).

### `modules/player.js` — `PlayerCard`
- Maquette 480×270, `k = moduleWidth/480`. Acteur racine `St.Widget` BinLayout à **taille fixe** (`clip_to_allocation`).
- Couches : `_art` (pochette en `background-image`) → `_scrim` (dégradé sombre horizontal) → `root` (BoxLayout : logo app + pilule sortie audio / titre+artiste + gros bouton lecture / favori + `ProgressLine` + suivant + cast + répétition) → `_deviceOverlay` (sélecteur de sortie).
- D-Bus : `_watchBus()` s'abonne à `NameOwnerChanged` (namespace `org.mpris.MediaPlayer2`) + `ListNames`. Par lecteur : `PlayerProxy` (Metadata, PlaybackStatus, Position, Shuffle, LoopStatus, Seeked) + `AppProxy` (Identity, DesktopEntry ⇒ icône réelle via `Shell.AppSystem`). `_pick()` choisit le lecteur : Playing=4, Paused=2, +8 si le nom contient `preferred-player`.
- `_sync()` met à jour titre/artiste/longueur/icône lecture/loop, lance `_loadArt(url)` (cache `~/.cache/sidepanel/art/<md5>.img`, `file://` direct, http via Soup) ⇒ `_setArtFile()` ⇒ `extractPastelAccent` ⇒ `_applyAccent()` recolore pilule, bouton lecture, barre et icônes du bas.
- Position : timer 1 s (+1 000 000 µs) et vraie lecture D-Bus toutes les 5 s. Seek par clic/glisser sur `ProgressLine` (`SetPosition(trackid, µs)`).
- Sortie audio : `import('gi://Gvc')` dynamique, `Gvc.MixerControl` ; `_setDefaultSink` Gvc puis repli `pactl`.
- Favoris : `Set` de clés `titre—artiste` dans `~/.config/sidepanel/player-favorites.json`.

### `modules/tracker.js` — `TrackerCard`
- Maquette 380 px. Écoute `global.display 'notify::focus-window'` et `win 'notify::title'` (changement d'onglet). Temps mesuré par **horodatage** (`GLib.get_monotonic_time`) à chaque changement, pas par tick ⇒ ne compte pas la veille ; ignoré si inactivité > `IDLE_THRESHOLD=180` s (`get_core_idle_monitor`).
- Données `_apps: Map<appId, {name, seconds, titles:{titre: secondes}}>`, journée courante seulement (`_rolloverIfNeeded`). Sauvegarde `~/.config/sidepanel/timetracker.json` toutes les 30 s si dirty, à la fermeture, à la destruction.
- Affichage : total du jour, 3 lignes (`VISIBLE_ROWS`) + « Voir plus », barre = part de l'app dans le total, sous-éléments (3 titres de fenêtre) dépliés au survol (hauteur animée). Couleur/icône par `SIGNATURES` (regex sur appId/nom) sinon `FALLBACKS` par hash.
- Le timer de rafraîchissement (1 s) ne tourne que panneau ouvert.

### `modules/market.js` — `MarketCard`
- Maquette 380 px. `ASSETS` = BTC, ETH, SPY, SNP (symboles Yahoo `BTC-USD`, `ETH-USD`, `SPY`, `^GSPC`). `TIMEFRAMES` 24H/7D/30D ⇒ `YAHOO_TIMEFRAME` (range/interval).
- Prix : `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=&interval=` avec `User-Agent` navigateur obligatoire. `_cache[token][timeframe] = {price, changePct, changeAbs, series}`. `_refreshPrice(force)` + préchargement des autres fenêtres ; `_fetchGen` invalide les réponses tardives.
- Actualités : `https://news.google.com/rss/search?q=<newsQuery>&hl=fr-FR…`, `_parseRss` par regex, 6 titres, bandeau qui défile (`NEWS_ROTATE_MS=3500`, clone du premier à la fin pour boucler) ou liste dépliée (« Tout afficher »). Clic ⇒ `Gio.AppInfo.launch_default_for_uri`.
- `MarketChart extends St.DrawingArea` : spline Catmull-Rom → Bézier + aire dégradée, vert `#32d74b` / rouge `#ff453a` selon le signe.
- Racine BinLayout pour superposer le menu déroulant d'actif (`_menuWrap`).
- Timers (prix 120 s, news 300 s, rotation) uniquement panneau ouvert.

### `modules/todo.js` — `TodoCard`, `TodoRow`, `TodoCheckbox`
- Maquette 390 px. `St.Entry` + bouton « ＋ » dégradé bleu (pivote au survol). **Clic sur l'entrée ⇒ `panel.enterEditMode(entry.clutter_text)`**, `onClose` ⇒ `panel.leaveEditMode()`.
- `_tasks: [{id, text, completed, time}]` dans `~/.config/sidepanel/todos.json`. Tri : actives d'abord, puis terminées de la plus récente à la plus ancienne. Au-delà de `MAX_COMPLETED=2` terminées, la plus ancienne disparaît (`row.disappear()`).
- Liste dans un `St.ScrollView` dont la hauteur = contenu plafonné à 300 px logiques (`_updateListHeight` ⇒ `panel.requestRelayout()`).
- `TodoCheckbox` : rebond en 4 temps + onde blanche (`_shine`). Tout en `ease()`.

### `modules/assistant.js` — `AssistantCard`
- Maquette 380 px. Chat éphémère (`MAX_TURNS=3`, rien sur disque). Requêtes `POST api.groq.com/openai/v1/chat/completions` en flux SSE (`send_async` + `DataInputStream.read_line_async`), `reasoning_format: 'hidden'` (Qwen3). **Toujours `msg.status_code`, jamais `get_status()`** : un code hors énumération (429) fait lever GJS. 429 ⇒ attente `retry-after` puis nouvel essai (2 max). Les corps de réponse sont fermés après lecture (sinon les connexions Soup s'épuisent et la requête suivante attend indéfiniment).
- Boucle d'outils (`_converse`, `MAX_ROUNDS=8`) : `list_dir` (Gio, noms + tailles, jamais le contenu), `find_path` (`find` avec élagage), `run_inspect` (liste blanche `INSPECT_ALLOWED`, sous-commandes git en lecture, refus des redirections et de la lecture de fichiers), `web_search` (RSS Bing, seulement si le globe est actif). Qwen écrit parfois l'appel en XML `<tool_call>` dans le texte : `parseInlineToolCalls` le récupère.
- Contexte (`_captureFocus`, mémorisé avant le grab modal) : fenêtre au premier plan terminal ⇒ cwd du shell le plus récent (`/proc/<pid>/cwd`), commandes en cours (enfants du shell), 8 dernières lignes d'historique ; gestionnaire de fichiers ⇒ titre de fenêtre résolu en chemin par `find`. Sinon rien. Affiché sur la ligne `▸ kitty · ~/…`.
- Rendu : `splitSegments` (blocs ```), `mdToMarkup` (gras, code, puces) ; chaque bloc shell ⇒ `_commandRow` (clic texte = copie, flèche = `_runInTerminal`). `DANGEROUS` ⇒ bordure rouge, collée sans Entrée. Collage : activation de la fenêtre, `close(true)`, puis Ctrl+Maj+V (+ Entrée) par `Clutter.VirtualInputDevice` ; sans terminal, lancement (`TERMINAL_LAUNCH`, clé `ai-terminal`) dans le dossier de contexte.
- Pièges rencontrés : un `St.ScrollView` caché à la construction est mesuré à 0 à son premier affichage (la liste reste donc toujours visible, hauteur 0 quand vide) ; un tick de rendu « en flux » en retard écrasait le rendu final (`entry.done`).
- Quota Groq du compte : **8 000 jetons/min** sur tous les modèles de chat ⇒ résultats d'outils plafonnés (`TOOL_OUTPUT_CAP`), pas d'arborescence statique dans le prompt.

### `prefs.js` — 4 pages Adw
Style (thème, flou expérimental, ouvrir `theme.js`) · Fond animé (forme, vitesse, intensité, 4 couleurs `Gtk.ColorDialogButton`) · Panneau (largeur, marge, hauteur max, espacement, survol, zone, délai, animation, rebond, keep-awake, raccourci validé par `Gtk.accelerator_parse`) · Modules (ouvrir dossier, ordre/bibliothèque en lecture seule, **réinitialiser ⇒ `module-order=['player']`**, largeur du lecteur, lecteur prioritaire).

### `stylesheet.css`
Entièrement sur la palette brutal (valeurs codées en dur : le CSS ne lit pas le thème). Grammaire : contour 3 px beige, `box-shadow: 3px 3px 0px 0px` (dur), coins 4 px, monospace gras ; `:active` retire l'ombre. Composants : `.sp-header-bar/.sp-header-name/.sp-header-rule`, `.sp-hdr-add(.sp-open)`, `.sp-hdr-act(.is-pinned)`, `.sp-pill` / `.sp-pill-accent` / `.sp-pill-danger`, `.sp-row`, `.sp-vec-btn(.sp-vec-on)`, `.sp-editbar`, `.sp-edge`, barre de défilement (poignée carrée beige, orange au survol), `.sp-entry`, bloc compat.
---

## 5. Contrat d'un module (intégré ou importé)

```js
export default {
    id: 'mon-module',          // unique ; ne peut pas doubler un intégré
    title: 'Mon module',       // affiché dans la barre d'édition et la bibliothèque
    icon: 'starred-symbolic',  // déclaré mais pas utilisé aujourd'hui par le panneau
    build(ctx) {
        // ctx = {St, Clutter, GLib, Gio, api, theme, settings, panel, extension, moduleWidth, style, utils}
        return {
            actor,            // OBLIGATOIRE — acteur St racine
            setTheme(t) {},   // optionnel
            onOpen() {},      // optionnel — démarrer timers / requêtes
            onClose() {},     // optionnel — les arrêter
            destroy() {},     // optionnel — libérer TOUT (timers, D-Bus, Soup, signaux globaux)
        };
    },
};
```

Conventions observées dans les 4 intégrés (à reproduire) :
- Classe `XxxCard` avec `this.actor`, `this._destroyed`, `this._px`, `this._jsx`.
- Largeur : `logicalWidth = ctx.moduleWidth`, `k = logicalWidth / DESIGN_WIDTH`.
- Tous les callbacks asynchrones (timers, D-Bus, Soup) testent `this._destroyed` avant de toucher aux acteurs.
- Un compteur de génération (`_fetchGen`, `_newsGen`, `_generation`) invalide les réponses arrivant après un changement d'état.
- Persistance : `~/.config/sidepanel/<nom>.json` via `GLib.file_set_contents` (+ `ensureDir`).
- Une carte dont la hauteur change appelle `ctx.panel.requestRelayout()`.
- Un module avec `St.Entry` appelle `ctx.panel.enterEditMode(entry.clutter_text)` au clic.
- Les modules importés sont chargés par `import()` : un fichier utilisateur peut donc importer `gi://…` mais **pas** `../lib/…` (chemin relatif à `~/.config`, pas à l'extension). Il reçoit ce dont il a besoin via `ctx`.

---

## 6. Règles et pièges GJS / St / Clutter (lois du projet)

1. **Deux facteurs d'échelle, jamais confondus** (`player.js` l.3-20) :
   - `k` = proportion du design (maquette → largeur réelle). S'applique à **tout**.
   - `s = scaleFactor()` = HiDPI. GNOME multiplie déjà les px du **CSS** et `icon_size` par `s`, mais **pas** les propriétés d'acteur (`width`, `height`, `set_size`, `translation_*`).
   - Donc `px(v) = v*k` pour le CSS / icon_size, `jsx(v) = v*k*s` pour les propriétés d'acteur. Cairo dessine en pixels de périphérique ⇒ `k*s` aussi.
2. **St n'anime rien en CSS** sauf `transition-duration` entre pseudo-classes (`:hover`, `:active`, `:focus`). Pas de `transition`, `@keyframes`, `transform`. Tout mouvement = `actor.ease({…, duration, mode: Clutter.AnimationMode.X})`. Toujours `remove_all_transitions()` avant un nouvel `ease` sur le même acteur.
3. **CSS St limité** : pas de `linear-gradient(135deg)` (seulement `background-gradient-direction: vertical|horizontal|radial` + `-start`/`-end`), pas de `border-radius: 50%` (pixels), pas de `backdrop-filter`, pas de `opacity`/`scale` en CSS (propriétés d'acteur). `box-shadow` est peint en **rectangle** ⇒ coins noirs sur un acteur arrondi : ne pas l'utiliser sur une carte.
4. **Animer l'icône, pas le bouton** : un `scale` Clutter ne change pas l'allocation ⇒ un bouton agrandi déborde sur ses voisins.
5. **Noms de propriétés** : dans une classe `GObject.registerClass`, `this.fooBar = …` devient la propriété GObject `foo-bar` ; collision avec `ClutterActor` (`content`, `size`, `name`, `style`, `position`…) ⇒ crash. Préfixer par `_`.
6. **Saisie clavier** : sans `Main.pushModal`, aucune touche n'atteint le shell. Passer par `panel.enterEditMode()` / `leaveEditMode()`.
7. **St.Button** n'a pas de signaux `pressed`/`released` : utiliser `button-press-event` / `button-release-event` (et renvoyer `Clutter.EVENT_PROPAGATE` pour que `clicked` arrive).
8. `enter-event` / `leave-event` / `notify::hover` exigent `reactive: true` (+ `track_hover: true`).
9. **Alignement** : pour aligner à gauche/droite de façon fiable, utiliser un `St.BoxLayout` avec un espaceur `x_expand`, pas `x_align` sur un enfant de `BinLayout` (constaté non respecté).
10. **Timers** : `GLib.timeout_add` via `timeoutAdd`, renvoyer `GLib.SOURCE_CONTINUE` / `SOURCE_REMOVE`, stocker l'id, libérer avec `sourceRemove` (qui renvoie 0). Aucun timer ne doit tourner panneau fermé (fond animé, position du lecteur, tracker, market).
11. **Repaint Cairo** : une exception dans un handler `repaint` répétée peut tuer le shell ⇒ try/catch et arrêt de l'animation. Toujours `cr.$dispose()`.
12. **Imports** : tout identifiant utilisé doit être importé (un oubli met l'extension en ERROR au chargement, sans message clair). Lancer `python3 check-imports.py` après chaque modification.
13. `prefs.js` tourne dans un **autre processus** : aucun `St`, `Clutter`, `Shell`, `Main`. Ne partager que `lib/theme.js`.
14. **Fichier vs `background-image`** : mettre une image en `background-image` sur un acteur libre fait remonter la taille de l'image comme taille minimale ⇒ le lecteur verrouille sa taille (`width/height` fixes + `clip_to_allocation`).
15. Les logs : `console.log/warn/error` préfixés `[sidepanel]`, lus avec `journalctl -b -o cat /usr/bin/gnome-shell | grep -i sidepanel`.
16. **Largeur naturelle et `letter-spacing`** : St mesure un label SANS le letter-spacing que Pango applique ensuite ; un label laissé à sa largeur naturelle avec `ellipsize: END` s'ellipse alors d'un pixel (« LECTEU… »). Pas de letter-spacing sur un label non étiré, ou lui donner une largeur.
17. **Défilement (Marquee)** : `St.Label` ellipse par défaut ; pour faire défiler un titre, mettre `ellipsize: NONE` ET placer le label dans une boîte dont `vfunc_get_preferred_width` renvoie `[0, 0]` (voir `ClipBox` dans player.js), sinon la boîte réclame la largeur du texte et rien n'est découpé.
18. **Centrer un texte dans un label étiré** : `set_line_alignment(CENTER)` n'agit que si la mise en page Pango a une largeur, ce qu'un `ellipsize` impose (voir les cases du calendrier).
19. **Contenu qui change panneau ouvert** : toujours `_relayout({animate: true})` (hauteur et ordonnée glissent, haut ancré) — un `set_size` sec fait sauter tout le panneau.
20. **Courbes** : `EASE_OUT_CUBIC` 400–600 ms pour ce qui arrive ; `EASE_OUT_EXPO`/`QUART` jouent 90 % du mouvement dans les 150 premières ms et paraissent secs.
21. **Presse-papiers** : ne jamais appeler `St.Clipboard.get_text()` depuis le rappel d'un autre `get_text()` (segfault de gnome-shell, reproduit) ; enchaîner via `GLib.idle_add`. Le clavier virtuel Clutter (`seat.create_virtual_device`) fonctionne, mais dans le shell imbriqué il est de type X11 et tape dans la session HÔTE.
22. **`font-family`** : St refuse une liste de familles entre guillemets (`'Inter', 'Cantarell'`) et ignore alors toute la propriété (`St-WARNING: Couldn't parse family in font property`). Écrire les noms nus : `Inter, Cantarell, sans-serif`.

---

## 7. Clés GSettings (`schemas/…gschema.xml`)

| Clé | Type / défaut | Effet | Réaction dans panel.js |
|---|---|---|---|
| `theme` | s `'brutal'` | id dans `THEMES` | RESTYLE |
| `backdrop-blur` | b `false` | Shell.BlurEffect (instable) | RESTYLE |
| `bg-shape` | s `'pixel'` | pixel/liquid/orbs/waves/geometric | RESTYLE |
| `bg-speed` | d `0` (0 = thème) | vitesse du fond | RESTYLE |
| `bg-intensity` | d `-1` (<0 = thème) | alpha des formes | RESTYLE |
| `bg-colors` | as `[]` | 4 hex, vide = thème | RESTYLE |
| `panel-width` | i `288` | largeur logique | STRUCTURAL |
| `panel-margin` | i `18` | marge au bord | STRUCTURAL |
| `panel-max-height` | i `820` | plafond de hauteur | lu à `_relayout()` |
| `edge-width` | i `8` | zone de survol | STRUCTURAL |
| `card-spacing` | i `12` | spacing de `_stack` | STRUCTURAL |
| `player-width` | i `240` | repli si `ctx.moduleWidth` absent (le lecteur suit un ratio 480:300) | STRUCTURAL |
| `player-height` | i `225` | **plus lu nulle part** (hauteur dérivée du ratio 480:270) | STRUCTURAL |
| `hide-delay` | i `420` ms | délai avant fermeture | lu à chaque `_scheduleHide` |
| `animation-duration` | i `460` ms | ouverture (fermeture = 55 %) | lu à chaque `open` |
| `bounce` | b `true` | EASE_OUT_BACK vs EASE_OUT_EXPO | lu à chaque `open` |
| `show-on-hover` | b `true` | ouverture par le bord | lu au survol |
| `keep-awake` | b `false` | verrous logind + gnome-session | `KeepAwake` + pastille du bouton |
| `toggle-panel` | as `['<Super>p']` | raccourci | `_rebindShortcut()` |
| `preferred-player` | s `'spotify'` | bonus +8 dans `_pick()` | lu à chaque `_pick` |
| `view-mode` | s `'stack'` | `stack` (cartes) ou `grid` (tuiles façon téléphone) | STRUCTURAL |
| `weather-location` | s `'Paris'` | ville du module météo | lu par weather.js (signal `changed::weather-location`) |
| `ai-api-key` | s `''` | clé Groq Cloud | lue par assistant.js à chaque requête |
| `ai-model` | s `'qwen/qwen3.8-27b'` | modèle de chat (badge cliquable dans la carte) | lue à chaque requête |
| `rewrite-shortcut` | as `['<Control>m']` | raccourci de réécriture de la sélection | `SmartRewrite._rebind()` |
| `ai-terminal` | s `''` | terminal à lancer si aucun n'est ouvert (vide = kitty, gnome-terminal, ptyxis…) | lue à `_spawnTerminal` |
| `module-order` | as `[player, tracker, market, todo, sysmon, weather, calendar, launcher, assistant]` | modules affichés, dans l'ordre | STRUCTURAL |
| `module-hidden` | as `[]` | rangés dans la bibliothèque | STRUCTURAL |
| `module-paths` | as `[]` | scripts importés (chemins absolus) | lu au démarrage |

Lecture rapide en shell : `gsettings --schemadir ~/.local/share/gnome-shell/extensions/sidepanel@fgaudioso.dev/schemas get org.gnome.shell.extensions.sidepanel module-order`.

---

## 8. Données sur disque

| Chemin | Écrit par | Contenu |
|---|---|---|
| `~/.config/sidepanel/modules/*.js` | utilisateur / `_adoptFile` / `_copyExamples` | scripts de modules importables |
| `~/.config/sidepanel/player-favorites.json` | player | tableau de clés `titre—artiste` |
| `~/.config/sidepanel/timetracker.json` | tracker | `{day, apps:{id:{name, seconds, titles}}}` (journée courante) |
| `~/.config/sidepanel/todos.json` | todo | `[{id, text, completed, time}]` |
| `~/.config/sidepanel/quicknote.json` | examples/quicknote | `{text}` |
| `~/.cache/sidepanel/weather.json` | weather | dernière réponse Open-Meteo |
| `~/.cache/sidepanel/art/<md5>.img` | player | pochettes téléchargées |
| `~/.cache/sidepanel/vector-icons/<md5>.svg` | vectorIcons | une icône par (nom, couleur) |

Réseau sortant : Yahoo Finance (`query1.finance.yahoo.com`), Google News RSS (`news.google.com`), Open-Meteo (`geocoding-api.open-meteo.com`, `api.open-meteo.com`), Groq (`api.groq.com`, assistant), Bing RSS (`www.bing.com`, assistant en mode web), URLs `mpris:artUrl` http(s) des lecteurs. Rien d'autre.

---

## 9. Dettes et incohérences connues (état au 2026-09-15, après la refonte « brutal pixel »)

À connaître avant de « corriger » quelque chose, ou à traiter si on approfondit :

- **README obsolète** : titre « v2.4 » (dossier `sidepanel-v4.2`, `metadata.version=2`), dit « un seul module fourni (le lecteur) » alors qu'il y en a 4, dit 30 fps alors que `FRAME_MS=50` (20 fps), décrit une pilule « périphérique audio » sans mentionner le sélecteur de sortie.
- `prefs.js` borne `panel-width` à 280 min alors que le schéma autorise 220.
- `player-height` (schéma + prefs description) n'est plus lu ; la hauteur découle de `player-width` × 270/480.
- `descriptor.icon` n'est affiché qu'en mode applis (tuiles) ; la bibliothèque et le picker restent textuels. Un nom `ui-*`/`hdr-*` passe par `vectorIcon`, tout autre nom par `St.Icon` (icône du thème GNOME).
- Code mort : `makeButton` (fabrique de compatibilité, jamais appelée), `formatUs`, `lerp` ; bloc « compat » en fin de `stylesheet.css` (classes que seul `makeButton` produit).
- `modules/market.js` l.30 renvoie à un `SKILL.md` qui n'existe pas (la règle « deux facteurs d'échelle » est en tête de `player.js` et en §6 ici).
- Les modules intégrés ignorent le thème (`setTheme` vide) : ils sont dessinés sur `MODULE`/`PALETTE` (nuit/beige/orange) quel que soit le thème choisi ; `brutal-light` ne change donc que le panneau autour.
- Le `box-shadow` dur du panneau (`theme.shadow`) est peint par St hors de l'allocation. Si des artefacts apparaissent, mettre `shadow: null` dans le thème.
- Les anciens thèmes verre (`liquid`, `mercury`, `aurora`, `obsidian`, `neo`) ont été retirés ; un réglage `theme` obsolète retombe sur `brutal` via `getTheme()`.
- Pas de tests ; la seule vérification automatique est `check-imports.py`.
- Pas de dépôt git dans ce dossier.

---

## 10. Boucle de développement

```bash
./install.sh                                  # rsync + glib-compile-schemas
# X11 : Alt+F2 → r → Entrée   |   Wayland : se déconnecter/reconnecter
gnome-extensions enable sidepanel@fgaudioso.dev
gnome-extensions info sidepanel@fgaudioso.dev  # état / erreur
journalctl -f -o cat /usr/bin/gnome-shell | grep -i sidepanel
gnome-extensions prefs sidepanel@fgaudioso.dev
python3 check-imports.py                       # avant chaque rechargement
```

Un changement dans `schemas/*.xml` exige la recompilation (`install.sh` le fait). Un changement dans `lib/`, `modules/`, `stylesheet.css` exige le rechargement du shell ; un script dans `~/.config/sidepanel/modules/` se recharge seulement en le retirant puis en le réimportant via ＋ (les modules `import()`és sont mis en cache par GJS jusqu'au redémarrage du shell).

**Tester EN VOYANT le rendu (obligatoire avant de livrer un changement visuel)** : `tools/nested-unsafe.sh` lance un shell imbriqué en `--unsafe-mode` et écrit l'adresse de son bus dans `.run/nested.bus` ; ensuite `tools/panel.sh 'p.open(); p.setPinned(true);'` pilote le panneau (`p` = SidePanel), `tools/ev.sh 'code'` évalue du JS, `tools/shot.sh nom` capture un PNG (`shots/nom.png`) à regarder avec l'outil Read. Séquence type : ouvrir, capturer, `p._openTile(id, p._tiles.find(t => t._spId === id))`, capturer à 100/250/400 ms, `p._closeFocus()`. `tools/fake-mpris.py .run/nested.bus [image]`. Le lanceur retrouve seul le fichier `.mutter-Xwaylandauth.*` courant ; `tools/nested.bus` est un lien vers `.run/nested.bus` (ne pas le supprimer après le lancement). Tuer l'ancien shell avec `pkill -f "^gnome-shell --nested"` (motif ancré, sinon la commande bash qui le contient se tue elle-même). En mode applis, atteindre un module par `p._gridCards.get(id)._instance` après `_openTile` ; en mode pile, `p._cards[i]._instance` publie un faux lecteur `org.mpris.MediaPlayer2.spotify` sur le bus imbriqué (le vrai Spotify est sur le bus principal, invisible ici) : pochette, titre long, position qui avance, réponses à PlayPause/Next/Shuffle/LoopStatus/SetPosition. Les horodatages des captures sont décalés d'environ 100 ms par la latence D-Bus.

**Tester sans se déconnecter (Wayland)** : `../nested-shell.sh` (à côté du dossier de l'extension) lance un GNOME Shell imbriqué dans une fenêtre, avec un environnement nettoyé (le snap VS Code casse `gnome-shell --nested`). Il lit le même dconf : l'extension y est active si elle l'est dans la session principale. Rediriger sa sortie vers un fichier et y chercher `sidepanel`, `JS ERROR`, `St-WARNING`. Bruit connu : `TodoRow … not in the stage`, GTop, meta-barrier, Astra Monitor.

---

## 11. Pistes d'approfondissement (pour la suite)

Non faites, listées pour orienter le travail à venir sans rien décider :

- Faire suivre le thème aux modules intégrés (utiliser `ctx.theme` / `setTheme`).
- Afficher `descriptor.icon` dans la bibliothèque et le picker.
- Nettoyer §9 (README, reset, code/CSS mort, `player-height`).
- Écran de verrouillage : le panneau est détruit et reconstruit, donc les modules perdent leur état en mémoire (le tracker sauvegarde avant).
- Tests : un harnais minimal pourrait charger `lib/theme.js`, `utils.js` (parties sans GI) sous `gjs -m`.
- Extraire une API stable pour les modules tiers (versionner `ctx`).
