import json, sys, os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from comp import T
ID_RX = r'"id"\s*:\s*"([0-9A-Za-z]+-[0-9]+)"'
PG_RX = r'"pageId"\s*:\s*"([^"]+)"||"id"\s*:\s*"([^"]+)"'
def artboard_calls(fid, pagetag_or_id, slug, name, chunks, mobile, x, y, fit=False, page_literal=False):
    pg = pagetag_or_id if page_literal else '{{%s~%s}}' % (pagetag_or_id, PG_RX)
    W,H = (390,844) if mobile else (1280,900)
    st = {"width":f"{W}px","height":f"{H}px","display":"flex","flexDirection":"column" if mobile or fit else "row","backgroundColor":None,"overflow":"hidden","left":f"{x}px","top":f"{y}px","position":"relative"}
    calls=[{"name":"create_artboard","arguments":{"fileId":fid,"pageId":pg,"name":name,"styles":st},"tag":"ab_"+slug}]
    ref='{{ab_%s~%s}}' % (slug, ID_RX)
    for i,c in enumerate(chunks):
        calls.append({"name":"write_html","arguments":{"fileId":fid,"html":c,"targetNodeId":ref,"mode":"insert-children"},"tag":f"w_{slug}_{i}","stop_on_error":True})
    if fit:
        calls.append({"name":"update_styles","arguments":{"fileId":fid,"updates":[{"nodeIds":[ref],"styles":{"height":"fit-content"}}]},"tag":"fit_"+slug})
    calls.append({"name":"get_screenshot","arguments":{"fileId":fid,"nodeId":ref,"scale":1},"tag":"shot_"+slug,"timeout":240})
    return calls
def variants(fid, page, row, slug, title, fn, page_literal=False, **kw):
    """fn(t, mobile) -> chunks"""
    calls=[]
    for mode in ('light','dark'):
        t=T(mode)
        for mobile in (False, True):
            x = {('light',False):0,('dark',False):1360,('light',True):2720,('dark',True):3190}[(mode,mobile)]
            nm = f"{title} · {'Mobile 390' if mobile else 'Desktop 1280'} · {mode.title()}"
            sl = f"{slug}-{'m' if mobile else 'd'}-{mode[0]}"
            calls += artboard_calls(fid, page, sl, nm, fn(t,mobile), mobile, x, row*1000, page_literal=page_literal)
    return calls
def fix_bg(calls):
    from tokens import LIGHT, DARK
    for c in calls:
        if c["name"]=="create_artboard":
            mode = 'light' if c["arguments"]["name"].endswith('Light') else 'dark'
            c["arguments"]["styles"]["backgroundColor"] = f"var(--color-{mode}-pane)"
    return calls
def finalize(calls, path):
    first=True
    for c in calls:
        if c.get("stop_on_error"):
            if first: first=False
            else: c.pop("stop_on_error")
    json.dump(calls,open(path,'w'))
    return calls

XPOS={('light',False):0,('dark',False):1360,('light',True):2720,('dark',True):3190}
def screen_calls(fid, page_ref, row_i, slug, title, fn, page_literal=True, fit=False, chunks_fn=None):
    calls=[]
    for mode in ('light','dark'):
        t=T(mode)
        for mobile in (False, True):
            nm = f"{title} · {'Mobile 390' if mobile else 'Desktop 1280'} · {mode.title()}"
            sl = f"{slug}-{'m' if mobile else 'd'}-{mode[0]}"
            pg = page_ref if page_literal else '{{%s~%s}}' % (page_ref, PG_RX)
            W,H = (390,844) if mobile else (1280,900)
            st={"width":f"{W}px","height":f"{H}px","display":"flex","flexDirection":"column" if (mobile or fit) else "row","backgroundColor":f"var(--color-{mode}-pane)","overflow":"hidden","position":"relative"}
            ref='{{ab_%s~%s}}' % (sl, ID_RX)
            calls.append({"name":"create_artboard","arguments":{"fileId":fid,"pageId":pg,"name":nm,"styles":st},"tag":"ab_"+sl})
            calls.append({"name":"update_styles","arguments":{"fileId":fid,"updates":[{"nodeIds":[ref],"styles":{"left":f"{XPOS[(mode,mobile)]}px","top":f"{row_i*1000}px"}}]},"tag":"pos_"+sl})
            for i,c in enumerate(fn(t,mobile)):
                calls.append({"name":"write_html","arguments":{"fileId":fid,"html":c,"targetNodeId":ref,"mode":"insert-children"},"tag":f"w_{sl}_{i}"})
            if fit: calls.append({"name":"update_styles","arguments":{"fileId":fid,"updates":[{"nodeIds":[ref],"styles":{"height":"fit-content"}}]},"tag":"fit_"+sl})
            calls.append({"name":"export","arguments":{"fileId":fid,"nodes":{ref:[{"format":"png","scale":"1x"}]}},"tag":"exp_"+sl,"timeout":240})
    return calls
