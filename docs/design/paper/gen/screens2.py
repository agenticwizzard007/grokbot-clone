from screens1 import *
G = lambda s: s  # copy passthrough

# ---------- generic frames ----------
def page_body(t, inner, width=752, pad='32px 32px', gap=24):
    width = L['w_form'] if width <= 700 else L['w_list']
    pad = f"{L['pad_d']}px"; gap = 24 if gap >= 20 else 16
    return f'<div layer-name="Content" style="display: flex; flex-direction: column; align-items: center; flex: 1; min-height: 0; padding: {pad}; overflow: hidden"><div style="display: flex; flex-direction: column; gap: {gap}px; width: {width}px; max-width: 100%">{inner}</div></div>'
def title_block(t, title, sub=None, right='', mobile=False):
    s = txt(sub,t('text2'),14 if not mobile else 13) if sub else ''
    return (f'<div style="display: flex; align-items: flex-end; gap: 16px; {"flex-wrap: wrap;" if mobile else ""}"><div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0">'
            f'{htxt(title,t("ink"),24 if not mobile else 22,600)}{s}</div>{right}</div>')
def card(t, inner, pad=16, gap=12, extra=''):
    pad = L['card_pad']; gap = 0 if gap == 0 else 8 if gap <= 8 else (16 if gap > 12 else gap)
    extra = extra.replace('flex: 1; min-width: 0','flex: 1 1 0; min-width: 0')
    return f'<div layer-name="Card" style="display: flex; flex-direction: column; gap: {gap}px; padding: {pad}px; border-radius: {L["radius"]}px; align-self: stretch; background: {t("elevated")}; border: 1px solid {t("border")}; {extra}">{inner}</div>'
def row(t, ic, title, sub='', right='', mobile=False, brand=None, border=True):
    lead = logo(brand,t,20) if brand else (icon(ic,t('text2'),20) if ic else '')
    s = txt(sub,t('text2'),13) if sub else ''
    stack = mobile and right and 'Button' in right
    bd = f'border-bottom: 1px solid {t("bsoft")};' if border else ''
    if stack:
        return (f'<div style="display: flex; flex-direction: column; gap: 12px; min-height: 44px; padding: 10px 0; {bd}"><div style="display: flex; gap: 12px; align-items: flex-start">'
                f'<div style="display: flex; width: 20px; padding-top: 1px; flex-shrink: 0">{lead}</div><div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(title,t("ink"),15,600,22)}{s}</div></div>{right.replace("flex-shrink: 0;","flex-shrink: 0; width: 100%;")}</div>')
    return (f'<div style="display: flex; gap: 12px; align-items: center; min-height: 44px; padding: 10px 0; {bd}">'
            f'<div style="display: flex; width: 20px; flex-shrink: 0; align-self: flex-start; padding-top: 1px">{lead}</div><div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(title,t("ink"),15,600,22)}{s}</div>{right}</div>')
def seg(t, items, active, full=True, small=False):
    pad, gap, fs = ('0 6px', 6, 13) if small else ('0 12px', 8, 14)
    cells=''.join(f'<div style="display: flex; align-items: center; justify-content: center; gap: {gap}px; height: 36px; padding: {pad}; flex: 1 1 0; min-width: 0; border-radius: 9px; background: {t("elevated") if i==active else "transparent"}; {"border: 1px solid "+t("border")+";" if i==active else ""}">{lg}{txt(lb,t("ink"),fs,600 if i==active else 500,extra="white-space: nowrap;")}</div>' for i,(lb,lg) in enumerate(items))
    return f'<div layer-name="Segmented" style="display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: {t("subtle")}">{cells}</div>'
def field(t, label, value='', placeholder='', hint='', secret=False, err=None):
    v = txt(value,t('ink'),15) if value else txt(placeholder,t('text3'),15)
    bc = t('danger') if err else t('border')
    h = txt(err,t('dangertext'),12) if err else (txt(hint,t('text3'),12) if hint else '')
    return (f'<div style="display: flex; flex-direction: column; gap: 6px">{txt(label,t("ink"),13,600)}'
            f'<div style="display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border-radius: 10px; background: {t("pane")}; border: 1px solid {bc}">{v}{"<div style=&quot;flex: 1&quot;></div>" if False else ""}</div>{h}</div>')
def toggle(t, on=True):
    return f'<div style="display: flex; align-items: center; justify-content: {"flex-end" if on else "flex-start"}; width: 40px; height: 24px; padding: 2px; border-radius: 12px; background: {t("primary") if on else t("border")}; flex-shrink: 0"><div style="width: 20px; height: 20px; border-radius: 10px; background: {t("onprimary") if on else t("pane")}"></div></div>'
def radio_row(t, title, sub, on=False):
    r = f'<div style="display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 10px; border: 2px solid {t("primary") if on else t("border")}; flex-shrink: 0">{dot(t("primary"),10) if on else ""}</div>'
    return (f'<div style="display: flex; gap: 12px; align-items: flex-start; min-height: 44px; padding: 12px 16px; border-radius: 12px; border: 1px solid {t("primary") if on else t("border")}; background: {t("active") if on else t("pane")}">{r}'
            f'<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(title,t("ink"),14,600)}{txt(sub,t("text2"),13)}</div></div>')

def desk(t, header, body, sel=None, settings=False, nav=''):
    return [sidebar(t, sel, nav, settings), main(t, header + body)]
def mob(t, top, body, tabs=None, extra=None):
    out=[statusbar(t), top, body]
    out.append(mtabs(t,tabs) if tabs else homebar(t))
    if extra: out.append(extra)
    return out

# ---------- 01 Entry ----------
def apple_ic(c): return f'<svg width="18" height="18" viewBox="0 0 24 24" style="flex-shrink: 0"><path fill="{c}" d="M16.4 12.6c0-2.5 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.5 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.3-4.3zM14 5.2c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4z"/></svg>'
def google_ic(): return '<svg width="18" height="18" viewBox="0 0 24 24" style="flex-shrink: 0"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.8z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"/></svg>'
def obtn(t, ic, label):
    return f'<div style="display: flex; align-items: center; justify-content: center; gap: 10px; height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid {t("border")}; background: {t("pane")}; width: 100%">{ic}{txt(label,t("ink"),14,600)}</div>'
def signin_card(t, step='start', mobile=False):
    head = (f'<div style="display: flex; flex-direction: column; align-items: center; gap: 12px">{flock(40,t("primary"),"#7787E1")}'
            f'{htxt("Welcome to Swarm",t("ink"),28 if mobile else 32,700,"text-align: center")}{txt("Your Bots, working for you.",t("text2"),14,extra="text-align: center")}</div>')
    if step=='start':
        body = (field(t,'Phone number',placeholder='+1 415 555 0142',hint='Include your country code.') + btn('Continue with phone',t,'primary','phone',44,True)
           + f'<div style="display: flex; align-items: center; gap: 12px"><div style="height: 1px; flex: 1; background: {t("bsoft")}"></div>{txt("or",t("text3"),12)}<div style="height: 1px; flex: 1; background: {t("bsoft")}"></div></div>'
           + obtn(t,google_ic(),'Continue with Google') + obtn(t,apple_ic(t('ink')),'Continue with Apple') + obtn(t,logo('openrouter',t,18),'Continue with OpenRouter')
           + txt('',t('text3'),12,extra='text-align: center'))
    else:
        boxes=''.join(f'<div style="display: flex; align-items: center; justify-content: center; width: 44px; height: 52px; border-radius: 10px; border: 1px solid {t("danger")}; background: {t("pane")}">{txt(d,t("ink"),20,600)}</div>' for d in ['4','8','1','9','',''])
        body = (txt('Sent to +1 415 555 0142.',t('text2'),14,extra='text-align: center')
           + f'<div style="display: flex; justify-content: center; gap: 8px">{boxes}</div>'
           + f'<div style="display: flex; align-items: center; justify-content: center; gap: 6px">{icon("alert",t("dangertext"),14)}{txt("Wrong code. Try again.",t("dangertext"),13,500)}</div>'
           + btn('Verify',t,'primary',None,44,True) + f'<div style="display: flex; justify-content: center; gap: 16px">{txt("Resend code in 0:24",t("text3"),13)}{txt("Use a different number",t("primary"),13,600)}</div>')
    return f'<div layer-name="Sign in" style="display: flex; flex-direction: column; gap: 20px; width: {"100%" if mobile else "400px"}">{head}{body}</div>'
def entry_side(t):
    pts=[('bot','Bots with roles',''),
         ('shield','You stay in control',''),
         ('term','Use the plan you have','')]
    items=''.join(f'<div style="display: flex; gap: 14px">{iconbtn(ic,t,40,"quiet")}<div style="display: flex; flex-direction: column; gap: 4px; flex: 1">{txt(a,t("ink"),15,600)}{txt(b,t("text2"),14)}</div></div>' for ic,a,b in pts)
    logos = f'<div style="display: flex; align-items: center; gap: 16px">{sec_head(t,"Works with")}<div style="display: flex; align-items: center; gap: 6px">{logo("claude",t,18)}{txt("Claude",t("text2"),13,500)}</div><div style="display: flex; align-items: center; gap: 6px">{logo("openai",t,18)}{txt("ChatGPT",t("text2"),13,500)}</div><div style="display: flex; align-items: center; gap: 6px">{logo("openrouter",t,18)}{txt("OpenRouter",t("text2"),13,500)}</div></div>'
    return (f'<div layer-name="Story" style="display: flex; flex-direction: column; justify-content: space-between; width: 560px; height: 100%; padding: 48px; background: {t("sidebar")}; border-right: 1px solid {t("bsoft")}; flex-shrink: 0">'
            f'<div style="display: flex; align-items: center; gap: 8px">{flock(28,t("primary"),"#7787E1")}{htxt("swarms.so",t("ink"),22,600)}</div>'
            f'<div style="display: flex; flex-direction: column; gap: 28px">{htxt("Ready on day one.",t("ink"),40,700)}{items}</div>{logos}</div>')
def s_landing(t, mobile, step='start'):
    if mobile:
        return [statusbar(t), mbody(t, f'<div style="display: flex; align-items: center; gap: 8px">{flock(24,t("primary"),"#7787E1")}{htxt("swarms.so",t("ink"),20,600)}</div>' + signin_card(t,step,True), pad='12px 24px 24px', gap=28), homebar(t)]
    return [entry_side(t), main(t, f'<div style="display: flex; flex: 1; align-items: center; justify-content: center; padding: 48px">{signin_card(t,step)}</div>'
            + f'<div style="display: flex; justify-content: center; gap: 20px; padding: 0 0 24px">{txt("Terms",t("text3"),12)}{txt("Privacy",t("text3"),12)}{txt("Help",t("text3"),12)}</div>')]
def plan_options(t, mobile):
    return (radio_row(t,'Claude plan','Pro or Max plan',True)
        + radio_row(t,'ChatGPT plan','Plus or Pro plan')
        + radio_row(t,'OpenRouter key','Pay per use'))
def plan_options_logos(t):
    out=''
    for brand,title,sub,on in [('claude','Claude plan','Pro or Max plan',True),('openai','ChatGPT plan','Plus or Pro plan',False),('openrouter','OpenRouter key','Pay per use',False)]:
        r = f'<div style="display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 10px; border: 2px solid {t("primary") if on else t("border")}; flex-shrink: 0">{dot(t("primary"),10) if on else ""}</div>'
        out += (f'<div style="display: flex; gap: 12px; align-items: center; min-height: 44px; padding: 12px 16px; border-radius: 12px; border: 1px solid {t("primary") if on else t("border")}; background: {t("active") if on else t("pane")}">'
                f'{logo(brand,t,24)}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(title,t("ink"),15,600)}{txt(sub,t("text2"),13)}</div>{r}</div>')
    return out
def s_firstrun(t, mobile):
    steps = f'<div style="display: flex; gap: 6px">' + ''.join(f'<div style="height: 4px; flex: 1; border-radius: 2px; background: {t("primary") if i<2 else t("border")}"></div>' for i in range(3)) + '</div>'
    inner = (steps + sec_head(t,'Step 2 of 3') + title_block(t,'Connect a model','',mobile=mobile)
             + plan_options_logos(t)
             + card(t, f'<div style="display: flex; gap: 10px; align-items: flex-start">{icon("term",t("text2"),18)}<div style="display: flex; flex-direction: column; gap: 4px; flex: 1">{txt("Next: sign in with Claude",t("ink"),14,600)}{txt('',t("text2"),13)}</div></div>', pad=14)
             + f'<div style="display: flex; gap: 8px; {"flex-direction: column-reverse;" if mobile else "justify-content: flex-end;"}">{btn("Back",t,"ghost",h=44,full=mobile)}{btn("Continue with Claude",t,"primary",h=44,full=mobile)}</div>')
    if mobile: return mob(t, mtop(t,'Set up Swarm',None,'back'), mbody(t,inner,gap=16))
    return [entry_side(t), main(t, page_body(t, inner, 520, '64px 48px', 20))]

# ---------- 02 Chat: room ----------
def s_room(t, mobile):
    def bmsg(name,color,paras): return amsg(t,name,paras,color)
    thread = (umsg(t,'Plan the launch post together. Research, find two facts. Studio, draft it.')
        + bmsg('Research','green',['Two facts: 62% of beta users came back in week two, and setup time dropped to 4 minutes.'])
        + bmsg('Studio','orange',['Draft ready. Headline: Your team of Bots, ready on day one. Want a shorter version for social?'])
        + f'<div style="display: flex; align-items: center; gap: 8px; padding: 0 0 0 38px">{dot(t("pink"))}{txt("Atlas is reviewing the draft",t("text3"),13)}</div>')
    members = f'<div style="display: flex; align-items: center">' + ''.join(f'<div style="display: flex; padding: 2px; border-radius: 12px; background: {t("pane")}">{bot_av(t,c,24)}</div>' for c in ['pink','green','orange']) + '</div>'
    comp = composer(t, placeholder='Message the room', compact=mobile)
    if mobile:
        return [statusbar(t), mtop(t,'Launch room','3 Bots, 1 person','back',iconbtn('users',t,36)+iconbtn('more',t,36)), chat_col(t,thread,True), dock(t,comp,True), homebar(t)]
    return [sidebar(t,'Launch room'), main(t, dheader(t,'Launch room','Atlas, Research, Studio and you','All Bots',members+btn('Add Bot',t,'secondary','plus',32),
             f'<div style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; background: {t("subtle")}">{icon("users",t("teal"),18)}</div>')
             + chat_col(t,thread) + dock(t,comp,note=''))]

# ---------- 03 Bots ----------
def bot_card(t, name, role, color, status, sub, primary=False):
    s = {'Working':'success','Ready':'neutral','Needs you':'warn'}[status]
    return card(t, f'<div style="display: flex; gap: 12px; align-items: center">{bot_av(t,color,44)}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">'
                   f'<div style="display: flex; gap: 6px; align-items: center">{txt(name,t("ink"),15,600)}{chip("Primary",t) if primary else ""}</div>{txt(role,t("text3"),13)}</div>{chip(status,t,s)}</div>'
                   f'{txt(sub,t("text2"),13)}', pad=16, gap=12, extra='flex: 1; min-width: 0')
BOTCARDS=[('Atlas','Chief of Staff','pink','Working','Working',True),('Research','Researcher','green','Ready','Idle',False),
          ('Studio','Designer and writer','orange','Needs you','Needs approval',False),('Ledger','Finance helper','teal','Ready','Idle',False)]
def s_bots(t, mobile):
    cards = [bot_card(t,*b) for b in BOTCARDS]
    newcard = btn('Create a Bot',t,'secondary','plus',full=True)
    rooms = card(t, row(t,'users','Launch room','4 members',chip('2 new',t,'primary'),border=False), pad=12)
    if mobile:
        inner = sec_head(t,'Bots') + ''.join(cards) + sec_head(t,'Rooms') + rooms + newcard
        return mob(t, mtop(t,'Bots',None,None,iconbtn('plus',t,40)), mbody(t,inner,gap=12), 'bots')
    grid = f'<div layer-name="Card grid" style="display: flex; flex-direction: column; gap: 16px"><div style="display: flex; gap: 16px">{cards[0]}{cards[1]}</div><div style="display: flex; gap: 16px">{cards[2]}{cards[3]}</div></div>'
    inner = title_block(t,'Your Bots','',f'<div style="display: flex; width: 296px">'+btn_group(t,btn('New room',t,'secondary','users'),btn('Create a Bot',t,'primary','plus'))+'</div>') + grid + sec_head(t,'Rooms') + rooms
    return desk(t, dheader(t,'All Bots'), page_body(t,inner,880), None, nav='bots')
def modal(t, title, body, foot, w=520, mobile=False):
    if mobile:
        return (f'<div layer-name="Sheet" style="position: absolute; left: 0; top: 0; width: 390px; height: 844px; background: {t("scrim")}; display: flex; flex-direction: column; justify-content: flex-end">'
                f'<div style="display: flex; flex-direction: column; gap: 16px; padding: 12px 16px 32px; border-radius: 20px 20px 0 0; background: {t("elevated")}">'
                f'<div style="display: flex; justify-content: center"><div style="width: 36px; height: 4px; border-radius: 2px; background: {t("border")}"></div></div>'
                f'<div style="display: flex; align-items: center; justify-content: space-between">{txt(title,t("ink"),18,600)}{iconbtn("x",t,36)}</div>{body}{foot}</div></div>')
    return (f'<div layer-name="Modal scrim" style="position: absolute; left: 0; top: 0; width: 1280px; height: 900px; background: {t("scrim")}; display: flex; align-items: center; justify-content: center">'
            f'<div layer-name="Modal" style="display: flex; flex-direction: column; gap: 20px; width: {w}px; padding: 24px; border-radius: 16px; background: {t("elevated")}; box-shadow: 0 20px 32px -5px #1C1C1C1A">'
            f'<div style="display: flex; align-items: center; justify-content: space-between">{htxt(title,t("ink"),20,600)}{iconbtn("x",t,32)}</div>{body}{foot}</div></div>')
def s_create(t, mobile):
    roles=''.join(f'<div style="display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 18px; border: 1px solid {t("primary") if r=="Researcher" else t("border")}; background: {t("active") if r=="Researcher" else t("pane")}">{txt(r,t("ink"),13,500)}</div>' for r in ['Chief of Staff','Researcher','Writer','Designer','Finance','Custom'])
    body = (field(t,'Name','Scout') + f'<div style="display: flex; flex-direction: column; gap: 8px">{txt("Role",t("ink"),13,600)}<div style="display: flex; flex-wrap: wrap; gap: 8px">{roles}</div></div>'
            + f'<div style="display: flex; flex-direction: column; gap: 6px">{txt("Model",t("ink"),13,600)}<div style="display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid {t("border")}">{logo("claude",t,18)}{txt("Sonnet 4.5",t("ink"),14,600)}{chip("Plan",t)}<div style="flex: 1"></div>{txt("Medium effort",t("text2"),13)}{icon("cd",t("text3"),16)}</div>{txt('',t("text3"),12)}</div>')
    foot = (btn_group(t, btn("Create Bot",t,"primary"), btn("Cancel",t,"secondary"), btn("Start a room instead",t,"ghost","users"), stack=True) if mobile
            else f'<div style="display: flex; align-items: center; gap: 8px">{btn("Start a room instead",t,"ghost","users")}<div style="flex: 1"></div><div style="display: flex; width: 264px">{btn_group(t, btn("Cancel",t,"secondary"), btn("Create Bot",t,"primary"))}</div></div>')
    m = modal(t,'Create a Bot',body,foot,560,mobile)
    if mobile:
        base = mob(t, mtop(t,'Bots',None,None,iconbtn('plus',t,40)), mbody(t, sec_head(t,'Bots')+''.join(bot_card(t,*b) for b in BOTCARDS[:3]),gap=12), 'bots')
        return base + [m]
    d = s_bots(t, False); d[1] = d[1][:-6] + m + '</div>'
    return d
def bot_tabs(t, active, mobile=False):
    items=[('Chat','msg'),('Activity','chart'),('Tasks','tasks'),('Files','folder'),('Setup','term')] + ([] if mobile else [('Settings','gear')])
    if mobile:
        cells=''.join(f'<div style="display: flex; flex-direction: column; align-items: center; gap: 2px; flex: 1; padding: 6px 0; border-bottom: 2px solid {t("primary") if l==active else "transparent"}">{icon(ic,t("primary") if l==active else t("text3"),18)}{txt(l,t("ink") if l==active else t("text3"),11,600 if l==active else 500,14)}</div>' for l,ic in items)
        return f'<div layer-name="Bot tabs" style="display: flex; padding: 0 8px; border-bottom: 1px solid {t("bsoft")}; flex-shrink: 0">{cells}</div>'
    cells=''.join(f'<div style="display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 4px; border-bottom: 2px solid {t("primary") if l==active else "transparent"}">{icon(ic,t("ink") if l==active else t("text3"),16)}{txt(l,t("ink") if l==active else t("text2"),14,600 if l==active else 500)}</div>' for l,ic in items)
    return f'<div layer-name="Bot tabs" style="display: flex; gap: 20px; padding: 0 24px; border-bottom: 1px solid {t("bsoft")}; flex-shrink: 0">{cells}</div>'
def bot_page(t, mobile, tab, inner_d, inner_m=None, sub='Chief of Staff'):
    if mobile:
        return [statusbar(t), mtop(t,'Atlas',sub,'back',iconbtn('gear',t,36),AV_ATLAS(t)), bot_tabs(t,tab,True), mbody(t,inner_m if inner_m is not None else inner_d,gap=14), homebar(t)]
    return desk(t, dheader(t,'Atlas',sub,'All Bots',btn('Open chat',t,'secondary','msg',32),AV_ATLAS(t)) + bot_tabs(t,tab), page_body(t,inner_d,800,'24px 32px',16), 'Atlas')
def s_activity(t, mobile):
    stats = ''.join(card(t, sec_head(t,a)+htxt(b,t('ink'),24,600)+txt(c,t('text2'),12), pad=14, gap=4, extra='flex: 1; min-width: 0') for a,b,c in [('Runs this week','38','+6'),('Approvals','5','All answered'),('Time saved','3 h 10 m','Estimated')])
    evs=[('check','success','Finished: Launch checklist','10:42'),('mail','warn','Email not sent','10:40'),('globe','text2','Searched the web, 3 sources','10:38'),('clock','text2','Routine ran: Morning brief','08:00'),('alert','dangertext','Gmail sign in needed','Yesterday')]
    feed = ''.join(f'<div style="display: flex; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid {t("bsoft")}">{icon(ic,t(c),18)}<div style="flex: 1; min-width: 0">{txt(s,t("ink"),14)}</div>{txt(tm,t("text3"),12)}</div>' for ic,c,s,tm in evs)
    sw = f'<div style="display: flex; gap: 12px; {"flex-direction: column;" if mobile else ""}">{stats}</div>'
    return bot_page(t, mobile, 'Activity', sw + sec_head(t,'Today') + f'<div style="display: flex; flex-direction: column">{feed}</div>')
def task_row(t, title, meta, state):
    c={'Doing':'primary','To do':'neutral','Done':'success','Blocked':'warn'}[state]
    box = f'<div style="display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid {t("border")}; background: {t("success") if state=="Done" else "transparent"}; flex-shrink: 0">{icon("check","#FFFFFF",12,2.5) if state=="Done" else ""}</div>'
    return f'<div style="display: flex; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid {t("bsoft")}">{box}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(title,t("ink"),14,500)}{txt(meta,t("text3"),12)}</div>{chip(state,t,c)}</div>'
TASKS=[('Confirm launch date with the team','Atlas · due Fri','Doing'),('Draft launch email','Studio · due Thu','Blocked'),('Collect beta quotes','Research · due Thu','To do'),('Sort receipts for November','Ledger · done today','Done')]
def s_tasks_bot(t, mobile):
    f = seg(t,[('Open',''),('Done',''),('All','')],0)
    return bot_page(t, mobile, 'Tasks', (f if mobile else f'<div style="display: flex; justify-content: space-between; align-items: center; gap: 16px"><div style="width: 300px">{f}</div>{btn("Add task",t,"secondary","plus")}</div>') + f'<div style="display: flex; flex-direction: column">{"".join(task_row(t,*x) for x in TASKS[:3])}</div>' + (btn('Add task',t,'secondary','plus',44,True) if mobile else ''))
def file_row(t, ic, name, meta, kind):
    return f'<div style="display: flex; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid {t("bsoft")}">{iconbtn(ic,t,36,"quiet")}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(name,t("ink"),14,500)}{txt(meta,t("text3"),12)}</div>{chip(kind,t)}</div>'
def s_files(t, mobile):
    rep = card(t, f'<div style="display: flex; gap: 12px; align-items: center">{iconbtn("chart",t,40,"quiet")}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt("Saved reports",t("ink"),15,600)}{txt("3 reports",t("text2"),13)}</div>{icon("cr",t("text3"),18)}</div>', pad=14)
    files=[('file','Launch plan.md','Edited by Atlas · 10:41','Doc'),('file','Beta quotes.csv','Yesterday','Sheet'),('file','Launch post draft.md','Yesterday','Doc'),('folder','Receipts November','14 files','Folder')]
    f = f'<div style="display: flex; flex-direction: column">{"".join(file_row(t,*x) for x in files)}</div>'
    top = '' if mobile else f'<div style="display: flex; justify-content: space-between; align-items: center">{txt("Files",t("ink"),15,600)}{btn("Upload",t,"secondary","up")}</div>'
    return bot_page(t, mobile, 'Files', rep + top + f + (btn('Upload a file',t,'secondary','up',44,True) if mobile else ''))
def s_setup(t, mobile):
    tabs = [('Responsibilities',''),('Harness',''),('Files',''),('History','')]
    if mobile:
        pills = ''.join(f'<div style="display: flex; align-items: center; height: 32px; padding: 0 12px; border-radius: 16px; background: {t("ink") if i==0 else t("subtle")}">{txt(l,t("pane") if i==0 else t("ink"),13,600 if i==0 else 500)}</div>' for i,(l,_) in enumerate(tabs))
        st = f'<div style="display: flex; flex-wrap: wrap; gap: 8px">{pills}</div>'
    else: st = seg(t,tabs,0)
    resp = [('Runs the morning brief','Weekdays 08:00'),('Keeps the launch checklist','On team updates'),('Drafts replies','')]
    rs = ''.join(row(t,'check',a,b,iconbtn('more',t,32),mobile) for a,b in resp)
    return bot_page(t, mobile, 'Setup', st + txt('',t('ink'),15,600) + f'<div style="display: flex; flex-direction: column">{rs}</div>' + btn('Add a responsibility',t,'secondary','plus',44 if mobile else 36,mobile))
def bs_tabs(t, active, mobile):
    items=['General','Skills','Memories','Routines','Learning','Analytics']
    if mobile:
        pills = ''.join(f'<div style="display: flex; align-items: center; height: 32px; padding: 0 12px; border-radius: 16px; background: {t("ink") if l==active else t("subtle")}">{txt(l,t("pane") if l==active else t("ink"),13,600 if l==active else 500)}</div>' for l in items)
        return f'<div layer-name="Settings tabs" style="display: flex; flex-wrap: wrap; gap: 8px">{pills}</div>'
    cells = ''.join(f'<div style="display: flex; align-items: center; height: 36px; padding: 0 12px; border-radius: 10px; background: {t("active") if l==active else "transparent"}">{txt(l,t("ink"),14,600 if l==active else 500)}</div>' for l in items)
    return f'<div layer-name="Settings tabs" style="display: flex; flex-direction: column; gap: 2px; width: 180px; flex-shrink: 0">{cells}</div>'
def bot_settings(t, mobile, tab, content):
    if mobile:
        foot = f'<div style="display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid {t("bsoft")}; flex-shrink: 0">{btn_group(t, btn("Cancel",t,"secondary"), btn("Save",t,"primary"))}</div>'
        return [statusbar(t), mtop(t,'Atlas settings',None,'back','',AV_ATLAS(t)), mbody(t, bs_tabs(t,tab,True)+content, gap=16), foot, homebar(t)]
    body = f'<div style="display: flex; gap: 32px; flex: 1; min-height: 0; padding: 24px 32px; overflow: hidden">{bs_tabs(t,tab,False)}<div style="display: flex; flex-direction: column; gap: 16px; flex: 1; min-width: 0; max-width: 640px">{content}</div></div>'
    foot = f'<div style="display: flex; justify-content: flex-end; gap: 8px; padding: 16px 32px; border-top: 1px solid {t("bsoft")}; flex-shrink: 0"><div style="display: flex; width: 296px">{btn_group(t, btn("Cancel",t,"secondary"), btn("Save changes",t,"primary"))}</div></div>'
    return desk(t, dheader(t,'Atlas settings','Chief of Staff','Atlas','',AV_ATLAS(t)) + body + foot, '', 'Atlas')
def s_bs_general(t, mobile):
    model = (f'<div style="display: flex; flex-direction: column; gap: 6px">{txt("Model",t("ink"),13,600)}<div style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 12px; border-radius: 10px; border: 1px solid {t("border")}; flex-wrap: wrap">'
             f'{logo("claude",t,18)}{txt("Sonnet 4.5",t("ink"),14,600)}{chip("Plan",t)}<div style="flex: 1"></div>{txt("Medium",t("text2"),13)}{icon("cd",t("text3"),16)}</div></div>')
    c = (field(t,'Name','Atlas') + field(t,'Role','Chief of Staff') + model
         + f'<div style="display: flex; flex-direction: column; gap: 6px">{txt("Instructions",t("ink"),13,600)}<div style="display: flex; padding: 12px; min-height: 96px; border-radius: 10px; border: 1px solid {t("border")}">{txt("Keep me on top of the launch. Be brief. Ask before anything leaves my accounts.",t("ink"),14)}</div></div>'
         + row(t,'shield','Ask before every action','',toggle(t,False),mobile))
    return bot_settings(t, mobile, 'General', c)
def skill_row(t, name, desc, on=True):
    return row(t,'book',name,desc,toggle(t,on),False)
def s_skills(t, mobile):
    skc = card(t, f'<div style="display: flex; gap: 10px; align-items: center">{iconbtn("spark",t,36,"quiet")}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt("New skill from chat",t("ink"),14,600)}{txt("Atlas suggested: Weekly launch summary",t("text2"),13)}</div></div>'
              f'<div style="display: flex; gap: 8px; {"flex-direction: column-reverse;" if mobile else "justify-content: flex-end;"}">{btn("Not now",t,"secondary",full=mobile)}{btn("Review skill",t,"primary",full=mobile)}</div>', pad=14)
    sk = ''.join(skill_row(t,*x) for x in [('Weekly summary',''),('Meeting prep',''),('Inbox triage','',False)])
    head = f'<div style="display: flex; justify-content: space-between; align-items: center; gap: 12px">{txt("Skills",t("ink"),15,600)}{btn("Add skill",t,"secondary","plus")}</div>'
    return bot_settings(t, mobile, 'Skills', skc + head + f'<div style="display: flex; flex-direction: column">{sk}</div>')
def s_memory(t, mobile):
    mems=[('Prefers short answers with a clear next step.','Nov 20'),('Launch date target is Friday, Dec 4.','Nov 24'),('Team email is team@example.com.','Nov 18')]
    ms=''.join(f'<div style="display: flex; gap: 12px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid {t("bsoft")}">{icon("brain",t("text2"),18)}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(a,t("ink"),14)}{txt(b,t("text3"),12)}</div>{iconbtn("more",t,32)}</div>' for a,b in mems)
    srch = f'<div style="display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid {t("border")}">{icon("search",t("text3"),16)}{txt("Search memories",t("text3"),14)}</div>'
    return bot_settings(t, mobile, 'Memories', txt('',t('text2'),14) + srch + f'<div style="display: flex; flex-direction: column">{ms}</div>' + btn('Add a memory',t,'secondary','plus',44 if mobile else 36,mobile))
def s_routines(t, mobile):
    rs=[('Morning brief','Weekdays at 08:00','Ran 08:00'),('Friday recap','Fridays at 16:00','Next run Fri 16:00'),('Inbox check','Every 2 hours','Paused')]
    rr=''.join(card(t, f'<div style="display: flex; gap: 12px; align-items: center">{iconbtn("clock",t,36,"quiet")}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0">{txt(a,t("ink"),14,600)}{txt(b,t("text2"),13)}</div>{toggle(t,c!="Paused")}</div>{txt(c,t("text3"),12)}', pad=14, gap=8) for a,b,c in rs)
    return bot_settings(t, mobile, 'Routines', f'<div style="display: flex; justify-content: space-between; align-items: center; gap: 12px">{txt('',t("text2"),14,extra="flex: 1;")}{"" if mobile else btn("New routine",t,"primary","plus")}</div>' + rr + (btn('New routine',t,'primary','plus',44,True) if mobile else ''))
