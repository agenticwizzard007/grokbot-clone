# Usage mode bubble

Designed in [Paper · Composer & Analytics](https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-2-0), in the “Usage mode · Subscription & API bubbles” artboard. The bubble has its own row above the composer, so its label remains readable beside long model names and on small phones.

Subscription mode uses Paper's indigo (`#3043AB`) and mist (`#EDEFFA`) tokens. API mode uses the app's neutral surface and text tokens. Both use a 36px rounded pill inside a minimum 44px touch target, 13px Instrument Sans, 8px gaps, and 12px horizontal padding. The existing smaller billing label is hidden only inside the composer; model menu rows retain their labels.

The source is the authenticated model catalog's `billing` and `provider`, never a model name or a zero-dollar usage entry. A reported plan name is displayed when available. Missing plan names retain a generic subscription label. Loading and error states explicitly say “Checking usage…” and “Check connection.” The bubble describes the selected connection for model requests; it is not a historical receipt or a claim that all services are included in the subscription.

Tapping opens a desktop popover or a phone bottom sheet. Subscription details show provider-reported percentages, reset times, and the last check time. Missing usage is shown as unavailable, with no invented percentage. API details link to recorded Usage and API key settings. Subscription management opens Subscriptions. Neither opening the bubble nor refreshing it changes the billing mode.

The panel supports Escape, focus return, keyboard focus containment, dark mode, reduced motion, long plan names, and scrolling when space is limited. Account changes close the old account's detail panel; the shared model store clears its cached account data.

Validation: `npm run typecheck -w web`, `npm run build -w web`, and `node tests/usage-mode-ui.mjs`. Browser checks use the real composer with controlled account catalog responses at 1440px, 390px, and 320px in light and dark themes. Example plan names, percentages, and timestamps in screenshots are fixtures, not a real account's usage.

This UI depends on the model-catalog integration exposing `billing`, `provider`, `plan`, and `usage` through `useModels`. It makes no backend or credential-storage changes and does not establish production readiness for real subscription authentication.
