LIGHT = dict(pane="#FFFFFF", sidebar="#FBFAF7", active="#EDEFFA", subtle="#F5F6F7", hover="#EEF0F2",
  ink="#18202A", text2="#525B5E", text3="#697176", border="#DCDEE0", bsoft="#EBECEE",
  primary="#3043AB", primaryh="#29398C", onprimary="#FFFFFF", bubbleuser="#EDEFFA", bubbleagent="#FBFAF7",
  elevated="#FFFFFF", success="#27804F", successbg="#ECF4EE", warn="#9A5B08", warnbg="#FCF0DA",
  danger="#E72E3B", dangertext="#A1353D", dangerbg="#FCEDEE", scrim="#10161E73", pink="#E52F8B", green="#14A862", orange="#E8620E", teal="#13A592")
DARK = dict(pane="#1D2A3B", sidebar="#17222F", active="#30415E", subtle="#223144", hover="#283A50",
  ink="#FFFFFF", text2="#C4CBD5", text3="#AFB9C6", border="#3A4859", bsoft="#2B394B",
  primary="#B5C1FF", primaryh="#C2CBFA", onprimary="#17222F", bubbleuser="#3043AB", bubbleagent="#243347",
  elevated="#253348", success="#3CC384", successbg="#173A2E", warn="#F0B45A", warnbg="#3A3020",
  danger="#F05A64", dangertext="#FF9AA1", dangerbg="#3D2229", scrim="#00000099", pink="#F93498", green="#14C16F", orange="#FD690F", teal="#13B7A2")
DESC = dict(pane="Main content surface", sidebar="Sidebar and quiet panels", active="Selected row, user bubble tint", subtle="Inputs, chips, secondary fills",
  hover="Hover fill", ink="Primary text and icons", text2="Secondary text", text3="Tertiary text, hints", border="Control borders",
  bsoft="Dividers", primary="Brand primary, primary buttons, focus", primaryh="Primary hover", onprimary="Text on primary",
  bubbleuser="User message bubble", bubbleagent="Bot message bubble", elevated="Menus, sheets, composer, cards",
  success="Success text and dots", successbg="Success fill", warn="Warning text", warnbg="Warning fill", danger="Danger actions",
  dangertext="Danger text", dangerbg="Danger fill", scrim="Modal scrim", pink="Bot accent pink", green="Bot accent green", orange="Bot accent orange", teal="Bot accent teal")
def color_tokens():
    out=[]
    for mode,pal in (("light",LIGHT),("dark",DARK)):
        for k,v in pal.items():
            out.append({"type":"color","name":f"--color-{mode}-{k}","value":v,"description":f"{DESC[k]} ({mode} theme)"})
    return out
OTHER = [
 {"type":"fontFamily","name":"--font-sans","value":"Inter","description":"Body and UI"},
 {"type":"fontFamily","name":"--font-heading","value":"Instrument Sans","description":"Page titles and wordmark"},
 {"type":"fontSize","name":"--text-xs","value":"12px"},{"type":"fontSize","name":"--text-sm","value":"13px"},
 {"type":"fontSize","name":"--text-base","value":"14px"},{"type":"fontSize","name":"--text-message","value":"15px"},
 {"type":"fontSize","name":"--text-lg","value":"17px"},{"type":"fontSize","name":"--text-title","value":"24px"},{"type":"fontSize","name":"--text-display","value":"32px"},
 {"type":"fontWeight","name":"--font-weight-regular","value":400},{"type":"fontWeight","name":"--font-weight-medium","value":500},{"type":"fontWeight","name":"--font-weight-semibold","value":600},
 {"type":"lineHeight","name":"--leading-caption","value":"16px"},{"type":"lineHeight","name":"--leading-body","value":"20px"},{"type":"lineHeight","name":"--leading-message","value":"24px"},{"type":"lineHeight","name":"--leading-title","value":"32px"},
 {"type":"letterSpacing","name":"--tracking-tight","value":"-0.02em"},{"type":"letterSpacing","name":"--tracking-label","value":"0.02em"},
 {"type":"spacing","name":"--spacing-1","value":"4px"},{"type":"spacing","name":"--spacing-2","value":"8px"},{"type":"spacing","name":"--spacing-3","value":"12px"},
 {"type":"spacing","name":"--spacing-4","value":"16px"},{"type":"spacing","name":"--spacing-5","value":"24px"},{"type":"spacing","name":"--spacing-6","value":"32px"},
 {"type":"spacing","name":"--spacing-7","value":"40px"},{"type":"spacing","name":"--spacing-8","value":"48px"},
 {"type":"radius","name":"--radius-sm","value":"8px"},{"type":"radius","name":"--radius-md","value":"12px"},{"type":"radius","name":"--radius-card","value":"16px"},
 {"type":"radius","name":"--radius-composer","value":"24px"},{"type":"radius","name":"--radius-full","value":"9999px"},
 {"type":"container","name":"--container-sidebar","value":"272px"},{"type":"container","name":"--container-content","value":"752px"},{"type":"container","name":"--container-settings","value":"640px"},
 {"type":"breakpoint","name":"--breakpoint-phone","value":"480px"},{"type":"breakpoint","name":"--breakpoint-tablet","value":"768px"},{"type":"breakpoint","name":"--breakpoint-desktop","value":"1024px"},
 {"type":"opacity","name":"--opacity-disabled","value":0.4},
]
