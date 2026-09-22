"""Détecte les identifiants utilisés sans import — la classe de bug qui a
mis l'extension en ERROR (vectorIcon / makeVectorButton non importés)."""
import re, glob, sys

def strip_noise(src):
    src = re.sub(r'/\*.*?\*/', ' ', src, flags=re.S)
    src = re.sub(r'//[^\n]*', ' ', src)
    src = re.sub(r'`(?:[^`\\]|\\.)*`', '``', src)
    src = re.sub(r"'(?:[^'\\]|\\.)*'", "''", src)
    src = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
    return src

# 1. inventaire de tout ce que nos modules exportent
exported = {}
for path in glob.glob('lib/*.js') + glob.glob('modules/*.js'):
    src = open(path).read()
    for m in re.finditer(r"^export\s+(?:const|function|class|let)\s+(\w+)", src, re.M):
        exported.setdefault(m.group(1), path)

GI_NAMESPACES = {'Clutter','Gio','GLib','GObject','St','Shell','Meta','Pango','Cairo',
                 'Soup','GdkPixbuf','Gtk','Adw','Gdk','Main','PanelMenu'}
# Gvc est chargé par import() dynamique : exclu de la vérification statique

problems = []
for path in sorted(glob.glob('lib/*.js') + glob.glob('modules/*.js') + ['extension.js','prefs.js']):
    raw = open(path).read()
    src = strip_noise(raw)

    imported = set()
    for m in re.finditer(r"^import\s+(\w+)\s+from", raw, re.M):
        imported.add(m.group(1))
    for m in re.finditer(r"^import\s*\{([^}]+)\}\s*from", raw, re.M):
        for n in m.group(1).split(','):
            n = n.strip()
            if n: imported.add(n.split(' as ')[-1].strip())
    for m in re.finditer(r"^import\s+\*\s+as\s+(\w+)\s+from", raw, re.M):
        imported.add(m.group(1))

    declared = set(re.findall(r"(?:^|\s)(?:const|let|var|function|class)\s+(\w+)", src))
    # déstructuration, dont `const {default: Gvc} = await import(...)`
    for block in re.findall(r"(?:const|let|var)\s*\{([^}]*)\}\s*=", src):
        for part in block.split(','):
            name = part.split(':')[-1].split('=')[0].strip()
            if name: declared.add(name)
    declared |= set(re.findall(r"(?:const|let|var)\s*\{[^}]*?(?:default\s*:\s*)?(\w+)[^}]*\}\s*=", src))

    # (a) helpers de nos libs appelés en fonction libre
    for name in set(re.findall(r"(?<![.\w$])([a-z]\w+)\s*\(", src)):
        if name in exported and name not in imported and name not in declared:
            problems.append(f"{path}: « {name}() » — exporté par {exported[name]}, non importé")

    # (b) classes/constantes exportées, utilisées en PascalCase
    for name in set(re.findall(r"(?<![.\w$])([A-Z]\w+)\s*[.(]", src)):
        if name in GI_NAMESPACES or name in imported or name in declared:
            continue
        if name in exported:
            problems.append(f"{path}: « {name} » — exporté par {exported[name]}, non importé")

    # (c) espaces de noms GI utilisés sans import
    for name in set(re.findall(r"(?<![.\w$])([A-Z]\w+)\.", src)):
        if name in GI_NAMESPACES and name not in imported and name not in declared:
            problems.append(f"{path}: « {name} » — espace de noms GI non importé")

if problems:
    print("MANQUANTS :")
    print('\n'.join(sorted(set(problems))))
    sys.exit(1)
print('OK — tous les identifiants utilisés sont importés')
