/** Pinned artwork from the Connect Apps reference, shared by every app surface. */
const BUNDLED: Readonly<Record<string, string>> = {
  gmail: 'gmail',
  composio: 'composio',
  github: 'github',
  googlecalendar: 'googlecalendar',
  notion: 'notion',
  googlesheets: 'googlesheets',
  slack: 'slack',
  supabase: 'supabase',
  outlook: 'outlook',
  microsoftoutlook: 'outlook',
  perplexity: 'perplexityai',
  perplexityai: 'perplexityai',
  twitter: 'twitter',
  googledrive: 'googledrive',
  googledocs: 'googledocs',
  hubspot: 'hubspot',
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function toolkitLogo({ slug, name, logo }: { slug?: string; name: string; logo?: string }): string | undefined {
  // Metadata wins, but the browser only loads same-origin catalog-validated artwork.
  if (slug && logo) return `/api/toolkits/icon/${encodeURIComponent(slug)}`;
  const bundled = BUNDLED[normalize(slug || name)];
  if (bundled) return `/assets/toolkits/${bundled}.svg`;
  return slug ? `/api/toolkits/icon/${encodeURIComponent(slug)}` : undefined;
}
