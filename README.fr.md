<p align="center">
  <img src="docs/brand/logo.png" width="120" alt="Logo de Yuzu">
</p>

<h1 align="center">Yuzu</h1>

<p align="center">
  <b>Un panneau latéral flottant pour GNOME Shell, fait des cartes que tu choisis.</b><br>
  Lecteur, suivi du temps, tâches, moniteur système, météo, marchés…
  et des modules communautaires installés en un clic, sans jamais redémarrer le shell.
</p>

<p align="center">
  <img alt="GNOME Shell 46–49" src="https://img.shields.io/badge/GNOME%20Shell-46%20%E2%80%93%2049-4A86CF?logo=gnome&logoColor=white">
  <a href="https://github.com/starman-tech/yuzu/releases/latest"><img alt="Dernière version" src="https://img.shields.io/github/v/release/starman-tech/yuzu?color=F54F1B"></a>
  <a href="LICENSE"><img alt="Licence GPL-3.0-or-later" src="https://img.shields.io/badge/licence-GPL--3.0--or--later-1E223D"></a>
</p>

<p align="center">
  <a href="#installer">Installer</a> ·
  <a href="#modules">Modules</a> ·
  <a href="https://github.com/starman-tech/yuzu-modules">Catalogue</a> ·
  <a href="docs/MODULES.md">Écrire un module</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/screenshots/panel.png" width="440" alt="Yuzu en thème sombre et clair">
  <img src="docs/screenshots/catalog.png" width="385" alt="Le catalogue communautaire dans les préférences">
</p>

---


## Deux éditions

| | extensions.gnome.org | GitHub (ce dépôt) |
|---|---|---|
| Installation | depuis l'application Extensions ou le site | `install.sh` ou le zip de release |
| Modules | intégrés + modules communautaires embarqués, on active ceux qu'on veut | intégrés + n'importe quel module du catalogue, installé à chaud |
| Assistant IA et réécriture | — | en option, désactivés par défaut |
| UUID | `yuzu@starman-tech.github.io` | `yuzu-plus@starman-tech.github.io` |

N'installe qu'une des deux. L'édition extensions.gnome.org est construite à
partir de ce même code avec `tools/build.sh --ego` : le code qui charge des
modules à chaud ou lance des commandes en est retiré, les règles de revue
l'interdisant.

## Installer

```bash
curl -fsSL https://raw.githubusercontent.com/starman-tech/yuzu/main/install.sh | bash
```

L'installateur te demande quels modules activer, puis comment démarrer
l'extension (fermer et rouvrir la session sous Wayland, `Alt+F2` → `r` sous
X11). Aucun `sudo`, rien n'est écrit hors de ton dossier personnel.

Depuis un clone : `./install.sh` (avec choix), `./install.sh --defaults`,
`./install.sh --modules player,todo,weather`. Depuis une
[release](https://github.com/starman-tech/yuzu/releases) :
`gnome-extensions install --force yuzu-plus@starman-tech.github.io-v*.zip`, puis
fermer et rouvrir la session : le choix des modules est proposé au premier
lancement. Désinstaller : `./install.sh --uninstall` (tes données restent
dans `~/.config/yuzu`).

**Tu avais Side Panel** (l'ancien nom) : lance `install.sh`, il retire
l'ancienne extension et reprend tes réglages et tes données.

## Utiliser

| | |
|---|---|
| Ouvrir | Bord droit de l'écran, ou `Super+P` (qui épingle aussi) |
| Épingler | Bouton punaise |
| Réorganiser | Bouton crayon, puis glisser une carte ou utiliser ses flèches |
| Ranger une carte | Mode édition → ranger : elle part dans la bibliothèque en bas, un clic la remet |
| Vue grille | Bouton grille : les modules en icônes d'applications, un clic en ouvre un en grand |
| Ajouter des modules | **＋** → *Catalogue*, ou Préférences → *Catalogue* |
| Rester allumé capot fermé | Bouton tasse de café |

## Modules

Choisis-les dans Préférences → **Modules**, ou pendant `install.sh`. Sont
activés par défaut : Lecteur, Suivi du temps, Marché & actualités, Tâches,
Système, Météo, Calendrier et Favoris. L'**Assistant IA** est désactivé par
défaut.

Les modules communautaires (Pomodoro, débit réseau, note rapide, horloge…)
sont dans Préférences → **Catalogue**. Chaque fichier est vérifié par son
empreinte SHA-256 avant d'être chargé, et les mises à jour s'appliquent à
chaud. [Écrire le sien](docs/MODULES.md) : un seul fichier JavaScript.

### Confidentialité

Tout est local, sauf la Météo (open-meteo.com), le Marché (Yahoo Finance,
Google News) et les pochettes du Lecteur. Deux fonctions envoient tes données
à un tiers et restent **désactivées tant que tu ne les actives pas** :

- l'**Assistant IA** transmet à Groq le dossier du terminal au premier plan,
  sa commande en cours et les dernières lignes de l'historique, et peut lancer
  des commandes de lecture (`ls`, `find`, `git status`…) ;
- la **Réécriture de la sélection** (raccourci global, `Ctrl+M` par défaut)
  envoie le texte sélectionné à Groq.

Toutes deux demandent ta propre clé API Groq (Préférences → *Réglages*),
stockée dans GSettings, lisible par tout programme lancé sous ton compte.

Les modules communautaires tournent dans GNOME Shell avec tes droits. Ils sont
relus avant publication, leur code est à un clic dans les préférences, et le
catalogue indique quels serveurs chacun contacte ; n'installe malgré tout que
ce en quoi tu as confiance.

### Rester allumé capot fermé

La tasse de café empêche la mise en veille à la fermeture du capot : l'écran
se verrouille et s'éteint, mais compilations, téléchargements et terminaux
continuent. Deux verrous (logind `handle-lid-switch` et gnome-session
`suspend`) tombent seuls si le shell s'arrête ; aucun fichier système n'est
modifié. Vérifier : `systemd-inhibit --list | grep -i yuzu`. L'état
survit aux redémarrages : pense à le couper avant de ranger l'ordinateur.

## Dépannage

| Symptôme | Solution |
|---|---|
| `gnome-extensions enable` : l'extension n'existe pas | Le shell n'a pas rescanné : ferme et rouvre la session (Wayland) ou `Alt+F2` → `r` (X11) |
| Une carte affiche **ERREUR** | Le module n'a pas pu se charger ; le message est sur la carte, *Retirer* l'enlève. Journal : `journalctl -b -o cat /usr/bin/gnome-shell \| grep -i yuzu` |
| Rien au bord de l'écran | Augmente *Zone de déclenchement* (Préférences → *Panneau*) ou utilise `Super+P` |
| Catalogue injoignable | Hors ligne, la dernière copie téléchargée s'affiche |
| Pas de pochette | Le lecteur ne publie pas `mpris:artUrl` (fréquent avec les navigateurs) |
| Le flou d'arrière-plan fige le shell | Certains pilotes (NVIDIA sous X11) ne le supportent pas : désactive *Flou de l'arrière-plan* (Préférences → *Style*) |

## Développement

`tools/nested.sh` lance un GNOME Shell imbriqué isolé (configuration dans
`.run/sandbox`), `tools/lint.sh` vérifie le code, `tools/build.sh` produit le
zip. Voir [CONTRIBUTING.md](CONTRIBUTING.md) et
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Auteur

Créé par **Matteo Gaudioso**. Distribué sous licence
[GNU GPL v3.0 ou ultérieure](LICENSE).
