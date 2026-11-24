# API output budgets and credit recovery

Chat previously omitted `max_output_tokens` for normal turns. OpenRouter could reserve the model's entire 65,536-token default and reject a small chat with HTTP 402. A workflow's remaining token budget could also become an oversized single-response limit.

All API Responses clients now apply a common output policy before the SDK sends HTTP:

- Default to 8,192 output tokens, or 16,384 for reasoning models. Known older models use their smaller limit. OpenRouter's `top_provider.max_completion_tokens` caps the request when available, including `:nitro` variants.
- Configure a server default with `SWARM_MAX_OUTPUT_TOKENS`, or model overrides with `SWARM_MODEL_MAX_OUTPUT_TOKENS` (a JSON object keyed by model ID). Provider capability limits and smaller explicit caller/workflow budgets still win. Invalid settings fall back to defaults.
- On a credit error containing `can only afford N`, make at most one retry at `min(floor(N * 0.9), previous_limit - 1)`. Do not retry below 256 tokens. Both requests use the same run AbortSignal. SDK automatic retries are disabled so quota errors cannot silently multiply attempts.
- HTTP errors and Responses SSE error events use the same policy. Once model output has started, do not replay the request. Exhaustion becomes a durable `Out of API credits` chat notice with the paying provider's billing page and collapsed raw error details. An in-flight reservation failure advises waiting for other requests to finish. It is not treated as a user Stop.

## Provider and caller audit

The app has two HTTP model paths: OpenRouter and an OpenAI-compatible direct API. Both use the OpenAI SDK's Responses interface. Anthropic, Google, xAI and other model makers route through OpenRouter; there are no separate Anthropic Messages or OpenAI Chat Completions calls in the app, nor any app request assignments to `max_tokens` or `max_completion_tokens`. The wire field is `max_output_tokens`.

The client policy covers foreground chat, each tool-loop turn, image/MCP schema retries, memory summary fallback, memory consolidation (existing 2,048-token ceiling), learning reviews (2,048), app suggestions (1,200), and voice text fallback. Subscription CLI adapters retain their own limits and existing cancellation. No voice route, event heartbeat, CLI status, touch actions or Fly configuration changed. The standalone Quinn qualification script already supplies its explicit qualification budget.

`/responses/compact` does not accept an output cap. It retains its existing admission checks and run signal. If it returns an affordable credit error, its single retry uses the summary endpoint with the reduced cap and further credit retries disabled. Exhausted compaction propagates to the chat notice instead of issuing another foreground request. Cancelled compaction cannot replace history.

## Local validation

`tests/model-request-policy.test.mts` exercises the policy through SDK HTTP mocks: model/capability/configuration limits, one affordable retry, exhausted 400/402/429 responses, no third request, Stop during the first request and retry, SSE errors before/after output, and billing-page mapping.

`tests/api-credits.test.mts` exercises the real agent with a local HTTP provider: normal recovery, persisted exhausted notices, tool-loop caps, actual connection closure on Stop, summary compaction recovery/cancellation, and direct compaction's single capped fallback/cancellation.

`node tests/api-credits-ui.mjs` uses temporary SQLite, DEV_LOGIN, a local HTTP provider and blocked external browser/backend traffic. At 390 and 1280 pixels it sends a request that fails with 402 then succeeds, sends an exhausted request, verifies the billing URL and expandable details, and reloads the persisted state. Screenshots are under `.context/api-credits/`.

No real OpenRouter request was made. No OpenRouter key is configured in the workspace environment or a local .env file, so no clearly authorized dev/test key was available. No live account, production data or paid resources were accessed.
