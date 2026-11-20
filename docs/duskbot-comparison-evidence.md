# Evidence and commit manifest

Remote pins confirmed November 19, 2026 UTC, and rechecked at approximately 18:42 UTC. The snapshot paths below refer to workspace-only research copies under `.context/duskbot-comparison/`; those repository copies are not distributed with this report. Commit-pinned GitHub links identify the reviewed source.

| Repository and ref | Commit | Tree | Source snapshot |
|---|---|---|---|
| [Swarms: `agenticwizzard007/grokbot-clone`, live `refs/heads/main`](https://github.com/agenticwizzard007/grokbot-clone/commit/46ffb7cc090ea70e179c9f6511a7e57f9f187311) | `46ffb7cc090ea70e179c9f6511a7e57f9f187311` | `bf377ca367b071d8c75d47dcaa4c3cb0686d03a6` | `swarms/` (`git archive` read snapshot) |
| [Duskbot: `agenticwizzard007/duskbot`, default `main`](https://github.com/agenticwizzard007/duskbot/commit/a325fb5b66516f153dfa679fe50802d7f95bade7) | `a325fb5b66516f153dfa679fe50802d7f95bade7` | `793faedc96efaeec358dd576554c7c4754553a96` | `duskbot/` (detached, read-only use) |

GitHub `gh repo view` identifies public forks with parents `nickvasilescu/orgo-teammates` and `DuskBotAI/duskbot`, respectively. DuskBotAI upstream `refs/heads/main` matched the pinned fork. Exact `git rev-list` SHA intersection: **0** (Swarms 258 reachable commits, Duskbot 3,729, both non-shallow). No claim about non-Git code ancestry is made. Duskbot's `LICENSE` and `docs/LICENSING.md` are authoritative for this review; GitHub's “Other” label is not. Its `third_party/openmausbot/NOTICE` separates upstream attribution, including the specific provenance of the Grok import adaptation. Swarms has its own MIT license and third-party notices.

## Evidence map

| Claim | Duskbot evidence | Swarms evidence |
|---|---|---|
| Runtime, lineage, goal semantics | `server/coordinator.ts:226`, `server/runtime/store.ts:196`, `server/group-goal-run.ts:214` | `server/src/coordination/requests.ts:95`, `server/src/agent/goals.ts:124`, `server/src/agent/workflows.ts:250` |
| Owner attention, routine recovery, immutable outputs | `server/today.ts:241`, `server/automation-reports.ts:153`, `server/routine-recovery.ts:80`, `src/components/HtmlFilePreview.tsx:10` | `server/src/coordination/state.ts:22`, `server/src/proactive.ts:90`, `server/src/deliverables/runs.ts:137`, `server/src/deliverables/artifacts.ts:50` |
| Provider rules, memory, trust and qualification | `shared/approval-mode.ts:18`, `server/memory-recall.ts:122`, `server/bot-visibility.ts:97`, `server/cloud-team-private.e2e.test.ts:146`, `docs/mobile-readiness.md:63` | `server/src/cli/routes.ts:139`, `server/src/agent/loop.ts:572`, `docs/agent-evolution-history.md:5`, `docs/tenant-isolation.md:7` |
| First PR: Support Snapshot | `src/components/DiagnosticsRow.tsx:8`, `electron/diagnostics.mjs:266` | `server/src/tenant-app.ts:75`, `server/src/cli/bridge.ts:23`, `server/src/coordination/state.ts:43` |

[Report](duskbot-comparison.md) contains commit-pinned path/line links, test references, risk-ranked opportunities and acceptance criteria. The coordinator independently cross-checked the findings against the pinned source and verified all 84 file/line citations. Local review receipts remain in the workspace coordination archive. Research used Git/authorized GitHub metadata and static reads only; no repository scripts, product tests, model/provider calls, deployments or production-source edits. The dirty workspace root and the coordinator's integration snapshot were not used as shipped source or modified by this research.
