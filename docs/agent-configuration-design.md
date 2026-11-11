# Agent configuration

Configuration follows the live [Paper brand guidelines](https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-H-0) and [Settings components](https://app.paper.design/file/01M73GPA3GPRHEBRRXNDC09HDV/p-A-0). The typography, row and control definitions were read through Paper MCP; the implementation uses the existing app tokens and icon library.

- Instrument Sans variable at weight 550 for interface text, following the final brand type rules. Code retains a readable monospace font at 400. The component imports its own font so it does not depend on visiting another screen first.
- 15/20px section headings, 14/22px desktop body and 15/24px phone body. Secondary explanations are 13/20px. The editor uses 16px text on phones to avoid focus zoom.
- 16px panel/card insets, 12px grouped gaps, 24px section gaps, neutral pill tabs and 12–16px surface corners. File and settings rows use fixed 28px icon and 16px trailing lanes.
- Minimum 44px touch actions, visible keyboard focus and a viewport-bounded prompt reader. Selecting a file brings its reader into view; Back to files returns focus to the selected row.

The compact identity header applies only to an agent's Configuration view. Rooms and other detail tabs retain their existing layout. All colors use light/dark semantic tokens; status also has a text label. Styling does not change activation, authorization or instruction-save behavior.

Validation: web typecheck/build and the existing isolated creation browser workflow, including 320/375/390/430/768/1024px viewports, touch-target sizes, no horizontal overflow, file-reader focus/return, keyboard navigation, instruction save conflicts, preview refresh and room navigation. Screenshots are retained in `.context/shots/` in the implementation worktree.
