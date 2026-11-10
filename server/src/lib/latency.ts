/** Opt-in durations only: never log prompts, tool arguments, responses, or credentials. */
export function latency(stage: string, start: number, fields: { botId?: string; tool?: string; model?: string } = {}) {
  if (process.env.SWARM_LOG_LATENCY !== '1') return;
  console.log('[latency]', JSON.stringify({ stage, ms: Math.round(performance.now() - start), ...fields }));
}
