/** Catalog plans are subscription codes, not customer-facing names. */
export function planLabel(provider: string | null | undefined, plan?: string | null): string {
  if (provider !== 'claude-cli' && provider !== 'claude') return 'Codex plan';
  const tiers: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', ultra: 'Ultra', enterprise: 'Enterprise' };
  const code = plan?.trim().toLowerCase().replace(/^claude[ _]+/, '').replace(/[ _]+plan$/, '').replace(/^max[ _](?:5x|20x)$/, 'max') ?? '';
  const tier = Object.hasOwn(tiers, code) ? tiers[code] : null;
  return tier ? `Claude ${tier} plan` : 'Claude plan';
}
