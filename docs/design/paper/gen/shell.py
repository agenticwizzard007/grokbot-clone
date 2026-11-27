from comp import *
BOTS=[('Atlas','Chief of Staff','pink',True,'Working on launch checklist'),('Research','Ready for your next task','green',False,''),
      ('Studio','Drafting two post ideas','orange',False,''),('Launch room','3 Bots, 1 person','teal',False,'room')]
def nav_item(t, ic, label, active=False, trail=''):
    bg = t('active') if active else 'transparent'
    return (f'<div style="display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; border-radius: 10px; background: {bg}">'
            f'{icon(ic, t("ink") if active else t("text2"), 18)}<div style="{FONT} font-size: 14px; font-weight: {600 if active else 500}; line-height: 20px; color: {t("ink")}; flex: 1">{label}</div>{trail}</div>')
def bot_row(t, name, sub, color, primary=False, selected=False, room=False):
    bg = t('active') if selected else 'transparent'
    av = (f'<div style="display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 11px; background: {t("subtle")}; flex-shrink: 0">{icon("users",t(color),18)}</div>' if room else bot_av(t,color,36))
    tag = chip('Primary',t) if primary else ''
    return (f'<div layer-name="Bot row {name}" style="display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; background: {bg}">{av}'
            f'<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0"><div style="display: flex; align-items: center; gap: 6px">'
            f'<div style="{FONT} font-size: 14px; font-weight: 600; line-height: 20px; color: {t("ink")}">{name}</div>{tag}</div>'
            f'{txt(sub, t("text3"), 12)}</div></div>')
def usage_card(t, brand='claude', plan='Claude Max plan', pct=42, note='42% used'):
    return (f'<div layer-name="Usage" style="display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: {t("subtle")}">'
            f'<div style="display: flex; align-items: center; gap: 8px">{logo(brand,t,16)}<div style="{FONT} font-size: 13px; font-weight: 600; line-height: 18px; color: {t("ink")}; flex: 1">{plan}</div>{icon("cr",t("text3"),16)}</div>'
            f'<div style="display: flex; height: 4px; border-radius: 2px; background: {t("border")}; width: 100%"><div style="width: {pct}%; height: 4px; border-radius: 2px; background: {t("primary")}"></div></div>'
            f'{txt(note,t("text3"),12)}</div>')
def sidebar(t, sel='Atlas', nav='', settings=False):
    wm = f'<div style="display: flex; align-items: center; gap: 8px; flex: 1">{flock(24, t("primary"), "#7787E1")}{htxt("swarms.so", t("ink"), 20, 600)}</div>'
    head = f'<div style="display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 4px 0 8px">{wm}{iconbtn("panel",t,32)}</div>'
    search = (f'<div layer-name="Search" style="display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px; border-radius: 12px; background: {t("elevated")}; border: 1px solid {t("border")}">'
              f'{icon("search",t("text3"),16)}<div style="{FONT} font-size: 14px; line-height: 20px; color: {t("text3")}; flex: 1">Search</div>'
              f'<div style="{FONT} font-size: 12px; line-height: 16px; color: {t("text3")}">Ctrl K</div></div>')
    top = f'<div style="display: flex; flex-direction: column; gap: 2px">{nav_item(t,"home","All Bots",nav=="bots")}{nav_item(t,"tasks","Tasks",nav=="tasks",chip("3",t))}{nav_item(t,"folder","Files",nav=="files")}</div>'
    label = f'<div style="padding: 8px 10px 4px">{txt("Your Bots", t("text3"), 12, 600, extra="letter-spacing: 0.02em")}</div>'
    rows = ''.join(bot_row(t,n,s,c,p,sel==n,r=='room') for n,s,c,p,r in BOTS)
    create = f'<div style="display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 10px; border-radius: 10px">{icon("plus",t("text2"),18)}{txt("Create a Bot",t("text2"),14,500)}</div>'
    acct = (f'<div layer-name="Account" style="display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 8px; border-radius: 10px; background: {t("active") if settings else "transparent"}">'
            f'<div style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 9999px; background: {t("primary")}">{txt("TU",t("onprimary"),12,600)}</div>'
            f'<div style="{FONT} font-size: 14px; font-weight: 500; line-height: 20px; color: {t("ink")}; flex: 1">Settings</div>{icon("gear",t("text2"),18)}</div>')
    return (f'<div layer-name="Sidebar" style="display: flex; flex-direction: column; justify-content: space-between; width: 272px; height: 100%; padding: 12px; gap: 12px; background: {t("sidebar")}; border-right: 1px solid {t("bsoft")}; flex-shrink: 0">'
            f'<div style="display: flex; flex-direction: column; gap: 12px">{head}{search}{top}<div style="display: flex; flex-direction: column; gap: 2px">{label}{rows}{create}</div></div>'
            f'<div style="display: flex; flex-direction: column; gap: 8px">{usage_card(t)}{acct}</div></div>')
def dheader(t, title, sub=None, back=None, right='', av=None):
    b = f'<div style="display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px 0 4px; border-radius: 8px">{icon("cl",t("text2"),16)}{txt(back,t("text2"),13,500)}</div>' if back else ''
    a = av or ''
    s = txt(sub,t("text3"),12) if sub else ''
    return (f'<div layer-name="Header" style="display: flex; align-items: center; gap: 12px; height: 64px; padding: 0 32px; border-bottom: 1px solid {t("bsoft")}; flex-shrink: 0">{b}'
            f'<div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0">{a}<div style="display: flex; flex-direction: column">'
            f'<div style="{FONT} font-size: 15px; font-weight: 600; line-height: 22px; color: {t("ink")}">{title}</div>{s}</div></div>'
            f'<div style="display: flex; align-items: center; gap: 8px">{right}</div></div>')
def main(t, inner, extra=''):
    return f'<div layer-name="Main" style="display: flex; flex-direction: column; flex: 1; min-width: 0; height: 100%; background: {t("pane")}; position: relative; {extra}">{inner}</div>'
def mtop(t, title, sub=None, left='back', right='', av=None):
    l = (f'<div layer-name="Back" style="display: flex; align-items: center; gap: 2px; height: 44px; padding: 0 8px 0 4px; flex-shrink: 0">{icon("cl",t("primary"),20)}'
         f'<div style="{FONT} font-size: 15px; font-weight: 500; line-height: 20px; color: {t("primary")}; white-space: nowrap">Back</div></div>') if left=='back' else (iconbtn('menu', t, 40) if left else '')
    s = txt(sub,t("text3"),12) if sub else ''
    a = av or ''
    return (f'<div layer-name="Top bar" style="display: flex; align-items: center; gap: 6px; height: 56px; padding: 0 8px; border-bottom: 1px solid {t("bsoft")}; flex-shrink: 0">{l}'
            f'<div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0">{a}<div style="display: flex; flex-direction: column; min-width: 0">'
            f'<div style="{FONT} font-size: 16px; font-weight: 600; line-height: 22px; color: {t("ink")}">{title}</div>{s}</div></div>'
            f'<div style="display: flex; align-items: center; gap: 2px; padding-right: 4px">{right}</div></div>')
def mtabs(t, active='bots'):
    items=[('bots','home','Bots'),('tasks','tasks','Tasks'),('search','search','Search'),('settings','gear','Settings')]
    cells=''.join(f'<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; flex: 1; height: 56px">{icon(ic, t("primary") if k==active else t("text3"), 22)}'
                  f'<div style="{FONT} font-size: 11px; font-weight: {600 if k==active else 500}; line-height: 14px; color: {t("primary") if k==active else t("text3")}">{lb}</div></div>' for k,ic,lb in items)
    return (f'<div layer-name="Tab bar" style="display: flex; flex-direction: column; border-top: 1px solid {t("bsoft")}; background: {t("sidebar")}; flex-shrink: 0">'
            f'<div style="display: flex; padding: 0 8px">{cells}</div><div style="display: flex; justify-content: center; padding: 8px 0 8px"><div style="width: 134px; height: 5px; border-radius: 3px; background: {t("ink")}"></div></div></div>')
def homebar(t):
    return f'<div layer-name="Home indicator" style="display: flex; justify-content: center; padding: 8px 0; flex-shrink: 0"><div style="width: 134px; height: 5px; border-radius: 3px; background: {t("ink")}"></div></div>'
def mbody(t, inner, pad='16px', gap=16, extra=''):
    pad = '0' if pad == '0' else '16px'; gap = 16 if gap >= 14 else (8 if gap <= 8 else 12)
    return f'<div layer-name="Body" style="display: flex; flex-direction: column; gap: {gap}px; flex: 1; min-height: 0; padding: {pad}; overflow: hidden; {extra}">{inner}</div>'
