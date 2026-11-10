# Shared sign-in design

Design source: [Paper — Sign in · Web & Mobile](https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-4-0).

The web, iOS, and macOS apps render the same hosted sign-in view. The existing Swarm mascot and provider artwork are reused.

- `AuthButton` and `AuthLink` share one style: 48px height, 15px/20px medium text, 0.14px tracking, 16px horizontal padding, 20px icon slots, and 12px gaps. A matching empty slot keeps every label centered.
- All primary options use the same theme tokens for foreground, background, hover, and keyboard focus. Loading labels keep the same dimensions.
- The card uses 32px vertical and 24px horizontal padding, 24px section spacing, 12px control spacing, and 8px label spacing. At 320px, horizontal card padding reduces to 16px so button labels stay on one line.
- Supporting text shares the secondary text token and 12px/18px typography. The Google disclosure retains the Gmail permission explanation.
- Short windows scroll the whole card, preserving access to the header, phone verification controls, and footer.

Keep provider configuration gating and existing auth URLs intact when changing this view. Account linking and phone verification reuse these controls.

OpenRouter uses the shared auth control on the hosted sign-in view and opens the system authentication browser in native shells. It is available without Composio or a server model key. Existing accounts connect it from Settings → API keys. See [OpenRouter sign-in](openrouter-sign-in.md).
