#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Prépare l'arborescence d'une édition de l'extension dans un dossier de
travail (appelé par tools/build.sh).

  full  version GitHub : les balises sont retirées, le code reste entier.
  ego   version extensions.gnome.org : le code réservé à la version
        complète disparaît (catalogue à chaud, import de fichiers, assistant
        IA, réécriture), les modules du catalogue sont EMBARQUÉS dans le zip
        et deviennent des modules intégrés que l'on active dans les
        préférences, et metadata.json prend l'UUID propre à EGO.

Balises, une par ligne, dans les .js :
    // #if full
    … code de la version complète …
    // #else
    //: … code de la version EGO, commenté pour que la source reste valide …
    // #endif
et dans les .xml : <!-- #if full --> … <!-- #endif -->.
"""
import json
import pathlib
import re
import shutil
import sys

EGO_UUID = 'yuzu@starman-tech.github.io'
EGO_REMOVE = ['modules/assistant.js', 'lib/rewrite.js', 'lib/catalog.js']
BUILTIN_EXCLUDED_FROM_EGO = {'assistant'}


def preprocess_js(text, edition, where):
    out, state = [], None
    for n, line in enumerate(text.split('\n'), 1):
        t = line.strip()
        if t == '// #if full':
            if state:
                sys.exit(f'{where}:{n} : #if imbriqué')
            state = 'full'
            continue
        if t == '// #else':
            if state != 'full':
                sys.exit(f'{where}:{n} : #else sans #if')
            state = 'else'
            continue
        if t == '// #endif':
            if not state:
                sys.exit(f'{where}:{n} : #endif sans #if')
            state = None
            continue
        if state == 'full' and edition != 'full':
            continue
        if state == 'else':
            if edition == 'full':
                continue
            m = re.match(r'^(\s*)//: ?(.*)$', line)
            if not m:
                sys.exit(f'{where}:{n} : ligne de #else sans préfixe « //: »')
            line = m.group(1) + m.group(2)
        out.append(line)
    if state:
        sys.exit(f'{where} : #if full non refermé')
    return '\n'.join(out)


def preprocess_xml(text, edition):
    block = re.compile(r'[ \t]*<!-- #if full -->\n([\s\S]*?)[ \t]*<!-- #endif -->\n')
    return block.sub(lambda m: m.group(1) if edition == 'full' else '', text)


def preprocess_css(text, edition):
    block = re.compile(r'/\* #if full \*/\n([\s\S]*?)/\* #endif \*/\n')
    return block.sub(lambda m: m.group(1) if edition == 'full' else '', text)


def trim_block_comments(text):
    """Version EGO : les longs commentaires de conception (plus de 6 lignes)
    sont retirés ; l'en-tête de fichier est réduit à sa première ligne. Les
    commentaires courts, qui expliquent un point précis, restent."""
    out, i, n, first = [], 0, len(text), True
    in_str = None
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\':
                out.append(text[i + 1]); i += 2; continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in '\'"`':
            in_str = c; out.append(c); i += 1; continue
        if text.startswith('//', i):
            j = text.find('\n', i)
            j = n if j < 0 else j
            out.append(text[i:j]); i = j; continue
        if c == '/' and text.startswith('/*', i):
            j = text.find('*/', i + 2)
            if j < 0:
                break
            j += 2
            comment = text[i:j]
            lines = comment.count('\n') + 1
            if first:
                first = False
                title = comment.split('\n')[0].rstrip()
                out.append(title if title.endswith('*/') else f'{title} */')
            elif lines > 6:
                # ne pas laisser de ligne vide orpheline à la place du bloc
                while out and out[-1] in ' \t':
                    out.pop()
                if text[j:j + 1] == '\n':
                    j += 1
            else:
                out.append(comment)
            i = j
            continue
        if c == '/':
            # littéral d'expression régulière : on le recopie tel quel
            emitted = ''.join(out[-40:]).rstrip()
            prev = emitted[-1] if emitted else ''
            if prev in '(,=:[!&|?{};+-*%<>~^' or prev == '':
                j = i + 1
                in_class = False
                while j < n and text[j] != '\n':
                    if text[j] == '\\':
                        j += 2; continue
                    if text[j] == '[':
                        in_class = True
                    elif text[j] == ']':
                        in_class = False
                    elif text[j] == '/' and not in_class:
                        break
                    j += 1
                out.append(text[i:j + 1]); i = j + 1; continue
        out.append(c)
        i += 1
    result = ''.join(out)
    return re.sub(r'\n{3,}', '\n\n', result)


def bundle_modules(stage, catalog_dir):
    """Copie les modules du catalogue dans modules/community/ et les déclare
    dans lib/bundled.js et builtins.json (désactivés par défaut)."""
    metas = []
    for meta_path in sorted(pathlib.Path(catalog_dir).glob('modules/*/module.json')):
        meta = json.loads(meta_path.read_text())
        src = meta_path.parent / f"{meta['id']}.js"
        dest = stage / 'modules' / 'community' / f"{meta['id']}.js"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, dest)
        metas.append(meta)
    if not metas:
        sys.exit(f'aucun module trouvé dans {catalog_dir}/modules/*/module.json')

    ident = lambda mid: re.sub(r'-(\w)', lambda m: m.group(1).upper(), mid) + 'Module'
    imports = '\n'.join(f"import {ident(m['id'])} from '../modules/community/{m['id']}.js';" for m in metas)
    names = ', '.join(ident(m['id']) for m in metas)
    (stage / 'lib' / 'bundled.js').write_text(
        '// SPDX-License-Identifier: GPL-3.0-or-later\n'
        '/* lib/bundled.js — modules communautaires livrés avec l\'extension. */\n\n'
        f'{imports}\n\nexport const BUNDLED = [{names}];\n')

    builtins_path = stage / 'builtins.json'
    builtins = json.loads(builtins_path.read_text())
    builtins['modules'] = [m for m in builtins['modules'] if m['id'] not in BUILTIN_EXCLUDED_FROM_EGO]
    builtins['features'] = []
    for m in metas:
        entry = {'id': m['id'], 'title': m['title'], 'description': m['description'], 'default': False}
        if m.get('network'):
            entry['network'] = ', '.join(m['network'])
        builtins['modules'].append(entry)
    builtins_path.write_text(json.dumps(builtins, indent=2, ensure_ascii=False) + '\n')
    return [m['id'] for m in metas]


def ego_metadata(stage):
    path = stage / 'metadata.json'
    meta = json.loads(path.read_text())
    meta['uuid'] = EGO_UUID
    meta['gettext-domain'] = EGO_UUID
    meta['description'] = (
        'Floating side panel made of cards you choose: media player (MPRIS), '
        'time tracker, to-do list, system monitor, weather, calendar, favourite '
        'apps, markets, Pomodoro, network speed, quick note, clock. Enable only '
        'the modules you want in the preferences.\n\n'
        'Network: Weather uses open-meteo.com, Markets uses Yahoo Finance and '
        'Google News, only while their card is shown. Everything else is local.\n\n'
        'The optional "stay awake with the lid closed" button inhibits suspend '
        'through logind and gnome-session; this is why the extension also runs '
        'in the unlock-dialog session mode (the panel itself is removed while '
        'the screen is locked).')
    meta.pop('version', None)
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + '\n')


def main():
    if len(sys.argv) < 3:
        sys.exit('usage : edition.py full|ego DOSSIER [CATALOGUE]')
    edition, stage = sys.argv[1], pathlib.Path(sys.argv[2])
    if edition not in ('full', 'ego'):
        sys.exit(f'édition inconnue : {edition}')

    if edition == 'ego':
        for rel in EGO_REMOVE:
            (stage / rel).unlink(missing_ok=True)
        (stage / 'schemas' / 'gschemas.compiled').unlink(missing_ok=True)

    for js in stage.rglob('*.js'):
        text = preprocess_js(js.read_text(), edition, js.relative_to(stage))
        if edition == 'ego':
            text = trim_block_comments(text)
        js.write_text(text)
    for xml in stage.rglob('*.xml'):
        xml.write_text(preprocess_xml(xml.read_text(), edition))
    for css in stage.rglob('*.css'):
        css.write_text(preprocess_css(css.read_text(), edition))

    if edition == 'ego':
        catalog = sys.argv[3] if len(sys.argv) > 3 else None
        if not catalog:
            sys.exit('édition ego : chemin du dépôt yuzu-modules requis')
        ids = bundle_modules(stage, catalog)
        ego_metadata(stage)
        print(f'modules embarqués : {", ".join(ids)}')


if __name__ == '__main__':
    main()
