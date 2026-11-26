const aliases: Record<string, string> = {
  anthropic: 'claude', claude: 'claude', 'claude-cli': 'claude',
  openai: 'openai', chatgpt: 'openai', codex: 'openai', 'codex-cli': 'openai',
  openrouter: 'openrouter', xai: 'xai', 'x-ai': 'xai',
  google: 'gemini', gemini: 'gemini', meta: 'meta', 'meta-llama': 'meta',
  mistralai: 'mistral', mistral: 'mistral', deepseek: 'deepseek', qwen: 'qwen',
  moonshotai: 'moonshot', moonshot: 'moonshot', cohere: 'cohere',
  'aion-labs': 'aionlabs', amazon: 'nova', baidu: 'baidu', bytedance: 'bytedance', 'bytedance-seed': 'bytedance',
  fireworks: 'fireworks', 'ibm-granite': 'ibm', liquid: 'liquid', minimax: 'minimax', microsoft: 'microsoft',
  nousresearch: 'nousresearch', nvidia: 'nvidia', perplexity: 'perplexity', rekaai: 'reka', relace: 'relace',
  sakana: 'sakana', stepfun: 'stepfun', tencent: 'tencent', upstage: 'upstage', xiaomi: 'xiaomimimo', 'z-ai': 'zai',
};

const marks = new Set(Object.values(aliases));

/** Use an explicit author/provider or a recognizable model ID, never guess a direct API's owner. */
export function providerBrand(value?: string | null): string | null {
  const name = value?.trim().toLowerCase();
  if (!name) return null;
  const author = name.split('/')[0].replace(/^~/, '');
  if (marks.has(author)) return author;
  if (Object.hasOwn(aliases, author)) return aliases[author];
  for (const alias of Object.keys(aliases)) if (name.startsWith(`${alias} `)) return aliases[alias];
  for (const mark of marks) if (name.startsWith(`${mark} `)) return mark;
  if (/^(glm)(?:[\s.-]|$)/.test(name)) return 'zai';
  if (/^nemotron(?:[\s.-]|$)/.test(name)) return 'nvidia';
  if (/^mimo(?:[\s.-]|$)/.test(name)) return 'xiaomimimo';
  if (/^(claude|opus|sonnet|haiku)(?:[\s.-]|$)/.test(name)) return 'claude';
  if (/^(chatgpt|codex|gpt|o[134])(?:[\s.-]|$)/.test(name)) return 'openai';
  if (/^(grok|xai|x-ai)(?:[\s.-]|$)/.test(name)) return 'xai';
  if (/^gemini(?:[\s.-]|$)/.test(name)) return 'gemini';
  if (/^(llama|meta)(?:[\s.-]|$)/.test(name)) return 'meta';
  if (/^(mistral|mixtral|codestral|magistral)(?:[\s.-]|$)/.test(name)) return 'mistral';
  if (/^deepseek(?:[\s.-]|$)/.test(name)) return 'deepseek';
  if (/^qwen(?:[\s.-]|\d|$)/.test(name)) return 'qwen';
  if (/^(kimi|moonshot)(?:[\s.-]|$)/.test(name)) return 'moonshot';
  if (/^(cohere|command)(?:[\s.-]|$)/.test(name)) return 'cohere';
  return null;
}
