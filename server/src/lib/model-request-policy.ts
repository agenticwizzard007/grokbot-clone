/** Shared policy for API Responses calls. CLI subscriptions keep their own limits. */
export interface OutputCapability { maxOutputTokens?: number; reasoning?: boolean }
const positive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

export function modelOutputLimit(model: string, info?: OutputCapability, requested?: number): number {
  const base = model.replace(/:nitro$/, '');
  let overrides: Record<string, unknown> = {};
  try { overrides = JSON.parse(process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS || '{}') ?? {}; } catch { /* use safe defaults */ }
  const configured = positive(overrides[base]) ?? positive(process.env.SWARM_MAX_OUTPUT_TOKENS);
  // Reasoning shares the output budget. Give reasoning models room without reserving 64k per turn.
  const defaultLimit = info?.reasoning || /(?:^|\/)(?:o[134](?:-|$)|gpt-5|claude-(?:sonnet|opus|3[.-]7)|.*reasoner)/i.test(base) ? 16384 : 8192;
  const legacyCap = /(?:^|\/)(?:gpt-3\.5-turbo|gpt-4-turbo|claude-3-(?:haiku|sonnet))(?:-|$)/.test(base) ? 4096 : Infinity;
  return Math.min(configured ?? defaultLimit, positive(info?.maxOutputTokens) ?? legacyCap, positive(requested) ?? Infinity);
}

export interface CreditDetails { provider: string; billingUrl?: string; details: string }
export function providerBilling(provider: string, baseURL: string): Omit<CreditDetails, 'details'> {
  let host = ''; try { host = new URL(baseURL).hostname; } catch { /* unknown compatible endpoint */ }
  if (provider === 'openrouter' || host === 'openrouter.ai') return { provider: 'OpenRouter', billingUrl: 'https://openrouter.ai/settings/credits' };
  const known: Record<string, [string, string]> = {
    'api.openai.com': ['OpenAI', 'https://platform.openai.com/settings/organization/billing/overview'],
    'api.anthropic.com': ['Anthropic', 'https://console.anthropic.com/settings/billing'],
    'api.x.ai': ['xAI', 'https://console.x.ai/team/default/billing'],
    'generativelanguage.googleapis.com': ['Google AI', 'https://aistudio.google.com/usage'],
    'api.deepseek.com': ['DeepSeek', 'https://platform.deepseek.com/top_up'],
    'api.groq.com': ['Groq', 'https://console.groq.com/settings/billing'],
    'api.mistral.ai': ['Mistral', 'https://console.mistral.ai/billing/'],
  };
  const entry = known[host];
  return entry ? { provider: entry[0], billingUrl: entry[1] } : { provider: 'Your API provider' };
}

export class ApiCreditsError extends Error {
  readonly credits: CreditDetails;
  constructor(error: unknown, provider: string, baseURL: string) {
    super('Out of API credits', { cause: error });
    this.name = 'ApiCreditsError';
    this.credits = { ...providerBilling(provider, baseURL), details: errorText(error) };
  }
}
const errorText = (error: any): string => String(error?.message ?? error?.error?.message ?? error);
export function isCreditError(error: any): boolean {
  return error instanceof ApiCreditsError || Number(error?.status ?? error?.code ?? error?.error?.code) === 402 ||
    /^(?:insufficient_quota|insufficient_credits|billing_hard_limit_reached)$/.test(String(error?.code ?? error?.error?.code)) ||
    /can only afford\s+[\d,]+|insufficient[_ ](?:quota|credits|balance)|(?:credit|balance).*?(?:too low|exhausted|insufficient)|(?:requires? more|out of|not enough|exceed[^.]*available) credits|billing[_ ]hard[_ ]limit/i.test(errorText(error));
}
export function affordableOutputLimit(error: unknown, current: number): number | undefined {
  const match = errorText(error).match(/can only afford\s+([\d,]+)/i);
  if (!match) return undefined;
  const affordable = positive(match[1].replaceAll(',', ''));
  if (!affordable) return undefined;
  const reduced = Math.min(Math.floor(affordable * 0.9), current - 1);
  return reduced >= 256 ? reduced : undefined;
}

/** Apply once at the API client boundary, covering every chat/tool/summary caller.
 * SDK retries are disabled here: credit recovery is exactly one attempt, with the
 * same AbortSignal reaching both HTTP requests. Never replay partial model output.
 */
export function boundedResponseCreate(
  create: (body: any, options?: any) => PromiseLike<any>,
  capability: (model: string, signal?: AbortSignal) => Promise<OutputCapability | undefined>,
  provider: string,
  baseURL: string,
) {
  // Image/MCP compatibility fallbacks reuse the body. Carry its credit retry and
  // reduced cap across those calls instead of opening another retry allowance.
  const recoveredLimits = new WeakMap<object, number>();
  return async (body: any, options: any = {}): Promise<any> => {
    const { creditRetryUsed = false, ...requestOptions } = options;
    const signal: AbortSignal | undefined = requestOptions.signal;
    signal?.throwIfAborted();
    const info = await capability(body.model, signal);
    signal?.throwIfAborted();
    let request = { ...body, max_output_tokens: Math.min(modelOutputLimit(body.model, info, body.max_output_tokens), recoveredLimits.get(body) ?? Infinity) };
    let retried = creditRetryUsed || recoveredLimits.has(body);
    const recover = (error: unknown) => {
      signal?.throwIfAborted();
      if (!isCreditError(error)) throw error;
      const limit = !retried ? affordableOutputLimit(error, request.max_output_tokens) : undefined;
      if (limit === undefined) throw new ApiCreditsError(error, provider, baseURL);
      retried = true;
      recoveredLimits.set(body, limit);
      request = { ...request, max_output_tokens: limit };
    };
    const start = async (): Promise<any> => {
      signal?.throwIfAborted();
      try { return await create(request, { ...requestOptions, signal, maxRetries: 0 }); }
      catch (error) { recover(error); }
      signal?.throwIfAborted();
      try { return await create(request, { ...requestOptions, signal, maxRetries: 0 }); }
      catch (error) {
        signal?.throwIfAborted();
        if (isCreditError(error)) throw new ApiCreditsError(error, provider, baseURL);
        throw error;
      }
    };
    let response = await start();
    if (!body.stream) {
      if (response?.error) {
        if (response.output?.length && isCreditError(response.error)) throw new ApiCreditsError(response.error, provider, baseURL);
        recover(response.error); response = await start();
      }
      if (response?.error) throw isCreditError(response.error) ? new ApiCreditsError(response.error, provider, baseURL) : new Error(errorText(response.error));
      return response;
    }
    // The SDK also forwards errors inside a successful HTTP SSE response.
    const controller = { abort: () => response.controller?.abort() };
    const events = (async function* () {
      let emittedOutput = false;
      for (;;) {
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          signal?.throwIfAborted();
          for await (const event of response) {
            signal?.throwIfAborted();
            if (event.type === 'response.failed' || event.type === 'error') {
              const detail = event.response?.error ?? event.error ?? event;
              throw Object.assign(new Error(errorText(detail)), { code: detail.code });
            }
            if (/^response\.(?:output_|content_part|function_call|reasoning|completed|incomplete)/.test(event.type)) emittedOutput = true;
            yield event;
          }
          return;
        } catch (error) {
          controller.abort();
          signal?.throwIfAborted();
          if (emittedOutput && isCreditError(error)) throw new ApiCreditsError(error, provider, baseURL);
          recover(error);
        } finally { signal?.removeEventListener('abort', abort); }
        response = await start();
      }
    })();
    return Object.assign(events, { controller });
  };
}
