# Model and Composio Integration

Swarm supports two model paths:

- **OpenRouter**, the recommended default for broad model coverage through one key.
- **Custom direct provider**, for OpenAI-compatible Responses API deployments configured with `DIRECT_API_KEY`, `DIRECT_MODEL`, and `DIRECT_BASE_URL`.

Composio powers connected apps. The server stores a Composio project key, each Swarm user connects their own app accounts, and the agent loop receives user-scoped tool definitions when it needs to work inside those apps.

## Environment

```bash
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4.1

DIRECT_API_KEY=
DIRECT_MODEL=openai/gpt-4.1
DIRECT_BASE_URL=https://api.openai.com/v1

COMPOSIO_API_KEY=
```

Use `DIRECT_BASE_URL=http://localhost:8790/v1` with `tests/mock-provider.mjs` for local provider tests.

## Notes

- Keep OpenRouter as the first setup path in the UI because it gives Swarm the broadest model catalog with minimal configuration.
- Keep the direct provider path generic. It should work with compatible providers and local mocks without naming a vendor in product copy.
- Use Composio only for external app actions. Model requests stay in `server/src/lib/llm.ts`; app tool discovery and execution stay in `server/src/composio.ts`.
