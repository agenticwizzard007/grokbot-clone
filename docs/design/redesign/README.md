# Redesign evidence

Before captures use unchanged `origin/main` at `3fbca49d3bd4807d70dc3e267b4dd49097af0813`, before the settings simplification and visual polish prerequisites. Captured locally on 2026-11-23 with Chromium, a 900px viewport height, Night theme, reduced motion, UTC and mocked APIs. The screenshots contain fictional test fixtures, no live account data.

Widths: 390, 1280 and 1440px. Names are `screen-width.png`. The phone also has `settings-list-390.png`. Models & access is captured with both Claude Code (`models-access`) and Codex (`models-codex`) selected. `chat-scrolled` shows the baseline icon-only jump control in before and the labelled Jump to latest pill in after.

The final after directory is refreshed in the settings PR so every screen reflects the complete sequence. Intermediate PRs refresh the screens they change. Capture files are first saved under `.context/redesign/`, then copied here for review and download.

Reproduce with a local build and the redesign Playwright runner documented in the final PR. Every API request uses fixtures and external browser requests are blocked. No provider login, microphone session or real data mutation is performed.

The approved layout rules and reference inventory are in [the spec](../redesign-spec.md).
