// Local-day shape: empty dates, fractional UTC computer allocations, and real mixed spend.
export const zeroDayUsage = {
  timezone: 'Asia/Dubai', range: { key: '7d', from: Date.parse('2026-11-19T00:00:00Z'), to: Date.parse('2026-11-26T00:00:00Z') },
  scope: 'me', canSeeAll: false, canSeeProvider: false, provider: 'direct',
  totals: { requests: 8, inputTokens: 500, outputTokens: 100, cachedTokens: 0, reasoningTokens: 0, toolCalls: 0, voiceMinutes: 0, costUsd: 3.304, estimatedUsd: 0, unpricedRequests: 0, unpricedVoice: 0 },
  billing: { sources: [], note: 'Recorded usage for this account.' },
  days: [
    { day: '2026-11-19', costUsd: 2, computerUsd: 0.5, tokens: 300, requests: 3 },
    { day: '2026-11-20', costUsd: 0, computerUsd: 0.001, tokens: 0, requests: 0 },
    { day: '2026-11-21', costUsd: 0, computerUsd: 0, tokens: 0, requests: 0 },
    { day: '2026-11-22', costUsd: 1.3, computerUsd: 0.0049, tokens: 200, requests: 2 },
    { day: '2026-11-23', costUsd: 0.004, computerUsd: 0.004, tokens: 1, requests: 1 },
    { day: '2026-11-24', costUsd: 0, computerUsd: 0.1, tokens: 0, requests: 0 },
    { day: '2026-11-25', costUsd: 0, computerUsd: 0.00001, tokens: 0, requests: 0 },
  ],
  computer: { costUsd: 0.60991, runningHours: 5, asleepHours: 100, archivedHours: 0, now: null },
  computerProvider: 'cloudvm', byBot: [], byModel: [], byKind: [], limits: { dailyMessages: null },
};
