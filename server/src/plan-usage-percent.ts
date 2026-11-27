/** Raw percentages stay available for warnings; bars and labels use this bounded value. */
export function displayUsagePercent(percent: number | null | undefined): number | null {
  return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}
