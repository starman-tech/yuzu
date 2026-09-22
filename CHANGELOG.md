# Changelog

## 5.0 — première version publique

### Nouveau
- **Catalogue communautaire** : préférences → Catalogue, installation,
  mise à jour et désinstallation en un clic, vérification SHA-256, prise en
  compte à chaud par le panneau. Source configurable (fork, catalogue privé).
- **Choix des modules** : un interrupteur par module dans les préférences,
  sélection pendant `install.sh`, proposition au premier lancement.
- **Installateur** `install.sh` : interactif ou non (`--modules`,
  `--defaults`, `--all`, `--keep`, `--uninstall`), installable en une ligne.
- **API des modules** `ctx.api` (v1) : `ctx.style` et `ctx.utils` (timers,
  fichiers de config, JSON, HTTP), documentée dans `docs/MODULES.md`.
- Compatibilité **GNOME 46 à 49**.
- **Thème clair complet** : cartes, en-tête, pilules, tuiles et lecteur
  suivent le thème ; `ctx.palette` pour les modules du catalogue.
- `tools/nested.sh` (shell imbriqué isolé) et `tools/smoke.sh` (test de
  fumée sans erreur dans le journal).

### Changé
- Les données passent de `~/.config/mon-extension` à `~/.config/sidepanel`
  (migration automatique, sans perte).
- L'assistant IA et la réécriture de la sélection sont désactivés par
  défaut : ils envoient des données à Groq.
- La vue grille n'affiche que les modules activés.
- L'en-tête adapte la taille de ses boutons à la largeur du panneau.
- Le sélecteur de fichiers passe par les préférences (Gtk.FileDialog) au
  lieu de zenity.
- Les exemples (horloge, note rapide) sont désormais dans le catalogue.

### Corrigé
- Le bouton Paramètres sortait du panneau à la largeur par défaut.
- Bandes à gauche et à droite de la pochette : la largeur donnée aux
  modules est désormais mesurée, plus estimée.
- Thème clair : cartes restées sombres, icônes de l'en-tête et de la grille
  illisibles.
- Système / Suivi du temps : rafales de St-CRITICAL à chaque reconstruction.
- Marché, Météo, Lecteur : erreurs « already disposed » quand une requête
  se terminait après la destruction de la carte.
- Les cartes reconstruites panneau ouvert ne démarraient pas leurs timers.
- Lecteur : erreurs « already disposed » quand la carte était reconstruite
  pendant le chargement de Gvc.
- Tâches : timer de l'état vide non retiré à la destruction.
