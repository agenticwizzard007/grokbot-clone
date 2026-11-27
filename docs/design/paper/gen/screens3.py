from screens2 import *
SNAV=[('Workspace',[('gear','General'),('user','Account'),('msg','Messaging'),('gauge','Usage'),('brain','Learning'),('monitor','Computer'),('shield','Permissions')]),
      ('Connections',[('term','Models & access'),('key','API keys'),('blocks','Connected apps'),('globe','MCP servers')])]
def settings_nav(t, active):
    out=f'<div style="display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; border-radius: 10px; border: 1px solid {t("border")}; background: {t("pane")}">{icon("search",t("text3"),14)}{txt("Search settings",t("text3"),13)}</div>'
    for g,items in SNAV:
        out += f'<div style="padding: 12px 10px 4px">{txt(g,t("text3"),12,600)}</div>'
        out += ''.join(f'<div style="display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border-radius: 9px; background: {t("active") if l==active else "transparent"}">{icon(ic,t("ink") if l==active else t("text2"),16)}{txt(l,t("ink"),14,600 if l==active else 500)}</div>' for ic,l in items)
    return f'<div layer-name="Settings nav" style="display: flex; flex-direction: column; gap: 2px; width: 220px; padding: 20px 12px; border-right: 1px solid {t("bsoft")}; flex-shrink: 0">{out}</div>'
def settings_page(t, mobile, active, inner, title=None, sub=None):
    title = title or active
    if mobile:
        return [statusbar(t), mtop(t,title,None,'back'), mbody(t, (txt(sub,t('text2'),13) if sub else '') + inner, gap=12), homebar(t)]
    body = f'<div style="display: flex; flex: 1; min-height: 0">{settings_nav(t,active)}<div style="display: flex; flex-direction: column; gap: 16px; flex: 1; min-width: 0; padding: 28px 40px; overflow: hidden"><div style="display: flex; flex-direction: column; gap: 16px; width: 640px; max-width: 100%">{title_block(t,title,sub)}{inner}</div></div></div>'
    return desk(t, dheader(t,'Settings',None,'Back to chat'), body, None, True)
def s_settings_home(t, mobile):
    if mobile:
        groups=''
        for g,items in SNAV:
            groups += txt(g,t('text3'),12,600) + card(t, ''.join(f'<div style="display: flex; align-items: center; gap: 12px; height: 48px; {"border-bottom: 1px solid "+t("bsoft")+";" if i<len(items)-1 else ""}">{icon(ic,t("text2"),18)}<div style="flex: 1">{txt(l,t("ink"),15,500)}</div>{icon("cr",t("text3"),16)}</div>' for i,(ic,l) in enumerate(items)), pad=12, gap=0)
        acct = card(t, f'<div style="display: flex; align-items: center; gap: 12px"><div style="display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 22px; background: {t("primary")}">{txt("TU",t("onprimary"),15,600)}</div><div style="display: flex; flex-direction: column; flex: 1">{txt("Test User",t("ink"),15,600)}{txt("user@example.com",t("text3"),13)}</div>{icon("cr",t("text3"),16)}</div>', pad=14)
        return mob(t, mtop(t,'Settings',None,None), mbody(t, acct + groups, gap=10), 'settings')
    inner = (row(t,'eye','Theme','',seg(t,[('Light',''),('Dark',''),('Auto','')],0 if t.mode=='light' else 1).replace('flex: 1;','')) 
             + row(t,'panel','Show details panel','',toggle(t,True))
             + row(t,'clock','Time zone','Europe, Central time',btn('Change',t,'secondary'))
             + row(t,'more','Keyboard shortcuts','',btn('View',t,'secondary')))
    return settings_page(t, mobile, 'General', inner, 'General', '')
def prow(t, brand, name, status, action, kind='primary', mobile=False, link=None, last=False):
    st = chip(status,t,'success' if status in ('Connected','In use','Key saved') else 'neutral')
    act = btn(action,t,kind,h=44 if mobile else 36)
    lk = learn_more(t,link) if link else ''
    bd = '' if last else f'border-bottom: 1px solid {t("bsoft")};'
    return (f'<div layer-name="Row {name}" style="display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 0; {bd}">{logo(brand,t,24)}'
            f'<div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; flex-wrap: wrap">{txt(name,t("ink"),15,600)}{st}</div>{lk}{act}</div>')
def s_models(t, mobile, mode='plan'):
    toggle_ = seg(t,[('Plan',''),('API key','')],0 if mode=='plan' else 1,small=mobile)
    head = f'<div style="display: flex; align-items: center; gap: 8px">{txt("Bots use",t("ink"),15,600)}{info_tip(t,"Plan uses your subscription. API key pays per use.")}</div>'
    plans = card(t, prow(t,'claude','Claude','Connected','Manage','secondary',mobile) + prow(t,'openai','ChatGPT','Not connected','Connect','primary',mobile,last=True), pad=16, gap=0)
    api = card(t, prow(t,'openrouter','OpenRouter','Not connected','Connect','primary',mobile,link='Paste key',last=True), pad=16, gap=0)
    inner = (head + toggle_ + txt('Plans',t('text3'),12,600) + plans + txt('Pay per use',t('text3'),12,600) + api
             + f'<div style="display: flex">{learn_more(t)}</div>')
    return settings_page(t, mobile, 'Models & access', inner, 'Models & access', None)
def s_keys(t, mobile):
    rows_ = (prow(t,'openrouter','OpenRouter','Key saved','Replace','secondary',mobile)
             + prow(t,'xai','xAI','Not connected','Add key','secondary',mobile)
             + prow(t,'gemini','Gemini','Not connected','Add key','secondary',mobile,last=True))
    dm = (f'<div style="display: flex; flex-direction: column; gap: 6px">{txt("Default API model",t("ink"),13,600)}'
          f'<div style="display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid {t("border")}">{logo("claude",t,18)}{txt("Claude Sonnet 4.5",t("ink"),14,500,extra="flex: 1;")}{icon("cd",t("text3"),16)}</div></div>')
    return settings_page(t, mobile, 'API keys', card(t, rows_, pad=16, gap=0) + dm, 'API keys', None)
def meter(t, label, brand, pct, note):
    return (f'<div style="display: flex; flex-direction: column; gap: 8px; padding: 14px 0; border-bottom: 1px solid {t("bsoft")}"><div style="display: flex; align-items: center; gap: 8px">{logo(brand,t,18)}{txt(label,t("ink"),14,600,extra="flex: 1;")}{txt(f"{pct}%",t("ink"),14,600)}</div>'
            f'<div style="display: flex; height: 6px; border-radius: 3px; background: {t("subtle")}"><div style="width: {pct}%; height: 6px; border-radius: 3px; background: {t("primary")}"></div></div>{txt(note,t("text3"),12)}</div>')
def s_usage(t, mobile):
    bars=''.join(f'<div style="display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; flex: 1; height: 120px"><div style="width: 100%; height: {h}px; border-radius: 6px 6px 2px 2px; background: {t("primary") if i==6 else t("active")}"></div>{txt(d,t("text3"),11,500,14)}</div>' for i,(d,h) in enumerate(zip(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],[40,72,56,90,64,20,84])))
    chart = card(t, f'<div style="display: flex; justify-content: space-between; align-items: baseline">{txt("Runs this week",t("ink"),14,600)}{htxt("214",t("ink"),24)}</div><div style="display: flex; gap: 8px; align-items: flex-end">{bars}</div>', pad=16)
    m = meter(t,'Claude plan','claude',42,'Resets Monday 09:00') + meter(t,'ChatGPT plan','openai',0,'Not connected') + meter(t,'OpenRouter credit','openrouter',18,'$3.60 of $20')
    per = ''.join(f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid {t("bsoft")}">{bot_av(t,c,24)}{txt(n,t("ink"),14,500,extra="flex: 1;")}{logo(b,t,16)}{txt(r,t("text2"),13)}</div>' for n,c,b,r in [('Atlas','pink','claude','96 runs'),('Research','green','claude','71 runs'),('Studio','orange','openrouter','47 runs')])
    return settings_page(t, mobile, 'Usage', chart + f'<div style="display: flex; flex-direction: column">{m}</div>' + txt('By Bot',t('text3'),12,600) + f'<div style="display: flex; flex-direction: column">{per}</div>', 'Usage', '')
def s_permissions(t, mobile):
    lv = (radio_row(t,'Ask for external actions only','Recommended',True)
          + radio_row(t,'Ask before every action','')
          + radio_row(t,'Never ask',''))
    al = ''.join(row(t,ic,a,b,btn('Remove',t,'secondary'),mobile) for ic,a,b in [('globe','Search the web','All Bots'),('file','Read files in Library','Atlas')])
    return settings_page(t, mobile, 'Permissions', txt('Approval level',t('ink'),15,600) + lv + txt('Always allowed',t('ink'),15,600) + f'<div style="display: flex; flex-direction: column">{al}</div>', 'Permissions', '')
APPS=[('mail','Gmail','Connected','Connected'),('clock','Google Calendar','Connected','Connected'),('msg','Slack','Sign in needed','Sign in again'),('book','Notion','Not connected','Connect')]
def s_apps(t, mobile):
    rows_=''
    for ic,n,s,st in APPS:
        r = chip(st,t,'success') if st=='Connected' else (btn(st,t,'danger' if st=='Sign in again' else 'secondary'))
        rows_ += row(t,ic,n,s,r,mobile)
    srch = f'<div style="display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid {t("border")}">{icon("search",t("text3"),16)}{txt("Search 250 apps",t("text3"),14)}</div>'
    return settings_page(t, mobile, 'Connected apps', srch + f'<div style="display: flex; flex-direction: column">{rows_}</div>', 'Connected apps', '')

# ---------- 05 Work and search ----------
def s_tasks(t, mobile):
    cols=[('To do',[TASKS[2]]),('Doing',[TASKS[0]]),('Blocked',[TASKS[1]]),('Done',[TASKS[3]])]
    if mobile:
        f = seg(t,[('Open',''),('Done',''),('All','')],0)
        groups=''.join(txt(c,t('text3'),12,600)+f'<div style="display: flex; flex-direction: column">{"".join(task_row(t,*x) for x in xs)}</div>' for c,xs in cols[:3])
        return mob(t, mtop(t,'Tasks',None,None,iconbtn('plus',t,40)), mbody(t, f + groups, gap=10), 'tasks')
    def tcard(x): 
        return card(t, f'{txt(x[0],t("ink"),14,500)}<div style="display: flex; align-items: center; gap: 8px">{bot_av(t,{"Atlas":"pink","Studio":"orange","Research":"green","Ledger":"teal"}[x[1].split(" ")[0]],20)}{txt(x[1],t("text3"),12)}</div>', pad=12, gap=8)
    board=''.join(f'<div style="display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; padding: 12px; border-radius: 14px; background: {t("subtle")}"><div style="display: flex; align-items: center; gap: 8px">{txt(c,t("ink"),13,600)}{chip(str(len(xs)),t)}</div>{"".join(tcard(x) for x in xs)}</div>' for c,xs in cols)
    inner = title_block(t,'Tasks','',btn('Add task',t,'primary','plus')) + f'<div style="display: flex; gap: 12px; align-items: flex-start">{board}</div>'
    return desk(t, dheader(t,'Tasks'), page_body(t,inner,960,'32px 32px',20), None, nav='tasks')
def search_panel(t, mobile):
    inp = f'<div style="display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 14px; border-bottom: 1px solid {t("bsoft")}">{icon("search",t("ink"),18)}{txt("launch",t("ink"),16,extra="flex: 1;")}{"" if mobile else txt("Esc",t("text3"),12)}</div>'
    def grp(name, items):
        return f'<div style="display: flex; flex-direction: column; gap: 2px; padding: 8px">{txt(name,t("text3"),12,600,extra="padding: 4px 8px;")}' + ''.join(
            f'<div style="display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 8px; border-radius: 10px; background: {t("active") if i==0 and name=="Bots" else "transparent"}">{a}<div style="display: flex; flex-direction: column; flex: 1; min-width: 0">{txt(b,t("ink"),14,500)}{txt(c,t("text3"),12) if c else ""}</div></div>' for i,(a,b,c) in enumerate(items)) + '</div>'
    res = (grp('Bots',[(bot_av(t,'teal',24),'Launch room','Room')])
           + grp('Messages',[(icon('msg',t('text2'),18),'The launch is on track. Research is ready','Atlas · Today'),(icon('msg',t('text2'),18),'Draft ready. Headline: Your team of Bots','Studio in Launch room · Today')])
           + grp('Files and tasks',[(icon('file',t('text2'),18),'Launch plan.md','Atlas Files'),(icon('tasks',t('text2'),18),'Confirm launch date with the team','Task · due Fri')]))
    return inp + res
def s_search(t, mobile):
    if mobile:
        inner = search_panel(t, True)
        return [statusbar(t), f'<div style="display: flex; align-items: center; gap: 4px; padding: 0 8px 0 0; flex-shrink: 0">{iconbtn("cl",t,40)}<div style="flex: 1; display: flex; flex-direction: column">{inner}</div></div>', mbody(t,'',pad='0'), mtabs(t,'search')][0:2] + [f'<div style="display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden">{search_panel(t,True).split("</div>",1)[0] and ""}</div>', mtabs(t,'search')] if False else [statusbar(t), f'<div layer-name="Search" style="display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden">{search_panel(t,True)}</div>', mtabs(t,'search')]
    d = s_chat(t, False, 'rest')
    panel = (f'<div layer-name="Search scrim" style="position: absolute; left: 0; top: 0; width: 1008px; height: 900px; background: {t("scrim")}; display: flex; justify-content: center; padding-top: 96px">'
             f'<div layer-name="Search panel" style="display: flex; flex-direction: column; width: 600px; height: fit-content; border-radius: 16px; background: {t("elevated")}; box-shadow: 0 20px 32px -5px #1C1C1C33">{search_panel(t,False)}</div></div>')
    d[1] = d[1][:-6] + panel + '</div>'
    return d

# ---------- 06 States and navigation ----------
def s_empty(t, mobile):
    hero = (f'<div style="display: flex; flex-direction: column; align-items: center; gap: 16px; padding: {"24px 8px" if mobile else "48px"}">{flock(56,t("primary"),"#7787E1")}'
            f'{htxt("Meet Atlas, your Chief of Staff",t("ink"),24 if mobile else 28,700,"text-align: center")}{txt("Ask for anything.",t("text2"),15,extra="text-align: center; max-width: 480px")}</div>')
    sugg = ''.join(f'<div style="display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px; border: 1px solid {t("border")}; background: {t("pane")}; {"" if mobile else "flex: 1; min-width: 0;"}">{icon(ic,t("text2"),18)}{txt(s,t("ink"),14,500)}</div>' for ic,s in [('spark','Plan my week'),('mail','Summarize my inbox'),('globe','Research a topic')])
    sg = f'<div style="display: flex; gap: 8px; {"flex-direction: column;" if mobile else ""}">{sugg}</div>'
    comp = composer(t, compact=mobile)
    if mobile:
        return [statusbar(t), mtop(t,'Atlas','Chief of Staff','back',chat_header_right(t,True),AV_ATLAS(t)), mbody(t, hero + sg, gap=16, extra='justify-content: center;'), dock(t,comp,True), homebar(t)]
    return [sidebar(t,'Atlas'), main(t, dheader(t,'Atlas','Chief of Staff','All Bots',chat_header_right(t),AV_ATLAS(t)) + f'<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 16px; padding: 24px"><div style="display: flex; flex-direction: column; gap: 16px; width: 752px">{hero}{sg}</div></div>' + dock(t,comp,note='External actions ask first.'))]
def skel(t, w, h=12, r=6): return f'<div style="width: {w}; height: {h}px; border-radius: {r}px; background: {t("subtle")}; flex-shrink: 0"></div>'
def s_loading(t, mobile):
    def sk_msg(right):
        return f'<div style="display: flex; {"justify-content: flex-end;" if right else "gap: 10px;"} width: 100%">{"" if right else skel(t,"28px",28,9)}<div style="display: flex; flex-direction: column; gap: 8px; width: {"50%" if right else "70%"}">{skel(t,"100%",14)}{skel(t,"80%",14)}{"" if right else skel(t,"60%",14)}</div></div>'
    th = sk_msg(True) + sk_msg(False) + sk_msg(True) + f'<div style="display: flex; align-items: center; gap: 8px">{icon("refresh",t("text3"),14)}{txt("Loading your chat",t("text3"),13)}</div>'
    comp = composer(t, placeholder='Message Atlas', compact=mobile)
    if mobile:
        return [statusbar(t), mtop(t,'Atlas','Chief of Staff','back','',AV_ATLAS(t)), chat_col(t,th,True), dock(t,comp,True), homebar(t)]
    return [sidebar(t,'Atlas'), main(t, dheader(t,'Atlas','Chief of Staff','All Bots','',AV_ATLAS(t)) + chat_col(t,th) + dock(t,comp,note=' '))]
def s_error(t, mobile):
    banner = (f'<div layer-name="Error banner" style="display: flex; gap: 10px; align-items: {"flex-start" if mobile else "center"}; padding: 12px 14px; border-radius: 12px; background: {t("dangerbg")}; {"flex-direction: column;" if mobile else ""}">'
              f'<div style="display: flex; gap: 10px; align-items: flex-start; flex: 1">{icon("wifi",t("dangertext"),18)}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1">{txt("Connection lost",t("dangertext"),14,600)}{txt("Sends when you reconnect.",t("dangertext"),13)}</div></div>{btn("Try again",t,"secondary","refresh",full=mobile)}</div>')
    failed = (f'<div style="display: flex; justify-content: flex-end; width: 100%"><div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 80%"><div style="display: flex; padding: 10px 14px; border-radius: 16px 16px 4px 16px; background: {t("bubbleuser")}; border: 1px solid {t("danger")}">{txt("Send the launch email now",t("ink") if t.mode=="light" else "#FFFFFF",15,400,24)}</div>'
              f'<div style="display: flex; gap: 6px; align-items: center">{icon("alert",t("dangertext"),12)}{txt("Not sent. Tap to retry",t("dangertext"),12,500)}</div></div></div>')
    plan = card(t, f'<div style="display: flex; gap: 10px; align-items: center">{logo("claude",t,20)}<div style="display: flex; flex-direction: column; gap: 2px; flex: 1">{txt("Claude signed out",t("ink"),14,600)}{txt("",t("text2"),13)}</div></div>{btn("Reconnect Claude",t,"primary",full=mobile)}', pad=14)
    th = umsg(t,'Help me plan the next step for our launch.') + amsg(t,'Atlas',['The launch is on track. The next step is to confirm the schedule.']) + failed + plan
    comp = composer(t, compact=mobile)
    if mobile:
        return [statusbar(t), mtop(t,'Atlas','Offline','back','',AV_ATLAS(t)), f'<div style="padding: 12px 16px 0; display: flex; flex-direction: column">{banner}</div>', chat_col(t,th,True), dock(t,comp,True), homebar(t)]
    return [sidebar(t,'Atlas'), main(t, dheader(t,'Atlas','Offline','All Bots','',AV_ATLAS(t)) + f'<div style="display: flex; justify-content: center; padding: 16px 24px 0"><div style="display: flex; flex-direction: column; width: 752px">{banner}</div></div>' + chat_col(t,th) + dock(t,comp))]
def s_nav(t, mobile):
    if mobile:
        drawer = (f'<div layer-name="Drawer scrim" style="position: absolute; left: 0; top: 0; width: 390px; height: 844px; background: {t("scrim")}; display: flex">'
                  f'<div layer-name="Drawer" style="display: flex; flex-direction: column; width: 312px; height: 844px; padding-top: 54px; background: {t("sidebar")}">{sidebar(t,"Atlas").replace("width: 272px","width: 312px").replace("border-right: 1px solid","border-right: 0px solid")}</div></div>')
        base = s_chat(t, True, 'rest')
        return base + [drawer]
    acct = (f'<div layer-name="Account menu" style="position: absolute; left: 12px; bottom: 64px; width: 248px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 14px; background: {t("elevated")}; border: 1px solid {t("border")}; box-shadow: 0 10px 24px -6px #1C1C1C26">'
            f'<div style="display: flex; flex-direction: column; padding: 8px 10px">{txt("Test User",t("ink"),14,600)}{txt("user@example.com",t("text3"),12)}</div>'
            + ''.join(f'<div style="display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; border-radius: 8px">{icon(ic,t("dangertext") if l=="Log out" else t("text2"),16)}{txt(l,t("dangertext") if l=="Log out" else t("ink"),14,500,extra="flex: 1;")}{txt(h,t("text3"),12)}</div>' for ic,l,h in [('gear','Settings','Ctrl ,'),('gauge','Usage',''),('term','Models & access',''),('blocks','Connect apps',''),('logout','Log out','')]) + '</div>')
    d = s_chat(t, False, 'rest')
    sb = d[0].replace('width: 272px;','width: 76px;')
    # collapsed rail variant
    rail = (f'<div layer-name="Collapsed sidebar" style="display: flex; flex-direction: column; justify-content: space-between; align-items: center; width: 76px; height: 100%; padding: 12px 0; background: {t("sidebar")}; border-right: 1px solid {t("bsoft")}; flex-shrink: 0">'
            f'<div style="display: flex; flex-direction: column; align-items: center; gap: 8px">{flock(28,t("primary"),"#7787E1")}{iconbtn("panel",t,40)}{iconbtn("search",t,40)}{iconbtn("tasks",t,40)}'
            f'<div style="height: 1px; width: 32px; background: {t("bsoft")}"></div>'
            + ''.join(f'<div style="display: flex; padding: 3px; border-radius: 14px; border: 2px solid {t("primary") if i==0 else "transparent"}">{bot_av(t,c,36)}</div>' for i,c in enumerate(['pink','green','orange'])) + f'{iconbtn("plus",t,40,"bordered")}</div>'
            f'<div style="display: flex; flex-direction: column; align-items: center; gap: 8px">{logo("claude",t,20)}<div style="display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 16px; background: {t("primary")}">{txt("TU",t("onprimary"),12,600)}</div></div></div>')
    return [rail, d[1][:-6] + acct.replace('left: 12px','left: 12px') + '</div>']
