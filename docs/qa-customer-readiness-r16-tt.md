# API maximum approval readiness

Scope: the API `every_action` path, based on `30a1da32398cd16bf7364d69e0c2ad9f0c52087e`. All account and provider exercises use isolated local fixtures. No live account sign-in, provider switch, user data access, or paid resource changes.

## Findings and changes

1. The turn loop appended the provider-search explanation for every non-resume trigger, including memory and task requests. Removed that insertion and its unused constant. Settings retains the explanation, the model retains its maximum-mode instructions, and provider search remains absent from offered tools.
2. Maximum mode skipped the wrapper resolution used by Standard, so a wrapped save asked for `tool_call` and then `save_file`. New wrappers now resolve before policy, store the actual action and schema hash for resumption, and show one card naming that action. Allow runs that action once; denial runs nothing. Always allow is stored under the actual action's `api_max:` key. Schema changes still invalidate pending wrapped actions. Already dispatched wrappers from an older server retain their original inner approval and dispatch identity. Allowing an old generic wrapper card asks for the named action instead of silently denying it or treating the wrapper as permission to run it.

`execute_code` still asks for the program and each permitted inner action. Recorded results replay without repeating completed actions or the program approval. Unsupported nested wrappers remain explicitly refused by the existing program allowlist.

The additional review found no approval bypass requiring a production change in voice, eligible group tools, scheduled or unattended turns, app discovery and execution, or model-driven learning review tools. These paths already reach the maximum policy or their separate voice/review approval gate. Existing group tool availability restrictions remain in force. Direct fixture execution checks cover both Allow and Don't allow, including durable memory, tasks, skill proposals, saved files and app effects. CLI plans continue ignoring the API preference; Standard retains its internal and external-action policy.

## Regression coverage

Added to `tests/api-approval-level.test.mts`:

- R16 wrapped saves and reads show one actual-action card and only dispatch after Allow
- R16 wrapped approvals retain schema checks and Always allow grants only the actual maximum action
- R16 in-flight wrappers from an older server retain their inner approval and dispatch identity
- R16 old generic wrapper cards never authorize the inner action on upgrade
- R16 memory, task, skill, file, app discovery, app read and app write wait and deny without effects
- R16 ordinary and search turns never append the provider-search Settings explanation to chat
- R16 scheduled and unattended actions keep visible cards and wait for allow or deny
- R16 program approvals resume successive actions once and denial leaves later saves undone
- R16 learning review memory and skill mutations wait for Allow and do nothing on denial

Updated the existing R11 wrapper expectations. The browser fixture checks both Settings locations and approval cards at 1280 and 390 pixels in light and dark, including a named wrapped-save card, denial, one-click execution after Allow, absence of chat search notices, Standard behavior, and disabled controls with either CLI plan selected. Screenshots are saved in `.context/api-approval-ui/`.

## Validation

The full baseline and candidate suites use `node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/*.test.mts tests/*.test.mjs` on this VM. Final results and deployment verification are recorded in the PR.

The customer live provider exercise still requires the test account's Model API key. The local API fixture uses the direct provider path and rejects external network calls.
