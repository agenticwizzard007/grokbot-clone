/** JSON count/histogram observations work in standalone and tenant processes.
 * No user ids, document content, bot names or unbounded labels are recorded.
 */
export type UiMetric = 'ui_preview_created' | 'ui_preview_applied' | 'ui_preview_discarded'
  | 'ui_patch_rejected' | 'ui_undo' | 'ui_reset' | 'ui_safe_mode_entered'
  | 'ui_dashboard_count' | 'ui_config_bytes' | 'ui_data_request_ms' | 'ui_agent_apply_mode';
export type UiMetricSink = (event: { metric: UiMetric; value: number; label?: string }) => void;
const labels = new Set(['all', 'appearance', 'theme', 'layout', 'components', 'dashboards', 'dashboard',
  'ask', 'auto', 'invalid_patch', 'invalid_value', 'unknown_path', 'limit_exceeded', 'accessibility',
  'required_item', 'stale_revision', 'stale_preview', 'preview_expired', 'not_found', 'disabled', 'rate_limited']);

export function createUiMetrics(sink: UiMetricSink = event => console.info(JSON.stringify(event))) {
  return (metric: UiMetric, value = 1, label?: string): void => {
    if (!Number.isFinite(value) || value < 0) return;
    try { sink({ metric, value, ...(label && labels.has(label) ? { label } : {}) }); } catch { /* Telemetry cannot break a committed change. */ }
  };
}
export const uiMetric = createUiMetrics();
