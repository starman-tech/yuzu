---
name: yuzu-module
description: Écrire un module fonctionnel, dans le style « néo-brutalisme pixel », pour l'extension GNOME Shell « Yuzu » (yuzu-plus@starman-tech.github.io). À charger dès qu'on demande une carte, un widget ou un module pour ce panneau.
---

# Skill : écrire un module Yuzu

Tu vas produire **un seul fichier `.js`** (ESM, GJS) que l'utilisateur dépose dans
`~/.config/yuzu/modules/` puis importe avec le bouton « ＋ » du panneau.
Aucune réinstallation de l'extension, aucun rechargement du shell.

Le fichier doit être **complet, autonome et fonctionnel du premier coup**. Pars
TOUJOURS de `TEMPLATE.js` (à côté de ce fichier) : il contient les helpers
(px/jsx, timers, fetch Soup, persistance JSON, sous-processus, pilules) qu'un
module importé ne peut pas obtenir autrement. Ne réécris pas ces helpers de tête.

Tout est **en français** : commentaires, libellés, messages d'erreur.

---

## 0. Ce que tu dois savoir avant d'écrire

**Environnement** : GJS (JavaScript ESM dans le processus gnome-shell 46+). Pas de
Node, pas de npm, pas de DOM, pas de HTML/CSS classique. L'UI est faite d'acteurs
**St** (widgets) et **Clutter** (scène, animations). Le CSS est le sous-ensemble
très limité de St, posé par `actor.set_style('…')` ou `style_class`.

**Un module importé ne peut PAS faire `import '../lib/…'`** : son chemin est
`~/.config`, pas l'extension. Il peut importer `gi://St`, `gi://Clutter`,
`gi://GLib`, `gi://Gio`, `gi://Soup?version=3.0`, `gi://Pango`,
`gi://GObject`, `gi://Shell`, `gi://Meta`, et `resource:///org/gnome/shell/ui/main.js`.
Tout le reste (thème, helpers) est soit dans `ctx`, soit recopié dans le fichier.

**Deux processus** : ton module tourne dans gnome-shell. Jamais de Gtk, Adw, Gdk.

**Les classes CSS globales de l'extension sont disponibles** pour tes acteurs
(la feuille est chargée dans le shell) : `sp-pill`, `sp-pill-accent`,
`sp-pill-danger`, `sp-row`, `sp-entry`. Elles donnent gratuitement le bon style
brutal (contour 3 px, ombre dure 3 px, `:hover`/`:active` animés).

---

## 1. Contrat (obligatoire)

```js
export default {
    id: 'mon-module',        // unique, kebab-case ; ne doit pas être un id intégré :
                             // player, tracker, market, todo, sysmon, weather, calendar, launcher, assistant
    title: 'Mon module',     // barre d'édition + bibliothèque (affiché en CAPITALES)
    short: 'Mon mod.',       // optionnel : libellé court sous la tuile en mode « applis »
    icon: 'ui-globe',        // voir §4 ; sinon un nom d'icône du thème GNOME
    build(ctx) {
        // ctx = {St, Clutter, GLib, Gio, api, theme, settings, panel, extension, moduleWidth, style, utils}
        return {
            actor,           // OBLIGATOIRE : acteur St racine (généralement un St.BoxLayout vertical x_expand)
            setTheme(t) {},  // optionnel — le thème a changé
            onOpen() {},     // optionnel — panneau ouvert : DÉMARRER timers / requêtes
            onClose() {},    // optionnel — panneau fermé : ARRÊTER tout timer
            destroy() {},    // optionnel — libérer TOUT (timers, Soup, D-Bus, signaux global.*)
        };
    },
};
```

Cycle de vie : `build()` une fois par (re)construction du panneau → `onOpen()` /
`onClose()` à chaque ouverture / fermeture → `destroy()` lors d'un changement
structurel (largeur, ordre des modules…), de l'écran de verrouillage ou de la
désactivation. `build()` peut donc être appelé plusieurs fois par session :
**ne garde aucun état global au niveau du fichier** qui ne soit pas idempotent.

`ctx` en détail :
- `moduleWidth` : largeur logique (px avant HiDPI) disponible pour ton acteur.
- `theme` : jetons du thème actif (`text`, `textDim`, `textMuted`, `accent`, `accentInk`, `danger`, `cardTint`, `cardStroke`, `innerStroke`, `cardRadius`, `strokeWidth`, `fontMono`, …).
- `settings` : le `Gio.Settings` de l'extension (lecture seule pour toi ; tu ne peux pas y ajouter de clé, persiste dans un JSON).
- `panel` : `requestRelayout()`, `enterEditMode(clutterText)`, `leaveEditMode()`, `close(true)`, `open()`, `setPinned(bool)`.

Si `build()` lève une exception, le panneau affiche une carte d'erreur rouge :
c'est toléré mais c'est un échec. Valide tout ce qui peut manquer.

---

## 2. Style : NÉO-BRUTALISME PIXEL (non négociable)

La **carte** (contour épais 3 px beige + ombre dure décalée) est dessinée **par le
panneau autour de ton acteur**. Toi, tu ne dessines que la SURFACE intérieure.
Donc : **jamais de contour externe, jamais d'ombre sur l'acteur racine.**

Palette (valeurs à utiliser telles quelles, via l'objet `MODULE` du template) :

| Jeton | Hex | Usage |
|---|---|---|
| `surface` | `#2A2F52` | fond de ton acteur racine |
| `surfaceStrong` | `#12152A` | fond très sombre (encre, zones actives) |
| `inset` | `#1E223D` | fond des sous-blocs (jauges, champs, lignes) |
| `insetHover` | `#343A63` | survol d'un sous-bloc |
| `stroke` | `#E6D5B7` | contour beige fort |
| `strokeSoft` | `#3B4170` | contour discret des sous-blocs |
| `text` | `#E6D5B7` | texte principal |
| `textDim` | `#B8AA8F` | texte secondaire, titres de section |
| `textMuted` | `#8F846F` | texte atténué |
| `accent` | `#F54F1B` | UNIQUE couleur d'action (orange) |
| `accentInk` | `#12152A` | encre posée sur un bloc orange |
| `danger` | `#FF3B3B` | erreurs |
| `radius` | `4` | px logiques, à passer dans `px()` |
| `strokeWidth` | `2` | contour des sous-blocs |

Grammaire visuelle :
- **Aplats opaques.** Aucun dégradé décoratif, aucune transparence de fond, aucun flou, aucun « verre ».
- **Coins 3–4 px** (`px(MODULE.radius)`), jamais ronds, jamais `50%`.
- **Sous-blocs** = fond `inset` + `border: 2px solid strokeSoft` + coins 3 px. Un sous-bloc actif/sélectionné = fond `accent` + texte `accentInk`.
- **Ombres dures seulement** sur les boutons (`box-shadow: 3px 3px 0px 0px #12152A`), via les classes `sp-pill*`. Jamais de flou.
- **Typographie monospace partout** (la police est héritée du panneau, ne la redéfinis pas), **titres de section en CAPITALES**, `font-weight: bold`, `letter-spacing: 1px` UNIQUEMENT sur un label étiré (`x_expand: true`), jamais sur un label libre (bug d'ellipse d'un pixel).
- **Tailles de la maquette** (largeur 380) : titre de section 13 px bold `textDim`, valeur forte 13 px bold `accent`, texte courant 12–13 px `text`, détail 11 px `textMuted`, padding racine 20, spacing 14 entre sections, 6 dans une section.
- **Un seul accent orange par carte** (une valeur, une jauge, un bouton principal). Le reste est beige/nuit. Une saturation ou une alerte ⇒ le bloc passe au beige plein ou au rouge `danger`, pas à une nouvelle couleur.
- **Animations** : `EASE_OUT_EXPO` 400–500 ms pour ce qui arrive ou grandit, `EASE_OUT_BACK` 240 ms pour un accent (apparition d'un badge), `EASE_OUT_QUAD` 120–140 ms pour ce qui disparaît. Toujours `remove_all_transitions()` avant un nouvel `ease` sur le même acteur.
- Pas d'emoji dans les titres ; un glyphe unicode simple (`↑`, `·`, `—`, `▸`) est accepté dans une valeur.

En-tête type d'un module (reproduis-le) :

```
[ TITRE EN CAPITALES (textDim, x_expand) ]        [ badge inset : « ↑ 3j 4h » ]
```

---

## 3. Lois GJS / St / Clutter (chaque violation = module cassé)

1. **Deux facteurs d'échelle** : `k = moduleWidth / 380` (proportion) et `s = scaleFactor()` (HiDPI). Le **CSS** et `icon_size` sont déjà multipliés par `s` par GNOME, **pas** les propriétés d'acteur (`width`, `height`, `set_size`, `translation_*`). Donc `px(v) = v*k` pour le CSS, `jsx(v) = v*k*s` pour les propriétés d'acteur. Le template fournit les deux.
2. **St n'anime rien en CSS** (pas de `transition`, `@keyframes`, `transform`). Tout mouvement = `actor.ease({...})`.
3. **CSS St limité** : `background-gradient-direction: vertical|horizontal` + `-start/-end` seulement ; pas d'`opacity`, `scale`, `backdrop-filter`, `border-radius: 50%`, `display`, `flex`, `position`. Une `font-family` avec des guillemets est **ignorée en bloc**.
4. **Noms de propriétés** dans une classe `GObject.registerClass` : `this.content`, `this.name`, `this.size`, `this.style`, `this.position` **écrasent ClutterActor et plantent**. Préfixe tout par `_`. Évite de toute façon `registerClass` : une classe JS ordinaire qui possède `this.actor` suffit.
5. **Clavier** : sans grab modal, aucune touche n'atteint le shell. Tout `St.Entry` doit appeler `panel.enterEditMode(entry.clutter_text)` sur `button-press-event`, et `panel.leaveEditMode()` dans `onClose()` et sur Échap.
6. **St.Button** n'a pas `pressed`/`released` : utilise `clicked`, ou `button-press-event`/`button-release-event` en renvoyant `Clutter.EVENT_PROPAGATE`.
7. `enter-event`/`leave-event`/`notify::hover` exigent `reactive: true, track_hover: true`.
8. **Alignement** : pour pousser à droite, un `St.BoxLayout` horizontal avec un enfant `x_expand: true` avant. Pas de `x_align` sur un enfant de BinLayout.
9. **Timers** : `GLib.timeout_add`, renvoyer `GLib.SOURCE_CONTINUE`/`SOURCE_REMOVE`, stocker l'id, libérer avec `sourceRemove()` (renvoie 0). **Aucun timer ne tourne panneau fermé** : démarrer dans `onOpen()`, arrêter dans `onClose()` ET `destroy()`.
10. **Tout callback asynchrone** (timer, fetch, sous-processus, D-Bus) teste `this._destroyed` avant de toucher un acteur. Un compteur de génération (`this._gen++` à chaque nouvelle requête) invalide les réponses tardives.
11. **Contenu dont la hauteur change** panneau ouvert ⇒ `panel.requestRelayout()` après la modification (le panneau glisse à la nouvelle hauteur).
12. **Boutons à texte** : le texte d'un `St.Button({label})` est un `Clutter.Text` (pas un `St.Label`) : `button.get_child().ellipsize`. Les classes `sp-pill*` ont un `letter-spacing`, donc un bouton laissé à sa largeur naturelle s'ellipse d'un pixel (« ACTUALISE… ») : toujours `Pango.EllipsizeMode.NONE` sur une pilule (le helper `_pill` le fait).
13. **Labels** : `St.Label` ellipse par défaut ; pour un texte multi-ligne, `label.clutter_text.line_wrap = true; label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE`. Pour centrer un texte dans un label étiré, garder un `ellipsize` et `set_line_alignment(Pango.Alignment.CENTER)`.
14. **Réseau** : Soup 3 uniquement via le helper `fetchText` du template. Toujours un `User-Agent`. Toujours lire `msg.status_code` (jamais `get_status()` sur un code inconnu comme 429 : GJS lève). Une erreur réseau ⇒ afficher `—` ou un message discret `textMuted`, jamais une exception non attrapée.
15. **Sous-processus** : `Gio.Subprocess` avec un `argv` tableau (jamais une chaîne shell), `communicate_utf8_async`, timeout via `GLib.timeout_add` + `force_exit()`. Vérifie que le binaire existe (`GLib.find_program_in_path`) et affiche « <outil> introuvable » sinon. Commandes en lecture seule uniquement, jamais `sudo`.
16. **Cairo** (`St.DrawingArea`) : le handler `repaint` est enveloppé dans try/catch, dessine en `k*s`, et termine par `cr.$dispose()`.
17. **Logs** : `console.log/warn/error('[yuzu] …')`. Jamais de `print`.
18. **Pas de `await` au niveau module**, pas d'accès réseau ni de sous-processus dans `build()` : `build()` construit l'UI et charge le cache disque ; le premier chargement se fait dans `onOpen()`.
19. **Pas de Web API** : pas de `fetch`, `setTimeout`, `setInterval`, `localStorage`, `document`, `window`. (`TextDecoder`/`TextEncoder` existent.)

---

## 4. Icônes

`icon` accepte un tracé vectoriel maison (recoloré automatiquement, rendu net dans
la tuile) : `ui-clock ui-chart ui-refresh ui-lock ui-code ui-globe ui-terminal
ui-palette ui-window ui-chat ui-browser ui-todo ui-music ui-weather ui-cpu
ui-calendar ui-apps ui-shuffle ui-volume ui-pause ui-play ui-clear ui-folder
ui-send ui-stop ui-trash ui-plus ui-edit ui-pin ui-settings`.
Tout autre nom est pris comme icône symbolique du thème GNOME
(`network-wireless-symbolic`, `security-high-symbolic`, `drive-harddisk-symbolic`…).

Dans ton acteur, une icône = `new St.Icon({icon_name: 'xxx-symbolic', icon_size: px(16), style: 'color: …'})`.

---

## 5. Recettes (toutes présentes dans TEMPLATE.js)

- **Section avec titre + badge** : `_section(title, badgeText)`.
- **Ligne clé/valeur** : `_kvRow(label)` → `{actor, value, detail}`.
- **Jauge** : `_gauge()` → `{actor, setRatio(r)}` (remplissage `accent`, beige quand > 0.9).
- **Bouton pilule** : `_pill(text, onClick, variant)` avec `variant` ∈ `ghost | accent | danger` ; appuie = translation 3 px (l'ombre CSS disparaît en `:active`).
- **Liste de lignes cliquables** : `_row(text, onClick)` (classe `sp-row`).
- **Champ de saisie** : `_entry(hint, onActivate)` (classe `sp-entry`, grab clavier géré).
- **Message d'état** (vide, erreur, chargement) : `_status(text, kind)`.
- **Réseau** : `fetchText(url, headers)` ; **cache disque** : `readJson(path)` / `writeJson(path, obj)` dans `~/.cache/yuzu/<id>.json` ; **persistance** : `~/.config/yuzu/<id>.json`.
- **Sous-processus** : `runCommand(argv, {timeoutMs})` → `{ok, stdout, stderr}`.
- **Rafraîchissement périodique** : `this._startTimer(ms, fn)` / `this._stopTimer()`.

Ne mets dans la carte que ce qui se lit en une seconde : 3 à 6 lignes visibles,
un bouton « Voir plus » ou un défilement interne (`St.ScrollView` plafonné à
~300 px logiques) au-delà. La carte fait entre 120 et 420 px logiques de haut.

---

## 6. Sécurité et bon voisinage (modules « white hat » ou système)

- Lecture seule sur la machine : `/proc`, `/sys`, `journalctl`, `ss`, `nmcli`, `ip`, `who`, `ufw status`… Jamais de modification sans clic explicite de l'utilisateur, jamais de `sudo` ni de `pkexec` silencieux.
- Scan réseau (`nmap`, `arp-scan`) : réservé au réseau local de l'utilisateur ; affiche une ligne « scan de ton réseau local uniquement » la première fois et limite la cadence (≥ 60 s).
- Aucune donnée envoyée à un service tiers sans que ce soit le but affiché du module (et alors un seul domaine, documenté en tête de fichier).
- Clés d'API : lues dans `~/.config/yuzu/<id>.json` (`{ "apiKey": "…" }`), jamais codées en dur ; sans clé, la carte affiche « clé absente » et reste utilisable pour le reste.
- Une sortie de commande n'est jamais affichée brute : parse, tronque, formate.

---

## 7. Livraison : ce que tu rends

1. **Le fichier complet**, nommé `<id>.js`, avec en tête un commentaire qui dit ce
   que fait le module, d'où viennent les données, quels binaires/API il utilise,
   et où il persiste.
2. **Trois lignes d'installation** :
   ```
   cp <id>.js ~/.config/yuzu/modules/
   # puis dans le panneau : ＋ → choisir <id>.js
   journalctl -f -o cat /usr/bin/gnome-shell | grep -i yuzu   # en cas de carte rouge
   ```
3. Rien d'autre : pas de README séparé, pas de version alternative.

---

## 8. Checklist finale (vérifie chaque point avant de rendre)

- [ ] `export default {id, title, icon, build}` ; `id` n'est pas un id intégré.
- [ ] `build()` renvoie `{actor, setTheme, onOpen, onClose, destroy}`.
- [ ] Aucun `import '../…'` ; seuls des `gi://` et `resource:///`.
- [ ] Tout identifiant utilisé est importé ou défini (Clutter, Pango, Gio, GLib, St, Soup…).
- [ ] Aucun contour ni ombre sur l'acteur racine ; fond `MODULE.surface`, padding `px(20)`.
- [ ] Toutes les valeurs CSS passent par `px()`, toutes les propriétés d'acteur par `jsx()`.
- [ ] Aucun timer, requête ou sous-processus lancé dans `build()` ; tout démarre dans `onOpen()`.
- [ ] `onClose()` arrête les timers ; `destroy()` arrête tout, pose `_destroyed = true`, sauvegarde si besoin.
- [ ] Chaque callback asynchrone commence par `if (this._destroyed) return;`.
- [ ] Toute erreur réseau / commande est attrapée et affichée en `_status(…, 'error')`.
- [ ] Un changement de hauteur appelle `this._panel.requestRelayout()`.
- [ ] `St.Entry` ⇒ `enterEditMode` au clic, `leaveEditMode` sur Échap et `onClose`.
- [ ] Libellés en français, titres de section en CAPITALES, un seul accent orange.
- [ ] Pas de `fetch`, `setTimeout`, `setInterval`, `document`, `window`, `print`.
- [ ] Pas de `registerClass` avec des propriétés sans `_`.
