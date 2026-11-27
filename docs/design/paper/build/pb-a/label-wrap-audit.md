# Label wrapping audit

The picker inherited arbitrary word breaking from product-label styles. Those rules are removed from the composer picker, Bot model field, ProviderLabel, sidebar usage, Usage model rows, connection headings, settings row labels and setup controls. Model words are wrapped in non-breaking spans so explicit hyphens inside a model name are not additional break points. `Default (recommended)` is exercised with actual word-range geometry at 320, 390, 500, 768 and 1280 in both themes.

Provider marks always retain their own 16 px flex slot. Labels can use complete short alternatives or wrap beside that slot. The geometry suite covers composer, picker, sidebar usage, Models & access, Bot settings, Usage, Search and named runs. No label is replaced with an empty string to make room for its logo.

## Retained technical wrapping

`model-picker__id`, `cfg-pair__code`, `lib-err`, MCP folder paths, invitation codes, configuration/source `pre` elements and knowledge revision/hash text contain raw IDs, keys, paths or code. These retain arbitrary wrapping. User-authored message bodies, tool fields and diagnostic error strings can also contain raw references; their rendering is outside the model/provider label contract.

## Owning-stream sweep

The inventory below includes inherited rules on other screens. In particular, generic card titles, Bot identity text, task content, setup page headings, connection prose and loading notices still use broad wrapping rules. Their owners should separate human labels from raw references during the P5 to P20 rebuild rather than applying one global word-breaking rule. PB-A does not restructure those parallel screens. This inventory is a follow-up list, not a claim that the whole application has completed P20.

```
web/src/components/config/KnowledgePanels.tsx:43: <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</div>
web/src/components/config/KnowledgePanels.tsx:75: {r.resources && Object.entries(r.resources).map(([path, content]) => <details key={path}><summary>{path}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</pre></details>)}
web/src/components/config/KnowledgePanels.tsx:86: return <>{evaluations.map(e=><details key={e.id}><summary>Evaluation: {e.status} · {e.results.length} frozen cases</summary><p>{e.reason}</p><p className="cfg-field__hint">Policy {e.policyRevision} · Settings {e.settingsRevision} · {e.evaluator}</p>{e.results.map(r=><p key={r.id}>{r.id} ({r.category}): {r.passed?'passed':'failed'} · expected {r.expected}, observed {r.actual} · baseline {r.baseline}</p>)}<p className="cfg-field__hint" style={{overflowWrap:'anywhere'}}>Candidate {e.candidateHash}<br/>Sources {e.sourceHash}<br/>Rollback baseline {e.baseHash}</p></details>)}</>;
web/src/components/config/native-learning.css:46: .knowledge-source__result { padding: 12px 0; border-top: 1px solid var(--color-border-tertiary); overflow-wrap: anywhere; }
web/src/components/config/native-learning.css:49: .knowledge-item { min-width: 0; border-bottom: 1px solid var(--color-border-tertiary); overflow-wrap: anywhere; }
web/src/components/config/native-learning.css:59: .knowledge-item__diff { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow: auto; }
web/src/components/config/workArea.css:13: overflow-wrap: anywhere;
web/src/components/config/workArea.css:57: .work-ui :is(pre, code) { white-space: pre-wrap; overflow-wrap: anywhere; }
web/src/components/coworker-setup.css:2: .coworker-setup { border: 1px solid var(--color-border-secondary); border-radius: 16px; padding: 18px; background: var(--color-bg-sidebar); overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
web/src/components/setup-banner.css:8: .setup-banner__text { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
web/src/styles/access-apps.css:37: .access-apps-catalog :is(.app-row__name, .app-row__desc, .app-row__error) { max-height: none; opacity: 1; white-space: normal; overflow: visible; overflow-wrap: anywhere; text-overflow: clip; }
web/src/styles/access-apps.css:46: .access-apps-catalog .apps-empty { padding: 20px 0; text-align: left; color: var(--color-text-secondary); overflow-wrap: anywhere; }
web/src/styles/access-apps.css:48: .access-apps-catalog .apps-pagination > [role='alert'] { flex-basis: 100%; color: var(--color-danger-text); overflow-wrap: anywhere; }
web/src/styles/access-apps.css:61: .access-apps-settings__errors [role='alert'] { overflow-wrap: anywhere; }
web/src/styles/agent-configuration.css:23: overflow-wrap: anywhere;
web/src/styles/agent-configuration.css:83: .agent-config__prompt, .agent-config__file pre { max-height: min(440px, 55dvh); overflow: auto; margin: 0; padding: 12px; border-radius: 8px; background: var(--color-bg-subtle); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono-stack); font-size: 12px; font-weight: 400; line-height: 20px; scrollbar-width: thin; }
web/src/styles/auth-callback.css:10: .auth-callback__message { flex: 1 1 320px; min-width: 0; margin: 0; color: var(--color-danger-text); font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
web/src/styles/bot-details.css:10: .details--sidebar .bot-detail-identity h1 { font: 600 var(--text-panel-title)/1.3 'Instrument Sans Variable', 'Instrument Sans', var(--font-stack); letter-spacing: -.025em; margin: 0; overflow-wrap: anywhere; }
web/src/styles/bot-details.css:11: .bot-detail-identity p { max-width: 100%; overflow-wrap: anywhere; margin: 0; color: var(--color-text-secondary); font-size: var(--text-sm); }
web/src/styles/bot-details.css:23: .details--sidebar :is(.bot-detail-card, .panel-card) { background: var(--color-bg-pane); border: 1px solid var(--color-border-secondary); border-radius: 16px; padding: 4px 12px; overflow-wrap: anywhere; }
web/src/styles/bot-details.css:47: .details--sidebar .work-row { min-width: 0; overflow-wrap: anywhere; padding: 14px; border: 1px solid var(--color-border-secondary); border-radius: 16px; background: var(--color-bg-pane); }
web/src/styles/bot-details.css:48: .details--sidebar :is(.work-row > *, .details-page__row > div, .details-page__column) { min-width: 0; overflow-wrap: anywhere; }
web/src/styles/bot-details.css:66: .details--sidebar :is(.agent-config__title, .agent-config__row, .agent-history, .knowledge-files) { min-width: 0; overflow-wrap: anywhere; }
web/src/styles/cards.css:8: .card__title, .question-card__q, .card__sub { overflow-wrap: anywhere; }
web/src/styles/cards.css:11: .card__body { padding: 8px 16px 0; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
web/src/styles/cards.css:30: .question-option__label { min-width: 0; overflow-wrap: anywhere; padding: 2px 6px 0; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-text-primary); }
web/src/styles/cards.css:51: .draft-card__subject { overflow-wrap: anywhere; padding-top: 12px; font-size: 14px; font-weight: 600; line-height: 20px; }
web/src/styles/cards.css:52: .draft-card__text { padding-top: 12px; font-size: 14px; line-height: 20px; letter-spacing: 0.14px; color: var(--color-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
web/src/styles/cards.css:60: .tool-preview__fields dd { min-width: 0; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
web/src/styles/cards.css:62: .tool-preview__text { white-space: pre-wrap; overflow-wrap: anywhere; }
web/src/styles/cards.css:65: .tool-preview__note { margin: 10px 0 0; font-size: 13px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
web/src/styles/cards.css:68: .tool-preview__details pre { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
web/src/styles/cards.css:69: .draft-card__to-name { white-space: pre-wrap; overflow: visible; overflow-wrap: anywhere; }
web/src/styles/chat.css:56: .agent-exchange__participants { margin: 0 0 12px; overflow-wrap: anywhere; }
web/src/styles/chat.css:59: .agent-exchange__meta strong { color: var(--color-ink); font-weight: 500; overflow-wrap: anywhere; }
web/src/styles/chat.css:61: .agent-exchange__messages p { color: var(--color-ink); margin: 4px 0 0; overflow-wrap: anywhere; line-height: 1.5; }
web/src/styles/chat.css:95: box-shadow: var(--bubble-ring); overflow-wrap: anywhere;
web/src/styles/chat.css:153: overflow-wrap: anywhere;
web/src/styles/chat.css:176: .saved-file-result { display: flex; flex-wrap: wrap; gap: 4px 12px; max-width: 100%; padding: 8px 0; font-size: 13px; line-height: 20px; color: var(--color-text-primary); overflow-wrap: anywhere; }
web/src/styles/chat.css:185: .step__label { overflow-wrap: anywhere; min-width: 0; }
web/src/styles/chat.css:191: .activity-line__text { overflow-wrap: anywhere; min-width: 0; }
web/src/styles/config.css:42: .cfg-error { padding: 8px 10px; border-radius: 8px; background: var(--color-danger-bg); color: var(--color-danger-text); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
web/src/styles/config.css:74: .cfg-look__name { max-width: 100%; overflow-wrap: anywhere; font-size: 17px; font-weight: 500; line-height: 24px; color: var(--color-text-primary); }
web/src/styles/config.css:103: .cfg-item__body { font-size: 13px; line-height: 19px; color: var(--color-text-primary); overflow-wrap: anywhere; }
web/src/styles/config.css:127: .lib-err { display: block; margin-top: 4px; font-family: var(--font-mono-stack); font-size: 11px; overflow-wrap: anywhere; }
web/src/styles/config.css:157: .cfg-pair__code { flex: 1; min-width: 0; font-family: var(--font-mono-stack); font-size: 11.5px; line-height: 1.5; padding: 8px 10px; border-radius: 8px; background: var(--color-bg-tertiary); color: var(--color-text-primary); word-break: break-all; user-select: all; }
web/src/styles/config.css:177: .model-picker__id { font-family: var(--font-mono-stack); font-size: 11px; color: var(--color-text-tertiary); white-space: normal; overflow-wrap: anywhere; min-width: 0; }
web/src/styles/connected-account-details.css:1: .connected-account-details { display: block; min-width: 0; max-width: 100%; margin-top: 4px; font-size: 13px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
web/src/styles/details.css:60: .details--page .details-page__row > div:first-child { min-width: 0; overflow-wrap: anywhere; }
web/src/styles/load-feedback.css:1: .load-feedback { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; flex-shrink: 0; padding: 16px; margin-block: 8px; border: 1px solid var(--color-border-secondary); border-radius: 12px; color: var(--color-text-primary); background: var(--color-bg-pane); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
web/src/styles/messaging.css:41: .msg-facts__v { flex: 1; min-width: 0; color: var(--color-text-primary); overflow-wrap: anywhere; }
web/src/styles/messaging.css:165: .access-invite .join__panel code { display: block; margin-top: 8px; overflow-wrap: anywhere; white-space: normal; }
web/src/styles/modals.css:13: .confirm-dialog .modal__title { min-width: 0; overflow-wrap: anywhere; }
web/src/styles/paper-core.css:110: .group-create__member strong { font-weight: 500; overflow-wrap: anywhere; }
web/src/styles/settings.css:155: .mcp-folder-path { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
web/src/styles/settings.css:156: .app-settings .mcp-editor .mcp-folder-choice { max-width: 100%; height: auto; padding-block: 10px; white-space: normal; overflow-wrap: anywhere; }
web/src/styles/settings.css:164: .app-settings .mcp-tools > div { margin-top: 10px; font-size: 13px; line-height: 18px; overflow-wrap: anywhere; color: var(--color-text-primary); }
web/src/styles/setup-paper.css:42: overflow-wrap: anywhere;
web/src/styles/setup-paper.css:67: .bot-settings-page__content { min-width: 0; overflow-wrap: anywhere; }
web/src/styles/setup-paper.css:73: .bot-settings-page__content :is(.native-panel, .native-history) { grid-template-columns: minmax(0, 1fr); overflow-wrap: anywhere; }
web/src/styles/setup-paper.css:74: .bot-settings-page__content :is(.cfg-editor, .cfg-field__hint) { min-width: 0; overflow-wrap: anywhere; }
web/src/styles/setup-paper.css:76: .bot-settings-page__content .cfg-item__sub { white-space: normal; overflow-wrap: anywhere; }
web/src/styles/shell.css:58: .account .menu__header { overflow-wrap: anywhere; }
web/src/styles/shell.css:87: .bots-view__item strong { font-weight: 500; overflow-wrap: anywhere; }
web/src/styles/shell.css:88: .bots-view__item small { color: var(--color-text-secondary); font-size: 13px; overflow-wrap: anywhere; }
web/src/styles/signin-brand.css:57: .access-signin .phone-auth__help { overflow-wrap: anywhere; }
web/src/styles/subscriptions.css:17: .subscription-settings p { margin: 0; font-size: 13px; line-height: 20px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
web/src/styles/subscriptions.css:20: .subscription-settings .cfg-row__sub { overflow-wrap: anywhere; }
web/src/styles/subscriptions.css:29: .subscription-settings pre { margin: 0; min-width: 0; padding: 12px; border-radius: 8px; background: var(--color-bg-tertiary); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/19px var(--font-mono-stack); color: var(--color-text-primary); user-select: text; }
web/src/styles/subscriptions.css:31: .subscription-settings p code { font-family: var(--font-mono-stack); font-size: 12px; overflow-wrap: anywhere; }
web/src/styles/subscriptions.css:60: .subscription-settings__details dd { margin: 0; overflow-wrap: anywhere; color: var(--color-text-primary); }
web/src/styles/subscriptions.css:109: .subscription-settings .cli-login-terminal__footer { padding: 14px 16px; border-top: 1px solid var(--color-border-tertiary); color: var(--color-text-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
web/src/styles/suggested-integrations.css:8: .suggested-integration__text p, .suggested-integrations__note { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--color-text-secondary); overflow-wrap: anywhere; }
web/src/styles/tasks.css:39: .task-card__body { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
web/src/styles/voice.css:123: .vcall__line { padding: 12px 16px; font-size: 15px; line-height: 1.55; overflow-wrap: anywhere; }
```
