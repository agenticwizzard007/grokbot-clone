/** Keep KPI groups together and finish partial rows before the next widget wraps. */
export function statRowSpans(widgets: { type: string }[], spans: number[], columns: number): number[] {
  let occupied = 0;
  return spans.map((span, index) => {
    if (occupied + span > columns) occupied = 0;
    const next = spans[index + 1];
    const endsStats = widgets[index].type === 'stat' && widgets[index + 1]?.type !== 'stat';
    if (occupied + span < columns && (endsStats || next === undefined || occupied + span + next > columns)) span = columns - occupied;
    occupied = (occupied + span) % columns;
    return span;
  });
}
