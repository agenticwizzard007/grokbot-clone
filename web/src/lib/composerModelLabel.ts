/** Keep the Codex default and its billing route readable in the composer. */
export function composerModelLabel(label: string, provider: string | null, planMode: boolean): string {
  return planMode && provider === 'codex-cli' ? 'Codex · ChatGPT plan' : label;
}
