/** The CLI's execution alias is not a discovered model or plan entitlement. */
export function codexDefaultCatalog(auth: { installed?: boolean; authenticated?: boolean; subscription?: boolean; error?: string } | undefined) {
  if (!auth?.installed || !auth.authenticated || !auth.subscription || auth.error) throw new Error('Sign in to Codex with your ChatGPT plan, then refresh the connection.');
  return {
    models: [{ id: 'codex/default', name: 'Codex CLI default', efforts: [], defaultEffort: null, vision: true }],
    defaultModel: 'codex/default', plan: null,
    usage: { windows: [], available: false, checkedAt: Date.now() },
  };
}
