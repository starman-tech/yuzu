#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installe Side Panel pour l'utilisateur courant (aucun sudo).
#
#   ./install.sh                       installation + choix des modules
#   ./install.sh --defaults            modules par défaut, sans question
#   ./install.sh --all                 tous les modules intégrés
#   ./install.sh --modules player,todo,weather
#   ./install.sh --keep                garde les modules déjà choisis (mise à jour)
#   ./install.sh --uninstall           désinstalle (tes données restent dans ~/.config/sidepanel)
#
# En une ligne, sans cloner le dépôt :
#   curl -fsSL https://raw.githubusercontent.com/starman-tech/sidepanel/main/install.sh | bash
set -euo pipefail

UUID="sidepanel@fgaudioso.dev"
REPO="starman-tech/sidepanel"
SCHEMA="org.gnome.shell.extensions.sidepanel"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '→ %s\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

MODE=ask
PICK=""
while [ $# -gt 0 ]; do
    case "$1" in
        --defaults) MODE=defaults ;;
        --all) MODE=all ;;
        --keep) MODE=keep ;;
        --modules) MODE=list; PICK="${2:-}"; shift ;;
        --modules=*) MODE=list; PICK="${1#*=}" ;;
        --uninstall) MODE=uninstall ;;
        -h|--help)
            cat <<'HELP'
Installe Side Panel pour l'utilisateur courant (aucun sudo).

  install.sh                        installation + choix des modules
  install.sh --defaults             modules par défaut, sans question
  install.sh --all                  tous les modules intégrés
  install.sh --modules player,todo,weather
  install.sh --keep                 garde les modules déjà choisis (mise à jour)
  install.sh --uninstall            désinstalle (les données restent dans ~/.config/sidepanel)
HELP
            exit 0 ;;
        *) die "option inconnue : $1 (voir --help)" ;;
    esac
    shift
done

# ------------------------------------------------------------ désinstallation
if [ "$MODE" = uninstall ]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    info "Side Panel désinstallé. Tes données sont conservées dans ~/.config/sidepanel."
    info "Pour tout effacer : rm -rf ~/.config/sidepanel ~/.cache/sidepanel && dconf reset -f /org/gnome/shell/extensions/sidepanel/"
    exit 0
fi

# ------------------------------------------------------------------ prérequis
for cmd in glib-compile-schemas gsettings python3; do
    command -v "$cmd" >/dev/null || die "commande « $cmd » introuvable"
done
command -v gnome-shell >/dev/null || die "GNOME Shell n'est pas installé"

SHELL_MAJOR="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"

# ------------------------------------------------ sources : dépôt ou release
# Lancé depuis un fichier (clone du dépôt) : sources locales. Lu sur
# l'entrée standard (curl | bash) : BASH_SOURCE est vide, on télécharge.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/$UUID/metadata.json" ]; then
    SRC="$SELF_DIR/$UUID"
else
    command -v curl >/dev/null || die "curl est nécessaire pour télécharger Side Panel"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    info "Téléchargement de la dernière version depuis github.com/$REPO"
    URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | python3 -c 'import json,sys; a=[x["browser_download_url"] for x in json.load(sys.stdin).get("assets",[]) if x["name"].endswith(".zip")]; print(a[0] if a else "")')"
    [ -n "$URL" ] || die "aucune release trouvée sur github.com/$REPO"
    curl -fsSL -o "$TMP/sidepanel.zip" "$URL"
    mkdir -p "$TMP/$UUID"
    python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TMP/sidepanel.zip" "$TMP/$UUID"
    SRC="$TMP/$UUID"
fi

VERSION="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("version-name", d.get("version")))' "$SRC/metadata.json")"
SUPPORTED="$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["shell-version"]))' "$SRC/metadata.json")"

bold "Side Panel $VERSION — GNOME Shell $SHELL_MAJOR"
case " $SUPPORTED " in
    *" $SHELL_MAJOR "*) ;;
    *) warn "GNOME $SHELL_MAJOR n'est pas dans les versions testées ($SUPPORTED) : l'extension risque d'être refusée ou instable." ;;
esac

# ------------------------------------------------------------------ copie
info "Installation dans ${DEST/#$HOME/~}"
mkdir -p "$DEST"
if command -v rsync >/dev/null; then
    rsync -a --delete "$SRC/" "$DEST/"
else
    rm -rf "$DEST" && mkdir -p "$DEST" && cp -a "$SRC/." "$DEST/"
fi
glib-compile-schemas "$DEST/schemas/"

gs() { gsettings --schemadir "$DEST/schemas" "$@"; }

# --------------------------------------------------------- choix des modules
# Lecture de builtins.json : id, titre, défaut, description courte.
mapfile -t ROWS < <(python3 - "$DEST/builtins.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for m in d["modules"]:
    print(f'm\t{m["id"]}\t{m["title"]}\t{"on" if m.get("default") else "off"}\t{m["description"]}\t{m.get("privacy", "")}')
for f in d.get("features", []):
    print(f'f\t{f["id"]}\t{f["title"]}\t{"on" if f.get("default") else "off"}\t{f["description"]}\t{f.get("privacy", "")}')
PY
)

declare -a IDS TITLES DEFAULTS DESCS KINDS PRIV
for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r kind id title def desc priv <<< "$row"
    KINDS+=("$kind"); IDS+=("$id"); TITLES+=("$title"); DEFAULTS+=("$def"); DESCS+=("$desc"); PRIV+=("$priv")
done

TTY=""
if [ -t 0 ]; then TTY=/dev/stdin; elif [ -r /dev/tty ] && (: < /dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
if [ "$MODE" = ask ] && [ -z "$TTY" ]; then
    warn "pas de terminal interactif : modules par défaut (change-les ensuite dans les préférences)"
    MODE=defaults
fi

CHOSEN=()
case "$MODE" in
    keep)
        ;;
    defaults)
        for i in "${!IDS[@]}"; do [ "${DEFAULTS[$i]}" = on ] && CHOSEN+=("${IDS[$i]}"); done ;;
    all)
        for i in "${!IDS[@]}"; do [ "${KINDS[$i]}" = m ] && CHOSEN+=("${IDS[$i]}"); done ;;
    list)
        IFS=',' read -r -a CHOSEN <<< "$PICK"
        for id in "${CHOSEN[@]}"; do
            printf '%s\n' "${IDS[@]}" | grep -qx "$id" || die "module inconnu : $id (disponibles : ${IDS[*]})"
        done ;;
    ask)
        if command -v whiptail >/dev/null; then
            args=()
            for i in "${!IDS[@]}"; do
                label="${TITLES[$i]} — ${DESCS[$i]}"
                [ "${KINDS[$i]}" = f ] && label="[fonction] $label"
                args+=("${IDS[$i]}" "${label:0:90}" "${DEFAULTS[$i]}")
            done
            if ! out="$(whiptail --title "Side Panel $VERSION" --separate-output --checklist \
                "Espace pour cocher, Entrée pour valider. Tout se change ensuite dans les préférences, et d'autres modules s'installent depuis le catalogue." \
                22 110 12 "${args[@]}" 3>&1 1>&2 2>&3 < "$TTY")"; then
                die "installation annulée (fichiers copiés, extension non configurée)"
            fi
            mapfile -t CHOSEN <<< "$out"
        else
            echo
            bold "Choisis tes modules (numéros séparés par des espaces, Entrée = sélection par défaut [*])"
            for i in "${!IDS[@]}"; do
                mark=" "; [ "${DEFAULTS[$i]}" = on ] && mark="*"
                kind=""; [ "${KINDS[$i]}" = f ] && kind=" (fonction)"
                printf '  %2d [%s] %s%s — %s\n' "$((i + 1))" "$mark" "${TITLES[$i]}" "$kind" "${DESCS[$i]}"
            done
            printf '> '
            read -r answer < "$TTY" || answer=""
            if [ -z "$answer" ]; then
                for i in "${!IDS[@]}"; do [ "${DEFAULTS[$i]}" = on ] && CHOSEN+=("${IDS[$i]}"); done
            else
                for n in $answer; do
                    [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#IDS[@]}" ] \
                        || die "choix invalide : $n"
                    CHOSEN+=("${IDS[$((n - 1))]}")
                done
            fi
        fi ;;
esac

if [ "$MODE" != keep ]; then
    order=(); rewrite=false
    for i in "${!IDS[@]}"; do
        printf '%s\n' "${CHOSEN[@]}" | grep -qx "${IDS[$i]}" || continue
        if [ "${KINDS[$i]}" = m ]; then
            order+=("'${IDS[$i]}'")
        elif [ "${IDS[$i]}" = rewrite ]; then
            rewrite=true
        fi
        [ -n "${PRIV[$i]}" ] && warn "${TITLES[$i]} : ${PRIV[$i]}"
    done
    # les modules du catalogue déjà installés restent affichés
    existing="$(gs get "$SCHEMA" module-order 2>/dev/null || echo "[]")"
    builtin_ids=" ${IDS[*]} "
    for id in $(python3 -c 'import ast,sys; print(" ".join(ast.literal_eval(sys.argv[1].replace("@as ", ""))))' "$existing"); do
        case "$builtin_ids" in *" $id "*) ;; *) order+=("'$id'") ;; esac
    done
    gs set "$SCHEMA" module-order "[$(IFS=,; echo "${order[*]}")]"
    gs set "$SCHEMA" rewrite-enabled "$rewrite"
    gs set "$SCHEMA" setup-done true
    info "Modules : $(IFS=' '; echo "${order[*]//\'/}")"
fi

# ------------------------------------------------------------------ activation
echo
if gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
    bold "✓ Side Panel $VERSION installé et activé."
    echo "  Si une version précédente tournait, recharge GNOME Shell pour appliquer la mise à jour :"
else
    bold "✓ Side Panel $VERSION installé."
    echo "  GNOME Shell doit redécouvrir ses extensions avant de pouvoir l'activer :"
fi
if [ "${XDG_SESSION_TYPE:-}" = x11 ]; then
    echo "    Alt+F2, tape r, Entrée"
else
    echo "    ferme ta session puis rouvre-la (Wayland ne permet pas de recharger le shell à chaud)"
fi
echo "  puis, si ce n'est pas déjà fait :  gnome-extensions enable $UUID"
echo
echo "  Ouvrir / fermer : survole le bord droit de l'écran, ou Super+P"
echo "  Préférences     : gnome-extensions prefs $UUID"
echo "  Journal         : journalctl -f -o cat /usr/bin/gnome-shell | grep -i sidepanel"
