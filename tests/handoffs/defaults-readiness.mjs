// A lazy HO surface can mount a Page before its API reads finish. Snapshot only
// settled UI; the exact geometry and token comparisons remain unchanged.
export async function installSnapshotReadiness(page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.snapshotReads = { pending: 0, settled: performance.now() };
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const tracked = url.origin === location.origin && url.pathname.startsWith('/api/') && !url.pathname.includes('/events');
      if (tracked) window.snapshotReads.pending++;
      try {
        const response = await original(input, init);
        // Wait for body consumption too, so state updates can see parsed data.
        if (tracked) await response.clone().arrayBuffer();
        return response;
      } finally {
        if (tracked) { window.snapshotReads.pending--; window.snapshotReads.settled = performance.now(); }
      }
    };
  });
}
export async function waitForSnapshotReadiness(page) {
  await page.waitForFunction(() => window.snapshotReads && window.snapshotReads.pending === 0 && performance.now() - window.snapshotReads.settled >= 200);
}
