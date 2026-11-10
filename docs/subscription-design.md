# Subscription connection design

Source: [Paper — Swarm, Brand · Logos & motion](https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-G-0), read through Paper MCP. The identity board is `15SZ-0`, workflow components are `15T1-0`, and the type specimen is `166Z-0`.

The subscription page follows the current Paper identity:

- Instrument Sans, variable weight 550, served locally through Fontsource. Terminal output remains monospace.
- Paper `#FBFAF7`, Ink `#18202A`, Slate `#525B5E`, Indigo `#3043AB`, Mist `#EDEFFA`, Night `#17222F`, and Mono `#14171B`.
- The flock uses the exact SVG paths from Paper's `165R-0` symbol, at 32px in the page header and 24px beside the terminal status.
- Indigo actions and active tabs, mist selection fills, 12px card radii, thin separators, and a 24px section rhythm.
- The terminal follows light/dark appearance without restarting the login. Its ANSI palette uses semantic colors with a minimum text contrast ratio of 4.5. Reduced motion disables cursor blinking.
- Phones retain side-by-side authentication choices, readable connection rows, a full-width primary login action, and a 44px terminal close target.

The brand is scoped to the subscription settings page and its surrounding settings navigation while that page is open. Shared global tokens and other settings pages retain their existing styling. The existing account routing, provider authorization, terminal transport, and billing behavior remain unchanged.
