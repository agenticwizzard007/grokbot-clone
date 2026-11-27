from shell import *
def umsg(t, s, w='auto'):
    return (f'<div style="display: flex; justify-content: flex-end; width: 100%"><div style="display: flex; flex-direction: column; max-width: 80%; padding: 10px 14px; border-radius: 16px 16px 4px 16px; background: {t("bubbleuser")}">'
            f'{txt(s, t("ink") if t.mode=="light" else "#FFFFFF", 15, 400, 24)}</div></div>')
def amsg(t, name, paras, color='pink', run=None):
    ps=''.join(txt(p,t("ink"),15,400,24) for p in paras)
    r = run or ''
    return (f'<div style="display: flex; gap: 10px; width: 100%; align-items: flex-start">{bot_av(t,color,28)}'
            f'<div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0">{txt(name,t("text3"),12,600)}{r}'
            f'<div style="display: flex; flex-direction: column; gap: 10px">{ps}</div></div></div>')
def runlog(t, steps, open_=False):
    head = (f'<div style="display: flex; align-items: center; gap: 8px; height: 28px">{icon("check",t("success"),14)}'
            f'{txt(f"Worked for 42s, {len(steps)} steps",t("text2"),13,500)}{icon("cu" if open_ else "cd",t("text3"),14)}</div>')
    body=''
    if open_:
        body = f'<div layer-name="Run log steps" style="display: flex; flex-direction: column; gap: 6px; padding: 4px 0 4px 12px; border-left: 2px solid {t("bsoft")}">' + ''.join(
            f'<div style="display: flex; align-items: center; gap: 8px">{icon(ic,t("text3"),14)}{txt(s,t("text2"),13)}</div>' for ic,s in steps) + '</div>'
    return f'<div layer-name="Run log" style="display: flex; flex-direction: column; gap: 4px">{head}{body}</div>'
def approval(t, compact=False, state='ask'):
    rows=[('To','team@example.com'),('Subject','Launch checklist for Friday'),('From','Your connected Gmail')]
    det=''.join(f'<div style="display: flex; gap: 12px"><div style="{FONT} font-size: 13px; line-height: 18px; color: {t("text3")}; width: 64px; flex-shrink: 0">{k}</div>{txt(v,t("ink"),13)}</div>' for k,v in rows)
    if state=='ask':
        btns = btn_group(t, btn("Don&#39;t allow",t,"secondary"), btn("Always allow",t,"secondary"), btn("Allow",t,"primary"), stack=compact)
    else:
        btns = f'<div style="display: flex; align-items: center; gap: 8px">{icon("x",t("dangertext"),16)}{txt("Not allowed. Atlas will not send this email.",t("dangertext"),13,500)}</div>'
    return (f'<div layer-name="Approval card" style="display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 16px; background: {t("elevated")}; border: 1px solid {t("border")}; width: 100%">'
            f'<div style="display: flex; align-items: center; gap: 10px">{icon("mail",t("ink"),18)}<div style="{FONT} font-size: 15px; font-weight: 600; line-height: 22px; color: {t("ink")}; flex: 1">Send an email?</div>{chip("Needs approval",t,"warn")}</div>'
            f'{txt("",t("text2"),13)}'
            f'<div style="display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 12px; background: {t("subtle")}">{det}</div>{btns}</div>')
STEPS=[('globe','Searched the web for launch checklists'),('file','Read Launch plan.md'),('tasks','Updated 3 tasks'),('spark','Used skill: Weekly summary')]
def chat_header_right(t, mobile=False):
    return iconbtn('mic',t,36,'plain') + (btn('Details',t,'secondary',h=32) if not mobile else iconbtn('more',t,36))
def chat_thread(t, mobile=False, extra_end=''):
    m=[umsg(t,'Help me plan the next step for our launch.'),
       amsg(t,'Atlas',['The launch is on track. Research is ready, the draft is in review, and the next step is to confirm the schedule.','I can turn the open questions into a short checklist.'],run=runlog(t,STEPS,False)),
       umsg(t,'Yes please, and email it to the team.')]
    return ''.join(m)+extra_end
def chat_col(t, inner, mobile=False):
    w = '100%' if mobile else '752px'
    return f'<div layer-name="Thread" style="display: flex; flex-direction: column; justify-content: flex-end; gap: 20px; flex: 1; min-height: 0; padding: {"16px" if mobile else "24px 24px"}; overflow: hidden; align-items: center"><div style="display: flex; flex-direction: column; gap: 20px; width: {w}; max-width: 100%">{inner}</div></div>'
def dock(t, comp_html, mobile=False, note=''):
    w = '100%' if mobile else '752px'
    n = txt(note, t('text3'), 12, extra='text-align: center') if note else ''
    return f'<div layer-name="Composer dock" style="display: flex; flex-direction: column; align-items: center; gap: 8px; padding: {"8px 12px 0" if mobile else "0 24px 20px"}; flex-shrink: 0"><div style="display: flex; flex-direction: column; gap: 8px; width: {w}; max-width: 100%">{comp_html}{n}</div></div>'
AV_ATLAS = lambda t, s=32: bot_av(t,'pink',s)

def s_chat(t, mobile, variant='rest'):
    """Main chat. variants: rest, typing, multiline, run, picker, voice"""
    extra=''
    text=''; lines=1; scroll=False
    if variant=='typing': text='What are you working on here'
    if variant=='multiline':
        text='Draft a launch note for Friday. Keep it short, mention the new Bots page, thank the beta group, and add a line about the pricing change that starts next month. Then list the three open questions we still need to answer before launch.'
        lines=6 if mobile else 3; scroll=mobile
    if variant=='run':
        extra = amsg(t,'Atlas',['Here is the checklist. I drafted the email and it is ready to send.'],run=runlog(t,STEPS,True)) + approval(t)
    thread = chat_thread(t, mobile, extra)
    if variant=='run': thread = umsg(t,'Yes please, and email it to the team.') + extra
    comp = composer(t, text=text, lines=lines, compact=mobile, scroll=scroll)
    hdr_title, hdr_sub = 'Atlas', 'Chief of Staff'
    overlay=''
    if variant=='picker': overlay = picker(t, mobile)
    if variant=='voice':
        comp = voicebar(t, mobile) + comp
    if mobile:
        return [statusbar(t), mtop(t,hdr_title,hdr_sub,'back',chat_header_right(t,True),AV_ATLAS(t)), chat_col(t,thread,True), dock(t,comp,True), homebar(t)] + ([overlay] if overlay else [])
    return [sidebar(t,'Atlas'), main(t, dheader(t,hdr_title,hdr_sub,'All Bots',chat_header_right(t),AV_ATLAS(t)) + chat_col(t,thread) + dock(t,comp,note='External actions ask first.') + overlay)]

def mm_row(t, brand, name, note, sel=False, effort='Medium', badge=None):
    b = chip(badge,t) if badge else ''
    return (f'<div style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-radius: 10px; background: {t("active") if sel else "transparent"}">'
            f'{logo(brand,t,18)}<div style="display: flex; flex-direction: column; flex: 1; min-width: 0"><div style="display: flex; align-items: center; gap: 6px">'
            f'<div style="{FONT} font-size: 14px; font-weight: 600; line-height: 20px; color: {t("ink")}">{name}</div>{b}</div>{txt(note,t("text3"),12)}</div>'
            f'{(icon("check",t("primary"),16)) if sel else ""}</div>')
def picker(t, mobile):
    effort = ''.join(f'<div style="display: flex; align-items: center; justify-content: center; height: 32px; flex: 1; border-radius: 8px; background: {t("elevated") if e=="Medium" else "transparent"}; {"border: 1px solid "+t("border")+";" if e=="Medium" else ""}">{txt(e,t("ink"),13,600 if e=="Medium" else 500)}</div>' for e in ['Low','Medium','High'])
    body = (f'<div style="padding: 4px 10px 2px">{sec_head(t,"Your plans")}</div>'
        + mm_row(t,'claude','Sonnet 4.5','',True,badge='Plan') + mm_row(t,'claude','Opus 4.1','',badge='Plan')
        + mm_row(t,'openai','GPT-5 Codex','',badge='Plan')
        + f'<div style="padding: 8px 10px 2px">{sec_head(t,"API billing")}</div>'
        + mm_row(t,'openrouter','OpenRouter models','',badge='API')
        + f'<div style="display: flex; flex-direction: column; gap: 8px; padding: 10px; border-top: 1px solid {t("bsoft")}">{sec_head(t,"Effort")}<div style="display: flex; gap: 4px; padding: 3px; border-radius: 10px; background: {t("subtle")}">{effort}</div></div>')
    if mobile:
        return (f'<div layer-name="Picker sheet scrim" style="position: absolute; left: 0; top: 0; width: 390px; height: 844px; background: {t("scrim")}; display: flex; flex-direction: column; justify-content: flex-end">'
                f'<div layer-name="Model sheet" style="display: flex; flex-direction: column; gap: 2px; padding: 8px 8px 28px; border-radius: 20px 20px 0 0; background: {t("elevated")}">'
                f'<div style="display: flex; justify-content: center; padding: 4px 0 8px"><div style="width: 36px; height: 4px; border-radius: 2px; background: {t("border")}"></div></div>'
                f'<div style="display: flex; align-items: center; justify-content: space-between; padding: 0 10px 8px">{txt("Model and effort",t("ink"),16,600)}{iconbtn("x",t,32)}</div>{body}</div></div>')
    return (f'<div layer-name="Model menu" style="position: absolute; right: 120px; bottom: 96px; width: 340px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 16px; background: {t("elevated")}; border: 1px solid {t("border")}; box-shadow: 0 10px 24px -6px #1C1C1C26">{body}</div>')
def voicebar(t, mobile):
    if mobile:
        return (f'<div layer-name="Voice bar" style="display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 9999px; background: {t("active")}; width: 100%">'
            f'{dot(t("success"))}<div style="display: flex; flex-direction: column; flex: 1; min-width: 0">{txt("Listening",t("ink"),13,600)}{txt("Replies show in this chat",t("text2"),12)}</div>'
            f'{iconbtn("micoff",t,40,"bordered")}<div style="display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 14px; border-radius: 9999px; background: {t("danger")}">{icon("stop","#FFFFFF",14)}{txt("End","#FFFFFF",13,600)}</div></div>')
    bars=''.join(f'<div style="width: 3px; height: {h}px; border-radius: 2px; background: {t("primary")}"></div>' for h in [6,12,18,10,22,14,8,16,20,9,13,6])
    return (f'<div layer-name="Voice bar" style="display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 9999px; background: {t("active")}; width: 100%">'
            f'{dot(t("success"))}<div style="display: flex; flex-direction: column; flex: 1; min-width: 0">{txt("Voice on. Atlas is listening",t("ink"),13,600)}{txt('',t("text2"),12)}</div>'
            f'<div style="display: flex; align-items: center; gap: 2px; height: 24px">{bars}</div>{iconbtn("micoff",t,36,"bordered")}'
            f'<div style="display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 9999px; background: {t("danger")}">{icon("stop","#FFFFFF",14)}{txt("End",  "#FFFFFF",13,600)}</div></div>')
