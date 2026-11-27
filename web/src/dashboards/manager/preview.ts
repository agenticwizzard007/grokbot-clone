import type { StoredPreview } from '@shared/ui-config';
export function createdDashboard(preview: StoredPreview | null | undefined) {
  if (!preview) return undefined;
  const ids = new Set(Object.values(preview.idMap));
  return preview.result.dashboards.find(dashboard => ids.has(dashboard.id));
}
