import type { FlowLaneId, FlowModel, FlowNode, LayoutPlan, FlowLayoutLane, FlowLayoutNode } from './model-types.js';
export const FLOW_LANES: readonly FlowLaneId[] = ['triggers', 'inputs', 'steps', 'outputs', 'handoffs'];
const labels = ['Triggers', 'Inputs', 'Steps', 'Outputs', 'Handoffs'];
const kinds: FlowNode['kind'][] = ['schedule', 'routine', 'event', 'message', 'inbound_handoff', 'app', 'mcp', 'knowledge', 'suggested_app', 'suggested_mcp', 'step', 'skill', 'report', 'files', 'message_out', 'task', 'handoff_to', 'handoff_from', 'loop'];
const compare = (a: FlowNode, b: FlowNode) => (a.order ?? kinds.indexOf(a.kind)) - (b.order ?? kinds.indexOf(b.kind)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Width is the available layout column, not the device viewport. */
export function layoutFlow(model: FlowModel, width: number): LayoutPlan {
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 390;
  const columnWidth = Math.min(1120, safeWidth), left = (safeWidth - columnWidth) / 2;
  const stacked = columnWidth < 1000, gap = 32, header = 32, nodeGap = 12, nodeHeight = 64;
  const laneWidth = stacked ? columnWidth : (columnWidth - gap * 4) / 5;
  const lanes: FlowLayoutLane[] = [], nodes: FlowLayoutNode[] = [];
  let cursor = 0, tallest = 0;
  FLOW_LANES.forEach((id, i) => {
    const lane = model.lanes.find(lane => lane.id === id);
    const sorted = [...(lane?.nodes ?? [])].sort(compare);
    const shown = sorted.slice(0, 5), more = Math.max(0, lane?.more ?? 0) + Math.max(0, sorted.length - 5);
    const count = Math.max(1, shown.length) + (more > 0 ? 1 : 0);
    const x = stacked ? left : left + i * (laneWidth + gap), y = stacked ? cursor : 0;
    const h = header + count * nodeHeight + (count - 1) * nodeGap;
    const boxes: FlowLayoutNode[] = shown.map((node, j) => ({ id: node.id, laneId: id, kind: 'node', node, label: node.label, x, y: y + header + j * (nodeHeight + nodeGap), w: Math.min(stacked ? laneWidth : 200, laneWidth), h: nodeHeight }));
    if (!shown.length) boxes.push({ id: `${id}:empty`, laneId: id, kind: 'empty', label: 'None yet', x, y: y + header, w: laneWidth, h: nodeHeight });
    if (more) boxes.push({ id: `${id}:more`, laneId: id, kind: 'more', label: `+${more} more`, x, y: y + header + Math.max(1, shown.length) * (nodeHeight + nodeGap), w: laneWidth, h: nodeHeight });
    lanes.push({ id, label: lane?.label ?? labels[i], x, y, w: laneWidth, h, nodes: boxes }); nodes.push(...boxes);
    cursor += h + gap; tallest = Math.max(tallest, h);
  });
  const returnY = stacked ? cursor : tallest + gap;
  return { width: safeWidth, height: returnY + 44, mode: stacked ? 'stacked' : 'columns', column: { x: left, width: columnWidth }, lanes, nodes,
    loopBack: { id: 'loop-back', x: left, y: returnY, w: columnWidth, h: 44,
      label: stacked ? `${model.loopBack.label}: back to Triggers` : model.loopBack.label,
      path: stacked ? '' : `M ${left + columnWidth - 16} ${returnY + 8} V ${returnY + 32} H ${left + 16} V ${returnY + 8}` } };
}
export type { LayoutPlan } from './model-types.js';
