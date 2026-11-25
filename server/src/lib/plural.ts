/** English count labels shared by server-produced copy and the web UI. */
export function plural(count: number, singular: string, multiple = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : multiple}`;
}
