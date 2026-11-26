const aliases: Record<string, string> = {
  anthropic: 'claude', claude: 'claude', 'claude-cli': 'claude',
  openai: 'openai', chatgpt: 'openai', codex: 'openai', 'codex-cli': 'openai',
  openrouter: 'openrouter', xai: 'xai', 'x-ai': 'xai',
  google: 'gemini', gemini: 'gemini', meta: 'meta', 'meta-llama': 'meta',
  mistralai: 'mistral', mistral: 'mistral', deepseek: 'deepseek', qwen: 'qwen',
  moonshotai: 'moonshot', moonshot: 'moonshot', cohere: 'cohere',
};

/** Use an explicit author/provider or a recognizable model ID, never guess a direct API's owner. */
export function providerBrand(value?: string | null): string | null {
  const name = value?.trim().toLowerCase();
  if (!name) return null;
  const author = name.split('/')[0];
  if (aliases[author]) return aliases[author];
  if (/^(claude|opus|sonnet|haiku)(?:[\s.-]|$)/.test(name)) return 'claude';
  if (/^(chatgpt|codex|gpt|o[134])(?:[\s.-]|$)/.test(name)) return 'openai';
  if (/^(grok|xai|x-ai)(?:[\s.-]|$)/.test(name)) return 'xai';
  if (/^gemini(?:[\s.-]|$)/.test(name)) return 'gemini';
  return null;
}
