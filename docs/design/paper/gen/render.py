"""Render every Paper artboard as a standalone HTML reference page.
Usage: python3 render.py OUTDIR   -> OUTDIR/<slug>-<d|m>-<l|d>.html (same names as the Paper PNGs)"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from allscreens import SCREENS
from board import board_chunks
from comp import T
from tokens import LIGHT, DARK
out = sys.argv[1] if len(sys.argv) > 1 else 'paper-html'
os.makedirs(out, exist_ok=True)
css = ':root{' + ''.join(f'--color-light-{k}:{v};' for k, v in LIGHT.items()) + ''.join(f'--color-dark-{k}:{v};' for k, v in DARK.items()) + '}'
fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap">'
def page(chunks, mode, mobile, fit=False):
    w, h = (390, 844) if mobile else (1280, 900)
    dirn = 'column' if (mobile or fit) else 'row'
    hh = 'auto' if fit else f'{h}px'
    return (f'<!doctype html><html><head><meta charset="utf-8">{fonts}<style>{css}*{{box-sizing:border-box;margin:0}}body{{margin:0}}</style></head>'
            f'<body><div id="artboard" style="display:flex;flex-direction:{dirn};width:{w}px;height:{hh};overflow:hidden;position:relative;background:var(--color-{mode}-pane)">{"".join(chunks)}</div></body></html>')
n = 0
items = [('tokens', board_chunks, True)] + [(slug, fn, False) for _, slug, _, fn in SCREENS]
for slug, fn, fit in items:
    for mode in ('light', 'dark'):
        for mobile in (False, True):
            name = f"{slug}-{'m' if mobile else 'd'}-{mode[0]}.html"
            open(os.path.join(out, name), 'w').write(page(fn(T(mode), mobile), mode, mobile, fit))
            n += 1
print(n, 'pages in', out)
