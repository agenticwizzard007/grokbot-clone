from screens1 import *
from tokens import LIGHT, DARK, DESC
def section(t, title, inner, note=''):
    n = txt(note,t('text3'),13) if note else ''
    return (f'<div layer-name="{title}" style="display: flex; flex-direction: column; gap: 16px; padding: 32px 48px; border-bottom: 1px solid {t("bsoft")}">'
            f'<div style="display: flex; flex-direction: column; gap: 4px">{htxt(title,t("ink"),20)}{n}</div>{inner}</div>')
def board_chunks(t, mobile=False):
    pal = LIGHT if t.mode=='light' else DARK
    W = 390 if mobile else 1280
    hdr = (f'<div layer-name="Board header" style="display: flex; flex-direction: column; gap: 8px; padding: {"24px 16px" if mobile else "48px 48px 32px"}; border-bottom: 1px solid {t("bsoft")}">'
           f'<div style="display: flex; align-items: center; gap: 10px">{flock(28,t("primary"),"#7787E1")}{htxt("Swarm design system",t("ink"),28 if mobile else 40,700)}</div>'
           f'{txt(("Mobile components, 390 px" if mobile else "Tokens and components, desktop 1280 px")+(", light theme" if t.mode=="light" else ", dark theme"),t("text2"),15)}</div>')
    out=[hdr]
    pad = '24px 16px' if mobile else '32px 48px'
    def sec(title, inner, note=''):
        n = txt(note,t('text3'),13) if note else ''
        return (f'<div layer-name="{title}" style="display: flex; flex-direction: column; gap: 16px; padding: {pad}; border-bottom: 1px solid {t("bsoft")}">'
                f'<div style="display: flex; flex-direction: column; gap: 4px">{htxt(title,t("ink"),20)}{n}</div>{inner}</div>')
    if not mobile:
        sw=''.join(f'<div style="display: flex; flex-direction: column; gap: 6px; width: 132px"><div style="height: 56px; border-radius: 12px; background: {t(k)}; border: 1px solid {t("bsoft")}"></div>'
                   f'{txt(k,t("ink"),12,600)}{txt(v,t("text3"),12)}</div>' for k,v in pal.items())
        out.append(sec('Color', f'<div style="display: flex; flex-wrap: wrap; gap: 16px">{sw}</div>', 'Token names: --color-'+t.mode+'-[name]. Build maps them to the existing CSS variables in web/src/styles/tokens.css.'))
        ts=[('Display 32 / 40 Instrument Sans 700','Welcome to Swarm',32,700,True),('Title 24 / 32 Instrument Sans 600','Models and access',24,600,True),
            ('Panel 17 / 24 Inter 600','Claude plan',17,600,False),('Message 15 / 24 Inter 400','The launch is on track and the next step is to confirm the schedule.',15,400,False),
            ('Body 14 / 20 Inter 400','Use your plan through the official CLI sign in.',14,400,False),('Caption 12 / 16 Inter 500','Ready for your next task',12,500,False)]
        rows=''.join(f'<div style="display: flex; align-items: baseline; gap: 24px"><div style="width: 260px; flex-shrink: 0">{txt(a,t("text3"),12)}</div>'
                     f'{(htxt(b,t("ink"),s,w) if h else txt(b,t("ink"),s,w))}</div>' for a,b,s,w,h in ts)
        out.append(sec('Type', f'<div style="display: flex; flex-direction: column; gap: 14px">{rows}</div>'))
        sp=''.join(f'<div style="display: flex; flex-direction: column; align-items: center; gap: 6px"><div style="width: {v}px; height: {v}px; border-radius: 4px; background: {t("primary")}"></div>{txt(str(v),t("text3"),12)}</div>' for v in [4,8,12,16,24,32,40,48])
        rd=''.join(f'<div style="display: flex; flex-direction: column; align-items: center; gap: 6px"><div style="width: 64px; height: 48px; border-radius: {v}px; background: {t("subtle")}; border: 1px solid {t("border")}"></div>{txt(n,t("text3"),12)}</div>' for n,v in [('sm 8',8),('md 12',12),('card 16',16),('composer 24',24),('full',24)])
        out.append(sec('Spacing and radius', f'<div style="display: flex; gap: 64px; align-items: flex-end"><div style="display: flex; gap: 20px; align-items: flex-end">{sp}</div><div style="display: flex; gap: 16px">{rd}</div></div>', '8 px grid with 4 px half steps. Touch targets are at least 44 px on phones, 36 px on desktop.'))
        b = f'<div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap">{btn("Continue",t,"primary")}{btn("Use API providers",t,"secondary")}{btn("Cancel",t,"ghost")}{btn("Always allow",t,"quiet")}{btn("Disconnect",t,"danger")}{btn("Search",t,"secondary","search")}{iconbtn("mic",t,36,"primary")}{iconbtn("plus",t,36,"bordered")}{iconbtn("more",t,36)}</div>'
        c = f'<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">{chip("Primary",t)}{chip("Plan",t)}{chip("API",t)}{chip("Connected",t,"success")}{chip("Needs approval",t,"warn")}{chip("Sign in again",t,"danger")}{chip("Default",t,"primary")}</div>'
        out.append(sec('Buttons and chips', b + c, 'Labels never truncate or ellipsize. Buttons size to their label; on narrow widths they stack full width instead of clipping.'))
        mc = (f'<div style="display: flex; gap: 24px; align-items: center; flex-wrap: wrap">'
              + ''.join(f'<div style="display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 12px; border: 1px dashed {t("border")}">{m}{txt(l,t("text3"),12)}</div>' for m,l in [
                (model_chip(t,'claude','Sonnet 4.5','Medium'),'Desktop, Claude plan'),(model_chip(t,'openai','GPT-5 Codex','High'),'Desktop, ChatGPT plan'),
                (model_chip(t,'openrouter','Kimi K2','Low',badge='API'),'Desktop, OpenRouter key'),(model_chip(t,'claude','Sonnet','Medium',compact=True),'Phone: shorter whole label'),(model_chip(t,'openai','Codex','High',compact=True),'Phone, ChatGPT plan')]) + '</div>')
        out.append(sec('Model and effort chip', mc, 'Logo slot is a fixed 16 x 16 px box (flex: 0 0 16px) that is never clipped. Under 480 px the chip drops the billing badge and chevron and uses the short model name. Text never uses an ellipsis.'))
        comps = ''.join(f'<div style="display: flex; flex-direction: column; gap: 8px; width: 560px">{txt(l,t("text3"),12,600)}{c}</div>' for l,c in [
            ('Empty, 52 px tall', composer(t)), ('Typing one line, still 52 px', composer(t,'What are you working on here')),
            ('Three lines, grows to 88 px', composer(t,'Draft a launch note for Friday. Keep it short, mention the new Bots page, thank the beta group, and list the open questions before launch.',lines=3)),
            ('Maximum 6 lines, 160 px, then scrolls inside', composer(t,'Draft a launch note for Friday. Keep it short, mention the new Bots page, thank the beta group, and add a line about the pricing change that starts next month. Then list the three open questions we still need to answer before launch, and who owns each one, and when we should check in again.',lines=6,scroll=True))])
        out.append(sec('Composer', f'<div style="display: flex; flex-wrap: wrap; gap: 24px">{comps}</div>', 'One row grid: add, field, model chip, send or voice. Controls align to the bottom edge. Height = max(52, field + 16). Field line height 24 px, grows from the visible field width only, max 6 lines, then scrolls inside.'))
        nav = (f'<div style="display: flex; gap: 32px; align-items: flex-start"><div style="width: 272px; display: flex; flex-direction: column; gap: 2px; padding: 12px; border-radius: 16px; background: {t("sidebar")}; border: 1px solid {t("bsoft")}">'
               f'{nav_item(t,"home","All Bots",True)}{nav_item(t,"tasks","Tasks",False,chip("3",t))}{bot_row(t,"Atlas","Chief of Staff","pink",True,True)}{bot_row(t,"Research","Ready for your next task","green")}{usage_card(t)}</div>'
               f'<div style="display: flex; flex-direction: column; gap: 16px; width: 520px">{approval(t)}{runlog(t,STEPS,True)}</div></div>')
        out.append(sec('Navigation, cards and run log', nav, 'Sidebar rows: 36 px nav, 52 px Bot rows. Selected uses the active fill, never color alone. Approval cards always offer Don&#39;t allow, Always allow and Allow.'))
    else:
        mc = ''.join(f'<div style="display: flex; flex-direction: column; gap: 6px">{m}{txt(l,t("text3"),12)}</div>' for m,l in [
            (model_chip(t,'claude','Sonnet','Medium',compact=True),'Claude, compact'),(model_chip(t,'openai','Codex','High',compact=True),'ChatGPT, compact'),(model_chip(t,'openrouter','Kimi K2','Low',compact=True),'OpenRouter, compact')])
        out.append(sec('Compact model chip', f'<div style="display: flex; flex-wrap: wrap; gap: 16px">{mc}</div>', 'Full logo, short whole label, no ellipsis.'))
        comps = ''.join(f'<div style="display: flex; flex-direction: column; gap: 8px">{txt(l,t("text3"),12,600)}{c}</div>' for l,c in [
            ('Empty', composer(t,compact=True)),('Typing, one line', composer(t,'What are you working on',compact=True)),
            ('Wrapped, 3 lines', composer(t,'Draft a launch note for Friday and thank the beta group for their help.',lines=3,compact=True)),
            ('Max 6 lines, scrolls', composer(t,'Draft a launch note for Friday. Keep it short, mention the new Bots page, thank the beta group, and add a line about the pricing change next month. Then list the open questions.',lines=6,compact=True,scroll=True))])
        out.append(sec('Composer at 390', comps, 'Phone layout is a fixed two row box: field on top at full width, controls below. 84 px tall when empty or one line, grows 24 px per line to 6 lines (204 px), then scrolls inside. It never switches layout while typing.'))
        out.append(sec('Top bar and tab bar', f'<div style="display: flex; flex-direction: column; gap: 12px; border-radius: 16px; overflow: hidden; border: 1px solid {t("bsoft")}">{mtop(t,"Atlas","Chief of Staff","back",chat_header_right(t,True),AV_ATLAS(t))}{mtabs(t,"bots")}</div>', 'Tab bar shows on top level screens only: Bots, Tasks, Search, Settings. Inside a chat the composer owns the bottom edge and the top bar shows Back.'))
        out.append(sec('Buttons', f'<div style="display: flex; flex-direction: column; gap: 8px">{btn("Continue",t,"primary",h=44,full=True)}{btn("Use API providers",t,"secondary",h=44,full=True)}{btn("Don&#39;t allow",t,"secondary",h=44,full=True)}</div>', 'Phone buttons are 44 px tall and stack full width.'))
    return out
