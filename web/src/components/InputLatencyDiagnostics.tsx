import { useState } from 'react';
import { inputLatency } from '../lib/inputLatency';

/** Read on demand. Opening Settings never starts a polling timer. */
export function InputLatencyDiagnostics() {
  const [stats, setStats] = useState(inputLatency);
  return <details className="cfg-section" onToggle={event => { if (event.currentTarget.open) setStats(inputLatency()); }}>
    <summary>Typing diagnostics</summary>
    <p>Typing responsiveness: {stats.count ? `p95 ${Math.round(stats.p95Ms!)} ms over ${stats.count} ${stats.count === 1 ? 'input' : 'inputs'}` : 'Type in a chat to collect a sample.'}</p>
    {stats.count > 0 && <p>Median {Math.round(stats.p50Ms!)} ms. Session maximum {Math.round(stats.maxMs!)} ms. Percentiles use the last {stats.sampleCount} {stats.sampleCount === 1 ? 'input' : 'inputs'}.</p>}
    {stats.resolutionFloorMs && <p>Browser paint timings use a 16 ms minimum. Inputs without a keyboard event use a frame estimate.</p>}
    <p>Approximate time from keyboard input to the next paint in this tab. Only timings are kept in memory. No keys or message text are recorded or sent.</p>
    <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setStats(inputLatency())}>Refresh measurement</button>
  </details>;
}
