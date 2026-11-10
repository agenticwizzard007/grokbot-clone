// Before the Swarm rename, browser preferences were saved as "grokbot.*" (theme, last Bot, panels).
// Copy them to "swarm.*" once. Imported first by the stores that read them (main.tsx would run too late:
// the build puts the stores in a shared chunk that executes before the entry's own code).
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('grokbot.')) continue;
    const next = `swarm.${key.slice('grokbot.'.length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
    localStorage.removeItem(key);
  }
} catch { /* storage unavailable */ }
