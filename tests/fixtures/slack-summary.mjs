export const slackSummary = {
  description: "When asked, read the user's latest Slack messages and return a concise summary in this chat",
  instructions: 'Return concise summaries of messages in this chat. Do not send email.',
  purpose: 'Email summaries',
};
const app = (slug, name, description, categories = ['Communication']) => ({ slug, name, description, categories, managedAuth: true, noAuth: false });
export const relevanceCatalog = [
  app('slack', 'Slack', 'Team messages and channel conversations'),
  app('bluefox_email', 'BlueFox Email', 'Send email and concise summaries'),
  app('googlechat', 'Google Chat', 'Send messages in chat'),
  app('benchmark_email', 'Benchmark Email', 'Email marketing and messages'),
  app('generic_summary', 'Summary helper', 'Return concise summaries of the latest messages in chat'),
  app('gmail', 'Gmail', 'Read email and organize your inbox'),
  app('hubspot', 'HubSpot', 'CRM and sales pipeline management', ['CRM']),
  app('salesforce', 'Salesforce', 'Customer relationship management and sales pipeline', ['CRM']),
  app('category_only', 'Unrelated product', 'Edit photos', ['CRM', 'Communication']),
];
export const noisyChoices = { suggestions: relevanceCatalog.map(({ slug }) => ({ slug, reason: 'Could help with summaries and messages.' })) };
