export interface FlowModel {
  v: 1; botId: string; version: number;             // version = monotonic per bot
  inputsHash: string;                               // see 16.3
  generatedAt: number; source: 'auto' | 'agent+auto';
  lanes: { id: 'triggers'|'inputs'|'steps'|'outputs'|'handoffs'; label: string; nodes: FlowNode[]; more: number }[];  // <= 5 nodes shown per lane, `more` = hidden count
  loopBack: { kind: 'repeats' | 'waits'; label: string };
  warnings: string[];                                // e.g. 'No instructions yet'
}
export interface FlowNode {
  id: string;                                        // stable: lane + kind + source id, never random
  kind: 'schedule'|'routine'|'event'|'message'|'inbound_handoff'|'app'|'mcp'|'knowledge'|'suggested_app'|'suggested_mcp'
      |'step'|'skill'|'report'|'files'|'message_out'|'task'|'handoff_to'|'handoff_from'|'loop';
  label: string;                                     // <= 40 chars, cut at a word, no ellipsis char tricks
  detail?: string;                                   // <= 60 chars
  badge?: string;                                    // e.g. 'Suggested', 'Auto', 'Paused'
  logo?: { kind: 'toolkit'|'bot'|'icon'; id: string };
  target: { hash: string; focus?: string };          // deep link, 16.5
  state: 'ok' | 'suggested' | 'disabled' | 'attention';   // attention = needs reconnect
}

export type FlowLaneId = FlowModel["lanes"][number]["id"];
export type { FlowStore, FlowSummaryInput } from "../handoffs/contracts.js";
