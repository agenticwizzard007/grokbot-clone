# Per-model effort picker names

You are the implementer for this item only. Do not take on the loader animation, plan connections, suggested integrations, or the round 3 leftovers. Those are in other Conductor workspaces and will have their own PRs.

## Your job
1. Read this brief fully. Commit it unchanged as `docs/qa/R3-EFFORT-PICKER.md` on your branch.
2. Implement the fix below. Verify supported effort lists in the catalog and in the current provider docs before you hard-code a fallback.
3. If this environment lets you spawn more agent sessions, spawn a reviewer or tester at model `gpt-6-astra` and effort `ultra` (agent `codex`). Do not silently pick a different model or effort. If those values are not offered, stop and report the exact mismatch.
4. Checks before the PR: `npm ci && npm run typecheck`, `tests/models.test.mts`, `tests/cli-effort-ui.mjs` (keep green and extend), plus any composer model menu tests. Keep every existing test green.
5. One branch and ONE PR to `main` titled `QA R3: per-model effort picker names`.
6. Merge only when CI is green. This item is third in the merge order, after the loader PR and the suggested-integrations PR. If those have landed, rebase onto `main` first. The plan-connections PR (title `QA R3: plan connections for Claude Max and ChatGPT`) also edits model selection: land this effort PR before that one, and mention the overlap in the PR body so the other workspace can rebase.
7. Guardrails: never commit or print secrets; no force push; no em dashes or en dashes in PR text, docs or new UI copy; no person's name in code, docs or PR text.

## Repo and live app

| Item | Value |
|---|---|
| Repo | https://github.com/agenticwizzard007/grokbot-clone |
| Commit tested | `main` @ `9f2481a2c805e86d1af93a43cf6703e18f5bfd19` |
| Live app | https://swarm-team.fly.dev |
| Deploy | "Deploy Fly staging" on merge to `main` |

## Sequencing
Merge order: (1) loader, (2) suggested integrations, (3) this effort picker, (4) plan connections, (5) leftovers last. Plan connections will also touch `ComposerModelMenu.tsx` and related model files. Keep your diff focused so they can rebase. Do not start a large rewrite of Settings subscription flows.

## Root cause
The picker already knows each model's accepted effort ids (from OpenRouter `reasoning.supported_efforts`, CLI catalog, or a direct-key default), but the visible labels are one global map.

- Labels: `EFFORT_LABEL` and `EFFORT_DESC` in `web/src/lib/models.ts:80-86`. Every model shows the same words: "No thinking", "Minimal", "Low", "Medium", "High", "Extra high", "Max", "Ultracode".
- Levels offered: `effortsFor` (`models.ts:91-97`) takes the model's `efforts` list, then for API billing prepends a synthetic `ultracode` level. Plan/CLI billing does not prepend it.
- The "ultra code" look is a CSS class, not a label: `ComposerModelMenu.tsx:76,80,229,292` adds `is-ultracode` only when the stored effort id is `'ultracode'`. Animation lives in `web/src/styles/composer-models.css:26-30` and `:103-129` (`uc-turn`, `uc-breathe`, `uc-flare`, rainbow conic glow).
- Bot settings uses the same generic ids in a segmented control (`BotSettingsModal.tsx` "Thinking effort" field, with `EFFORT_HINT`).
- Server snap: `server/src/lib/llm.ts:130-169` `effortFor` / `providerFields`. `ultracode` is sent as the model's top real level (`max` if present, else the highest supported). Type: `server/src/types.ts:275-280`.
- Catalog: `server/src/lib/llm.ts:215-226` copies `supported_efforts` and `default_effort` from OpenRouter. Suggested favourite ids in `server/src/routes-models.ts:28`: `anthropic/claude-opus-5.5`, `openai/gpt-5.5`, `anthropic/claude-sonnet-5.5`, `google/gemini-4-argon`, `x-ai/grok-4.7`. The live catalog is dynamic, so the UI must be driven by a per-model (or per-family) config, not a single hardcoded label list.

## Wanted behavior
Show each model's real effort names from the provider's current docs. The highest effort level of every model always uses the same cool animation the 'ultracode' label uses now. All other levels use that model's real names. Ultracode can remain an internal id that means "the model's top level", but the visible label for that top level should be the provider's own name (for example "Max" on Claude, "xhigh" or the provider's display words on GPT-5.5, "Xhigh" on Gemini 4 Hydrogen). Do not show the word "Ultracode" on a model whose docs never use it, unless the catalog literally has that name.

When the user changes model, map the saved effort to the closest supported level on the new model (existing `effectiveEffort` / `effortFor` behavior, kept and tested). Default per model comes from the catalog `defaultEffort` when present, otherwise the provider default cited below.

## Per-model effort map (from official docs, 23 Nov 2026)

Display names should be the provider's own level names, readable in the UI (for example "High", "Xhigh", "Max", "None", "Minimal"). Do not invent extra levels. If a catalog model is not in this table, use the catalog's `efforts` and `defaultEffort` as the source of truth and apply family fallbacks below, clearly marked in code comments as fallbacks.

### OpenAI (API `reasoning.effort`)

| Model | Levels (lowest to highest) | Default | Highest (must use ultra animation) | Source |
|---|---|---|---|---|
| GPT-5 (`gpt-5`, mini, nano) | minimal, low, medium, high | medium | high | https://developers.openai.com/api/docs/guides/latest-model/gpt-5 |
| GPT-5.1 | none, low, medium, high | none | high | https://developers.openai.com/api/docs/models/gpt-5.1 |
| GPT-5.2 | none, low, medium, high, xhigh | none | xhigh | https://developers.openai.com/api/docs/models/gpt-5.2 |
| GPT-5.2-Codex | low, medium, high, xhigh (no none) | not stated on the model page; fallback medium | xhigh | https://developers.openai.com/api/docs/models/gpt-5.2-codex |
| GPT-5.3-Codex | low, medium, high, xhigh (no none) | not stated on the model page; fallback medium | xhigh | https://developers.openai.com/api/docs/models/gpt-5.3-codex |
| GPT-5.4 | none, low, medium, high, xhigh | none | xhigh | https://developers.openai.com/api/docs/models/gpt-5.4 |
| GPT-5.5 | none, low, medium, high, xhigh | medium | xhigh | https://developers.openai.com/api/docs/models/gpt-5.5 |
| GPT-6.2 Astra | low, medium, high, xhigh, max (rejects none) | not fully quoted in the snippet used for this brief; confirm on the model page and use that default | max | https://developers.openai.com/api/docs/models/gpt-6.2-astra |

OpenAI's shared ReasoningEffort enum also lists `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but "Not all reasoning models support every value." Always prefer the model page. Confirm GPT-6.1 / GPT-6 / other Astra, Sol, Terra, Luna, and Codex variants on their current model pages before adding them. If a page is missing, fallback: use catalog `efforts` and `defaultEffort`, highest = last in the documented order (`none < minimal < low < medium < high < xhigh < max`).

### Anthropic (API `output_config.effort` / effort parameter)

Source: https://platform.claude.com/docs/en/build-with-claude/effort

Documented levels: `low`, `medium`, `high`, `xhigh`, `max`. Not every model that supports `max` supports `xhigh`.

| Model | Levels | Default | Highest | Notes |
|---|---|---|---|---|
| Claude Opus 5.5 | low, medium, high, xhigh, max | medium | max | https://platform.claude.com/docs/en/models/opus-5-5/migration-guide |
| Claude Sonnet 5.5 | low, medium, high, xhigh, max | high | max | https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5 |
| Claude Haiku 5.5 | all five (page lists it for max and xhigh) | medium | max | same effort page |
| Claude Opus 5 and earlier Opus listed on the effort page | see the page; default high when not Opus 5.5 / Haiku 5.5 | high unless the page says otherwise | max if listed, else the page's top level | https://platform.claude.com/docs/en/build-with-claude/effort |

Adaptive thinking on Opus 5.5 cannot be turned off, so there is no "none" level. Do not show "No thinking" for that model.

### Google Gemini (`thinking_level`)

Source: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking and https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate

Levels are `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`, `XHIGH` (map to the app's effort ids in lowercase). `thinking_budget` is deprecated and errors on Gemini 4. Do not send both.

| Model | Levels | Default | Highest | Source notes |
|---|---|---|---|---|
| Gemini 4 Argon / Gemini 4 Carbon | low, medium, high (no minimal, no xhigh) | medium (cyber-permissive variants default high) | high | migrate page |
| Gemini 4 Hydrogen | low, medium, high, xhigh (no minimal) | high | xhigh | thinking page: XHIGH "Supported on Gemini 4 Hydrogen" |
| Gemini 3.5 / 3.6 Flash family | minimal, low, medium, high (no xhigh in the 3.5 Flash write-up) | medium | high | https://docs.cloud.google.cn/gemini-enterprise-agent-platform/models/guides/gemini-3-5-flash |
| Earlier Gemini 2.5 | often numeric budgets, not these enums; if the catalog has no `efforts`, treat as no picker (fallback: hide effort, do not invent names) | | | thinking page |

The suggested favourite `google/gemini-4-argon` should render Low, Medium, High, with High animated as the top level.

### xAI Grok (`reasoning.effort`)

Source: https://docs.x.ai/developers/model-capabilities/text/reasoning and model pages.

| Model | Levels | Default | Highest | Source |
|---|---|---|---|---|
| Grok 4.7 | low, medium, high, xhigh (cannot disable) | high | xhigh | https://docs.x.ai/developers/grok-4-7 |
| Grok 4.6 | low, medium, high, xhigh | high | xhigh | https://docs.x.ai/developers/models/grok-4.6 |
| Grok 4.5 | low, medium, high (`xhigh` is treated as `high` if sent) | high | high | reasoning page |
| Grok 4.3 | none, low, medium, high (model page also mentions xhigh in one details table; confirm before exposing xhigh) | low | confirm on https://docs.x.ai/developers/models/grok-4.3 | reasoning page says 4.3 defaults to low and also accepts none |

The suggested favourite `x-ai/grok-4.7` should render Low, Medium, High, Xhigh, with Xhigh animated.

### Other catalog authors (DeepSeek, Qwen, Kimi / Moonshot, Mistral, Llama, Cohere, custom direct key)
No family-wide official effort names were collected for this brief. Fallback, clearly marked in code: if the catalog supplies `efforts`, show those ids in readable form and animate the highest; if `efforts` is empty, hide the picker (same as `deepseek/deepseek-v4` in `tests/models.test.mts`). The direct-key path today hardcodes `['low', 'medium', 'high', 'xhigh']` (`routes-models.ts:56`); keep sending those values but label them as the compatible direct-provider set, and animate `xhigh`.

## Files to change (likely)
- `web/src/lib/models.ts` (`EFFORT_LABEL`, `EFFORT_DESC`, `effortsFor`, `effectiveEffort`; add a per-model or per-family label map)
- `web/src/components/ComposerModelMenu.tsx` (apply the ultra animation to the model's highest level, not only `effort === 'ultracode'`)
- `web/src/styles/composer-models.css` (class name can stay `is-ultracode` or be renamed to a neutral "top effort" class; keep the same animation)
- `web/src/components/config/BotSettingsModal.tsx` (Thinking effort hints and segmented labels)
- `server/src/lib/llm.ts` only if mapping must change; do not break `effortFor` snap tests
- `tests/models.test.mts`, `tests/cli-effort-ui.mjs`

## Acceptance criteria
- Effort labels come from a per-model (or per-family) config plus the catalog, not from one global generic list shown for every model.
- For each model in the table above that the catalog actually offers, the picker lists only documented levels, with the documented default marked.
- The highest documented level of every model that has effort selection uses the current ultracode animation (pill, menu label, and composer glow), including when the stored id is the real top level (`max`, `xhigh`, `high`) rather than the synthetic `ultracode` id.
- Other levels show that model's real names (for example GPT-5.5 shows None, Low, Medium, High, Xhigh; Opus 5.5 shows Low, Medium, High, Xhigh, Max).
- Changing model maps the saved selection to a supported level on the new model. Defaults follow the table / catalog.
- Unit tests for labels, highest-level animation class, defaults, and cross-model mapping. Existing tests still pass, including `effortFor('ultracode', ...)` server snap tests.
