"""Make the look-alike table that public.name_skeleton uses, from Unicode's confusables.txt.

    python3 -I supabase/tools/make_name_skeleton_table.py confusables.txt

confusables.txt (https://www.unicode.org/Public/security/latest/confusables.txt) lists, for
each character, the "prototype" it can be mistaken for (UTS #39). This keeps the characters
whose prototype is one Latin letter, a quote mark, an apostrophe, a hyphen, a full stop or a
comma, and that Unicode NFKC leaves as they are (name_skeleton applies NFKC first, which
already folds mathematical, fullwidth and other compatibility forms). Two prototypes of two
characters are kept as one: "rn", which looks like m, as m, and two apostrophes, which look
like a quote mark, as a quote mark. It prints the two strings for pg_catalog.translate(), the
characters and what each becomes, as PostgreSQL escape strings, so the migration stays plain
ASCII.

The output goes into a migration, and the migration is never edited by hand: a new table
goes into a new migration that replaces name_skeleton (see supabase/README.md).
"""

import re
import sys
import unicodedata

KEPT_PUNCTUATION = "\"'-.,"


def prototype(target):
    """The one character a prototype stands for here, or None."""
    if target == 'rn':
        return 'm'
    if target == "''":
        return '"'
    if len(target) == 1 and (target.isascii() and target.isalpha() or target in KEPT_PUNCTUATION):
        return target
    return None


def main(path):
    pairs = []
    version = ''
    for line in open(path, encoding='utf-8-sig'):
        found = re.match(r'#\s*Version:\s*([0-9.]+)', line)
        if found and not version:
            version = found.group(1)
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        source, target = (field.strip() for field in line.split(';')[:2])
        if ' ' in source:
            continue
        char = chr(int(source, 16))
        to = prototype(''.join(chr(int(t, 16)) for t in target.split()))
        if to is None or to == char or unicodedata.normalize('NFKC', char) != char:
            continue
        pairs.append((char, to))
    pairs.sort()

    def escape(c):
        n = ord(c)
        if c.isascii() and c.isalnum():
            return c
        return f'\\u{n:04x}' if n <= 0xFFFF else f'\\U{n:08x}'

    def literal(chars, width=24):
        rows = [''.join(escape(c) for c in chars[i:i + width]) for i in range(0, len(chars), width)]
        return "E'" + "'\n    '".join(rows) + "'"

    print(f'-- {len(pairs)} characters, from confusables.txt version {version or "unknown"},')
    print(f'-- by supabase/tools/make_name_skeleton_table.py (NFKC of Python unicodedata {unicodedata.unidata_version}).')
    print('from:')
    print('    ' + literal([c for c, _ in pairs]))
    print('to:')
    print('    ' + literal([t for _, t in pairs]))


if __name__ == '__main__':
    main(sys.argv[1])
