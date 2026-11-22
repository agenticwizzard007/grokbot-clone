# Effort picker source verification

Checked on 2026-11-22 against the public [OpenRouter catalog](https://openrouter.ai/api/v1/models) and the official sources in the unchanged [brief](R3-EFFORT-PICKER.md).

The shared capability policy intersects known model levels with catalog support. An explicitly empty list stays empty. A null list uses a verified model fallback when available. Other versions and providers use catalog metadata only. Catalog defaults take precedence over documented provider defaults. Existing saved preferences remain selections, separate from the default marker.

| Case | Verified behavior |
| --- | --- |
| GPT-5 through GPT-5.5 | Model pages confirm the brief's level sets and defaults. GPT-5.2-Codex and GPT-5.3-Codex do not state a default, so medium is an explicit app fallback. The catalog includes none for GPT-5.3-Codex; the documented set excludes it. |
| GPT-6.2 Astra | The [model page](https://developers.openai.com/api/docs/models/gpt-6.2-astra) rejects none. The [current guide](https://developers.openai.com/api/docs/guides/latest-model) recommends starting at medium and replacing none/minimal with low, but does not declare the complete set or omitted-parameter default. Use the catalog's low, medium, high, xhigh, max and default medium. Do not invent a missing-metadata default. |
| Claude | The [effort page](https://platform.claude.com/docs/en/build-with-claude/effort) confirms the five levels for Opus 5.5, Sonnet 5.5 and Haiku 5.5. Opus 4.6 supports max but lacks xhigh. Opus 5.5 defaults to medium in the docs but high in the catalog; the catalog wins. Haiku's catalog includes none, which is not an effort level in the provider docs. |
| Claude Code | [CLI model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level) specifies medium for Opus 5.5, Sonnet 5.5 and Haiku 5.5, and xhigh for Opus 4.7. Keep these Plan fallbacks separate from API defaults. An explicit account default wins, and unverified CLI defaults remain unknown. |
| Gemini | The [thinking table](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking) confirms Argon/Carbon low through high, default medium, and Hydrogen low through xhigh, default high. Hydrogen's catalog default is medium and wins. Cyber variants default high. Gemini 3.5 Flash-Lite defaults minimal, unlike 3.5/3.6 Flash. Gemini 2.5 without effort metadata gets no picker. |
| Grok | The [reasoning guide](https://docs.x.ai/developers/model-capabilities/text/reasoning) confirms 4.7/4.6 low through xhigh, default high, and 4.5 low through high. The [4.3 page](https://docs.x.ai/developers/models/grok-4.3) has conflicting xhigh support text; use the common documented set, none through high, also reported by the catalog, default low. |
| Compatible direct providers | Preserve the existing low, medium, high, xhigh set and medium default. The UI identifies this as compatible direct-provider effort. |

Both API and CLI catalogs apply the shared normalization before model information reaches generation. This keeps old saved values consistent with the picker without changing the generic server snapping contract, including `effortFor('ultracode', null) === 'max'`.
