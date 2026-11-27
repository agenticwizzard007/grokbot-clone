export interface RunGraphEvent {
  seq: number; type: string; createdAt: number;
  data: Record<string, unknown>;
}
export interface RunGraphNode { id: string; botId: string; iteration: number; stepId: string; outputId?: string; label: string; x: number; y: number; w: number; h: number }
export interface RunGraphPlan {
  width: number; height: number; mode: 'columns' | 'stacked'; column: { x: number; width: number };
  nodes: RunGraphNode[]; edges: { from: string; to: string; path: string; label: string; loopBack: boolean }[];
}
/** Events are normalized from the append-only log; seq orders ties, never input array order. */
export function layoutRunGraph(events: readonly RunGraphEvent[], width = 1280): RunGraphPlan {
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const rows = new Map<string, { id: string; botId: string; stepId: string; iteration: number; label: string; outputId?: string; role: string }>();
  for (const event of sorted) {
    const d = event.data;
    if (!['loop.step_dispatched', 'loop.step_completed', 'loop.step_failed'].includes(event.type) || typeof d.stepId !== 'string' || typeof d.iteration !== 'number') continue;
    const id = `${d.iteration}:${d.stepId}`, existing = rows.get(id);
    if (!existing && typeof d.botId !== 'string') continue;
    const row = existing ?? { id, botId: String(d.botId), stepId: d.stepId, iteration: d.iteration, label: String(d.botName ?? d.botId), role: String(d.role ?? 'step') };
    if (typeof d.outputId === 'string') row.outputId = d.outputId;
    if (typeof d.title === 'string') row.label = d.title;
    rows.set(id, row);
  }
  const bots = [...new Set([...rows.values()].map(row => row.botId))];
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 390, columnWidth = Math.min(1120, safeWidth), left = (safeWidth - columnWidth) / 2;
  const stacked = columnWidth < 600 || bots.length * 168 + Math.max(0, bots.length - 1) * 48 > columnWidth;
  const nodes = [...rows.values()].map((row, i): RunGraphNode => ({ id: row.id, botId: row.botId, iteration: row.iteration, stepId: row.stepId, ...(row.outputId ? { outputId: row.outputId } : {}), label: row.label,
    x: stacked ? left : left + bots.indexOf(row.botId) * 216, y: i * 88, w: stacked ? columnWidth : 168, h: 56 }));
  const edges = nodes.slice(1).map((to, i) => {
    const from = nodes[i], x1 = from.x + from.w / 2, x2 = to.x + to.w / 2, y1 = from.y + from.h, y2 = to.y;
    const loopBack = from.iteration !== to.iteration;
    return { from: from.id, to: to.id, label: rows.get(from.id)?.role === 'checker' ? 'feedback' : from.label, loopBack,
      path: stacked || x1 === x2 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} C ${x1} ${y1 + 16}, ${x2} ${y2 - 16}, ${x2} ${y2}` };
  });
  return { width: safeWidth, height: nodes.length ? nodes.at(-1)!.y + 56 : 0, mode: stacked ? 'stacked' : 'columns', column: { x: left, width: columnWidth }, nodes, edges };
}
