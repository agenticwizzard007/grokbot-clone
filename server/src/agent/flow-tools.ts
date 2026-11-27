import { z } from 'zod';
import type { FlowStore } from '../handoffs/contracts.js';
import type { ToolDef } from './tools.js';
import { defineHandoffTool, type HandoffToolPolicy } from './handoff-tools.js';

const copy = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u2013\u2014\u0000-\u001f<>]*$/);
export const FLOW_SUMMARY_SCHEMA = z.object({
  steps: z.array(z.object({ label: copy(40), detail: copy(60).optional() }).strict()).min(1).max(6),
  loopNote: copy(200).optional(),
}).strict();

function buildFlowTools(store: () => FlowStore | undefined, policy: () => HandoffToolPolicy | undefined): ToolDef[] {
  return [defineHandoffTool('write_flow_summary',
    'After setup or when instructions change, describe your process once in up to six short steps. This updates your own flow summary; the server binds it to the current instructions and skills.',
    'Updating agent flow', FLOW_SUMMARY_SCHEMA, policy,
    async (input, context) => {
      const current = store();
      if (!current) return { output: 'The flow summary store is not available yet. Continue with the current task.', isError: true };
      const result = await current.writeFlowSummary(context, input);
      return { output: JSON.stringify({ saved: true, inputsHash: result.inputsHash }) };
    })];
}

export function createFlowTools(store: FlowStore, policy: HandoffToolPolicy): ToolDef[] {
  return buildFlowTools(() => store, () => policy);
}

let configuredStore: FlowStore | undefined;
let configuredPolicy: HandoffToolPolicy | undefined;
/** HO-I binds HO-G's store and HO-B's enabled policy before registration. */
export function configureFlowTools(store: FlowStore, policy: HandoffToolPolicy): void {
  configuredStore = store;
  configuredPolicy = policy;
}
export const FLOW_TOOLS = buildFlowTools(() => configuredStore, () => configuredPolicy);
