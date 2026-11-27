# Client runtime

The public hooks in `index.ts` match spec 22.2. Their state comes from the real `/api/ui` endpoints and the existing per-user SSE connection. `main.tsx` starts the runtime once; it never delays rendering for a config request.

- `useUiConfig()` returns the saved document, revision and loading, ready, offline or disabled status.
- `useEffectiveConfig()` resolves saved config or the active preview, phone overlay and safe mode.
- `useComponentVisible(id)` returns a registered visibility value, with a render-time default guard.
- `useUiPatch()` performs a revision-checked PATCH. A conflict refreshes saved state and returns structured errors. It never retries a write silently.
- `usePreview()` controls the current preview. Expiry, reload and sign-out discard local preview state.
- `openSafeMode()` enters safe mode for this tab. Recovery also works through `?ui=safe` and `Mod+Alt+0`.

Settings/import callers can use `loadPreview(id)` and `refreshUiConfig()` from `store.ts` after their API calls. Agent previews are loaded automatically only in tabs showing the event's Bot conversation. `safeMode.ts` exports `closeSafeMode()` for recovery surfaces.

Dashboard routes use `{ kind: 'dash', dashboard: reference }`. `dashboardSlug()` creates readable references and `routeDashboard()` resolves stable ids, current slugs and old names ending in a stable id against the current user's dashboards. Appearance is `#settings/appearance`.

The applier only writes registered colors and fixed enum mappings. The saved cache is account scoped, schema validated and cleared at sign-out or feature disable. Its four token maps cover light, dark and phone overlays. Previews are never cached. `web/public/ui-boot.js` is a classic blocking same-origin script. Regenerate it with `node tests/ui-custom/build-client-boot.mjs`; that also updates the content hash in its URL. Production HTML is served with `Cache-Control: no-cache`, so each changed script gets a new cache key.

Atkinson Latin regular and bold WOFF2 subsets come from `@fontsource/atkinson-hyperlegible` with the included OFL license. Each file is below 18 KB. CSS requests a face only when used.

Local checks:

```sh
npm run typecheck
node --import tsx --test tests/ui-custom/unit/client-runtime.test.mts
node tests/ui-custom/unit/client-runtime-ui.mjs
node tests/ui-custom/unit/client-production-ui.mjs
node tests/ui-custom/unit/client-performance-ui.mjs
node tests/ui-custom/unit/client-defaults-ui.mjs
node tests/ui-custom/unit/client-scale-matrix-ui.mjs
node tests/ui-custom/unit/client-composer-ui.mjs
node tests/ui-custom/demo-d.mjs
node tests/layout-alignment-ui.mjs
node tests/ui-custom/run-all.mjs
```

Default snapshot comparisons record main in a detached checkout and compare resolved CSS token values and route geometry at 390 and 1280 in both modes. Transient transcript scroll position is normalized before sampling. Evidence is written under `.context/ui-custom/`.

The scale matrix runs the unchanged Paper alignment audit at default and xlarge in all three densities at 390 and 1280. The live composer check preserves drafts while changing scale and font family, verifies the six-line cap and internal scrolling, and checks shrinking after deletion. Both are discovered automatically by `run-all.mjs`.
