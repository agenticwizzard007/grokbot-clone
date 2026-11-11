# Subscription connection design

The established platform UI remains the base: shared typography, neutral light/dark surfaces, settings navigation, heading hierarchy, 16px card frames, and standard button colors and states from `tokens.css`, `settings.css`, and `config.css`. Opening Subscriptions does not change the surrounding settings shell.

Swarms brand accents complement the shared platform UI:

- A small Swarms signature uses the flock mark at 24px. Its label and the rest of the interface use the shared platform font stack.
- Indigo `#3043AB` and Mist `#EDEFFA` appear only in the flock, selection indicators, and restrained tints. Primary buttons retain the platform's neutral treatment.
- Swarms provider tabs identify Claude Code with its pixel mascot, including its eyes and four legs, and Codex with the OpenAI knot. Both assets are bundled locally; the OpenAI mark inherits the tab's text color in either theme. Provider names remain visible and accessible.
- The terminal follows the platform's semantic background and text colors. Theme changes repaint the running terminal without restarting login. Its ANSI palette has a minimum text contrast ratio of 4.5, and reduced motion disables cursor blinking.
- Phones retain side-by-side authentication choices, readable connection rows, a full-width primary Login action with a minimum 44px height, and a 44px terminal close target.

Account routing, provider authorization, terminal transport, and billing behavior are unchanged.
