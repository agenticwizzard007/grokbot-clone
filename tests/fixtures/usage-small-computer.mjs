import { zeroDayUsage } from './usage-zero-days.mjs';

// A large AI day makes 1 to 5 cents less than one pixel on the cost axis.
export const smallComputerUsage = {
  ...zeroDayUsage,
  totals: { ...zeroDayUsage.totals, costUsd: 80.014, requests: 4, inputTokens: 300, outputTokens: 1 },
  days: [
    { day: '2026-11-19', costUsd: 80, computerUsd: 2, tokens: 300, requests: 3 },
    ...[0.01, 0.02, 0.03, 0.04, 0.05].map((computerUsd, i) => ({
      day: `2026-11-${20 + i}`, costUsd: 0, computerUsd, tokens: 0, requests: 0,
    })),
    { day: '2026-11-25', costUsd: 0, computerUsd: 0, tokens: 0, requests: 0 },
    { day: '2026-11-26', costUsd: 0.004, computerUsd: 0.004, tokens: 0, requests: 0 },
    { day: '2026-11-27', costUsd: 0.01, computerUsd: 0.01, tokens: 1, requests: 1 },
  ],
  computer: { ...zeroDayUsage.computer, costUsd: 2.164 },
};
