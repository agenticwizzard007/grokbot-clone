/** Curated everyday connections, shared by catalog ordering and the app picker.
 * This is an editorial selection, not a live usage ranking. Keep it to 40 apps.
 */
export const APP_CATEGORIES = [
  {
    id: 'communication', label: 'Email & communication', shortLabel: 'Communication',
    categories: ['email', 'communication', 'team chat', 'video conferencing', 'phone & sms'],
    slugs: ['gmail', 'outlook', 'slack', 'microsoft_teams', 'zoom', 'discord', 'whatsapp', 'telegram'],
  },
  {
    id: 'productivity', label: 'Productivity & scheduling', shortLabel: 'Productivity',
    categories: ['productivity', 'calendar', 'scheduling & booking', 'documents', 'spreadsheets', 'notes', 'file management & storage'],
    slugs: ['googlecalendar', 'googledrive', 'googledocs', 'googlesheets', 'notion', 'airtable', 'dropbox', 'calendly'],
  },
  {
    id: 'project management', label: 'Project management', shortLabel: 'Projects',
    categories: ['project management', 'task management'],
    slugs: ['trello', 'asana', 'clickup', 'monday', 'jira', 'linear'],
  },
  {
    id: 'developer tools', label: 'Code & development', shortLabel: 'Code',
    categories: ['developer tools', 'databases', 'server monitoring'],
    slugs: ['github', 'gitlab', 'vercel', 'supabase', 'sentry'],
  },
  {
    id: 'crm', label: 'Sales & support', shortLabel: 'Sales & support',
    categories: ['crm', 'customer support', 'contact management'],
    slugs: ['hubspot', 'salesforce', 'zendesk', 'intercom'],
  },
  {
    id: 'marketing', label: 'Marketing & social', shortLabel: 'Marketing',
    categories: ['marketing', 'social media accounts', 'social media marketing', 'marketing automation', 'email newsletters'],
    slugs: ['linkedin', 'twitter', 'instagram', 'youtube', 'mailchimp'],
  },
  {
    id: 'images & design', label: 'Design', shortLabel: 'Design',
    categories: ['images & design'],
    slugs: ['figma', 'canva'],
  },
  {
    id: 'ecommerce', label: 'Commerce & payments', shortLabel: 'Commerce',
    categories: ['ecommerce', 'payment processing'],
    slugs: ['shopify', 'stripe'],
  },
];

const popularRanks = new Map(APP_CATEGORIES.flatMap((group) => group.slugs).map((slug, index) => [slug, index]));
export const isPopularApp = (slug: string) => popularRanks.has(slug);

/** Sort before pagination so all 40 curated apps are on the default first page.
 * Stable ties preserve the provider's usage order for the rest of the catalog.
 */
export function compareAppPriority(a: { slug: string }, b: { slug: string }): number {
  return (popularRanks.get(a.slug) ?? Infinity) - (popularRanks.get(b.slug) ?? Infinity) || 0;
}

export function matchesAppCategory(app: { slug: string; categories: string[] }, category: string): boolean {
  const key = category.toLowerCase();
  const group = APP_CATEGORIES.find((candidate) => candidate.id === key);
  return !!group?.slugs.includes(app.slug) || app.categories.some((value) =>
    group ? group.categories.includes(value.toLowerCase()) : value.toLowerCase() === key);
}
