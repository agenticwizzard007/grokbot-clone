import json, os
MARKS=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'marks.json')))
ICONS = {
 'search':'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
 'plus':'<path d="M5 12h14"/><path d="M12 5v14"/>',
 'cl':'<path d="m15 18-6-6 6-6"/>','cr':'<path d="m9 18 6-6-6-6"/>','cd':'<path d="m6 9 6 6 6-6"/>','cu':'<path d="m18 15-6-6-6 6"/>',
 'x':'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>','menu':'<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
 'mic':'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/>',
 'up':'<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
 'gear':'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
 'tasks':'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
 'users':'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
 'file':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
 'gauge':'<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
 'key':'<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
 'shield':'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
 'blocks':'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
 'monitor':'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
 'msg':'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
 'user':'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
 'term':'<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
 'book':'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
 'brain':'<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-2z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
 'clock':'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 'stop':'<rect x="6" y="6" width="12" height="12" rx="2"/>',
 'alert':'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
 'check':'<path d="M20 6 9 17l-5-5"/>','refresh':'<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
 'more':'<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
 'bot':'<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><path d="M9 14h.01"/><path d="M15 14h.01"/>',
 'panel':'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>',
 'globe':'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
 'mail':'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
 'spark':'<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
 'logout':'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
 'phone':'<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
 'vol':'<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
 'micoff':'<path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5 2.2"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M19 10v1a7 7 0 0 1-1.2 3.9"/><path d="M5 10v1a7 7 0 0 0 11 5.7"/><path d="M12 18v4"/>',
 'folder':'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
 'chart':'<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
 'lock':'<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
 'wifi':'<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12.6a10 10 0 0 1 14 0"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M12 20h.01"/>',
 'home':'<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
 'play':'<path d="M7 4v16l13-8z"/>',
 'info':'<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
 'eye':'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
}
class T:
    def __init__(s, mode): s.mode=mode
    def __call__(s, k): return f"var(--color-{s.mode}-{k})"
FONT="font-family: Inter, system-ui, sans-serif;"
HEAD="font-family: 'Instrument Sans', Inter, sans-serif;"
def icon(name, c, size=18, sw=1.8):
    return f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{c}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0">{ICONS[name]}</svg>'
BRAND_COLOR={'claude':'#D97757'}
def logo(brand, t, size=16):
    col=BRAND_COLOR.get(brand, t('ink'))
    d=MARKS[brand][0]
    return f'<svg layer-name="{brand} logo" width="{size}" height="{size}" viewBox="0 0 24 24" style="flex-shrink: 0; overflow: visible"><path fill="{col}" fill-rule="evenodd" d="{d}"/></svg>'
def flock(size=24, c1='#3043AB', c2='#7787E1'):
    return (f'<svg layer-name="Swarm mark" width="{size}" height="{size}" viewBox="0 0 32 32" style="flex-shrink: 0">'
            f'<path fill="{c1}" d="M3 11c5-3 10-2 12 3 3-6 9-9 15-8-6 2-10 7-12 13-2-5-8-8-15-8z"/>'
            f'<path fill="{c2}" d="M6 19c4-2 8-1 10 3 2-4 7-6 11-5-5 1-8 5-9 9-2-4-6-6-12-7z"/></svg>')
def txt(s, c, size=14, w=400, lh=None, extra=''):
    if s=='' or s is None: return ''
    lh = lh or {12:16,13:18,14:20,15:24,17:24,20:28,24:32,32:40,40:48}.get(size, size+6)
    return f'<div style="{FONT} font-size: {size}px; font-weight: {w}; line-height: {lh}px; color: {c}; {extra}">{s}</div>'
def htxt(s, c, size=24, w=600, extra=''):
    lh={17:24,20:28,24:32,28:36,32:40,40:48}.get(size,size+8)
    return f'<div style="{HEAD} font-size: {size}px; font-weight: {w}; line-height: {lh}px; letter-spacing: -0.02em; color: {c}; {extra}">{s}</div>'
# v3 layout system (BUILD-SPEC 0d)
L = dict(pad_m=16, pad_d=32, w_form=640, w_list=880, w_chat=760, space=8, radius=12, card_pad=16, ctl=44)
def btn(label, t, kind='secondary', ic=None, h=44, full=False, extra=''):
    h = 44
    bg={'primary':t('primary'),'secondary':t('elevated'),'ghost':'transparent','danger':t('dangerbg'),'quiet':t('subtle')}[kind]
    fg={'primary':t('onprimary'),'secondary':t('ink'),'ghost':t('ink'),'danger':t('dangertext'),'quiet':t('ink')}[kind]
    bd=f'border: 1px solid {t("border")};' if kind=='secondary' else ''
    w='width: 100%;' if full else ''
    i=icon(ic,fg,16) if ic else ''
    return (f'<div layer-name="Button {label}" style="display: flex; align-items: center; justify-content: center; gap: 8px; height: {h}px; padding: 0 16px; border-radius: 10px; background: {bg}; {bd} {w} flex-shrink: 0; {extra}">'
            f'{i}<div style="{FONT} font-size: 14px; font-weight: 500; line-height: 20px; color: {fg}; white-space: nowrap">{label}</div></div>')
def iconbtn(name, t, size=36, kind='plain', c=None):
    bg={'plain':'transparent','bordered':t('elevated'),'quiet':t('subtle'),'primary':t('primary')}[kind]
    bd=f'border: 1px solid {t("border")};' if kind=='bordered' else ''
    col=c or (t('onprimary') if kind=='primary' else t('ink'))
    return f'<div style="display: flex; align-items: center; justify-content: center; width: {size}px; height: {size}px; border-radius: {size//2 if kind=="primary" else 10}px; background: {bg}; {bd} flex-shrink: 0">{icon(name,col,18)}</div>'
def chip(label, t, kind='neutral', extra=''):
    bg={'neutral':t('subtle'),'success':t('successbg'),'warn':t('warnbg'),'danger':t('dangerbg'),'primary':t('active')}[kind]
    fg={'neutral':t('text2'),'success':t('success'),'warn':t('warn'),'danger':t('dangertext'),'primary':t('primary') if t.mode=='light' else t('ink')}[kind]
    return f'<div style="display: flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 9999px; background: {bg}; flex-shrink: 0; {extra}"><div style="{FONT} font-size: 12px; font-weight: 500; line-height: 16px; color: {fg}; white-space: nowrap">{label}</div></div>'
def model_chip(t, brand='claude', model='Sonnet 4.5', effort='Medium', badge='Plan', compact=False):
    b = '' if compact or not badge else chip(badge,t)
    ch = '' if compact else icon('cd',t('text3'),14)
    return (f'<div layer-name="Model chip" style="display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px; border-radius: 18px; flex-shrink: 0">'
            f'{logo(brand,t,16)}<div style="{FONT} font-size: 13px; font-weight: 600; line-height: 18px; color: {t("ink")}; white-space: nowrap">{model}</div>{b}'
            f'<div style="{FONT} font-size: 12px; font-weight: 500; line-height: 16px; color: {t("text2")}; white-space: nowrap">{effort}</div>{ch}</div>')
def composer(t, text='', placeholder='Message Atlas', lines=1, compact=False, brand='claude', model='Sonnet 4.5', effort='Medium', voice=False, scroll=False, extra=''):
    has = bool(text)
    if has:
        field = f'<div style="{FONT} font-size: 15px; line-height: 24px; color: {t("ink")}; flex: 1; min-width: 0">{text}</div>'
    else:
        field = f'<div style="{FONT} font-size: 15px; line-height: 24px; color: {t("text3")}; flex: 1; min-width: 0; white-space: nowrap">{placeholder}</div>'
    fh = 24*min(lines,6)
    sb = f'<div style="width: 3px; height: {fh//2}px; border-radius: 2px; background: {t("border")}; flex-shrink: 0"></div>' if scroll else ''
    send = iconbtn('up',t,36,'primary') if has else iconbtn('mic',t,36,'primary')
    if compact and model=='Sonnet 4.5': model='Sonnet'
    if compact:
        # Phone: fixed two row layout. Row 1 field (full width), row 2 controls. Never switches layout.
        f2 = field.replace('white-space: nowrap','')
        return (f'<div layer-name="Composer (phone)" style="display: flex; flex-direction: column; gap: 4px; padding: 10px 8px 8px; border-radius: 24px; background: {t("elevated")}; border: 1px solid {t("border")}; box-shadow: 0 2px 8px -1px #0000000D; width: 100%; {extra}">'
                f'<div layer-name="Field" style="display: flex; align-items: flex-start; gap: 6px; height: {fh}px; padding: 0 8px; overflow: hidden">{f2}{sb}</div>'
                f'<div layer-name="Controls" style="display: flex; align-items: center; gap: 4px; height: 36px">{iconbtn("plus",t,36)}<div style="flex: 1"></div>{model_chip(t,brand,model,effort,compact=True)}{send}</div></div>')
    return (f'<div layer-name="Composer" style="display: flex; align-items: flex-end; gap: 4px; padding: 8px; min-height: 52px; border-radius: 24px; background: {t("elevated")}; border: 1px solid {t("border")}; box-shadow: 0 2px 8px -1px #0000000D; width: 100%; {extra}">'
            f'{iconbtn("plus",t,36)}'
            f'<div layer-name="Field" style="display: flex; align-items: flex-start; gap: 6px; flex: 1; min-width: 0; height: {fh}px; padding: 0; align-self: center; overflow: hidden">{field}{sb}</div>'
            f'{model_chip(t,brand,model,effort,compact=compact)}{send}</div>')
def avatar(t, color, size=36, glyph=True):
    return (f'<div style="display: flex; align-items: center; justify-content: center; width: {size}px; height: {size}px; border-radius: {size*0.3:.0f}px; background: {t("subtle")}; flex-shrink: 0">'
            f'{flock(int(size*0.62), color, t(color.split("(")[0]) if False else color)}</div>')
def bot_av(t, k, size=36):
    col=t(k)
    return (f'<div style="display: flex; align-items: center; justify-content: center; width: {size}px; height: {size}px; border-radius: {int(size*0.3)}px; background: {t("subtle")}; flex-shrink: 0">'
            f'{flock(int(size*0.62), col, col)}</div>')
def dot(c, s=8): return f'<div style="width: {s}px; height: {s}px; border-radius: 9999px; background: {c}; flex-shrink: 0"></div>'
def divider(t): return f'<div style="height: 1px; background: {t("bsoft")}; width: 100%; flex-shrink: 0"></div>'
def statusbar(t):
    s=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'statusbar.html')).read()
    col = '#000000' if t.mode=='light' else '#FFFFFF'
    return s.replace('color: white', f'color: {col}').replace('fill="white"', f'fill="{col}"')

def info_tip(t, label='More info'):
    return f'<div layer-name="Info: {label}" style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 12px; flex-shrink: 0">{icon("info",t("text3"),16)}</div>'
def learn_more(t, label='Learn more'):
    return f'<div style="{FONT} font-size: 13px; font-weight: 500; line-height: 18px; color: {t("primary")}; white-space: nowrap">{label}</div>'

def btn_group(t, *buttons, stack=False):
    """Buttons in a group share one width: each cell is flex 1 (or full width when stacked)."""
    cells=''.join(f'<div style="display: flex; flex: 1; min-width: 0">{b.replace("flex-shrink: 0;","flex-shrink: 0; width: 100%;")}</div>' for b in buttons)
    return f'<div layer-name="Button group" style="display: flex; flex-direction: {"column" if stack else "row"}; gap: 8px; width: 100%">{cells}</div>'
def sec_head(t, label, right=''):
    return f'<div layer-name="Section header" style="display: flex; align-items: center; gap: 8px; min-height: 24px"><div style="{FONT} font-size: 13px; font-weight: 600; line-height: 18px; color: {t("text2")}; flex: 1">{label}</div>{right}</div>'
