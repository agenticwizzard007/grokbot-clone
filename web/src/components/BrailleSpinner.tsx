import { useEffect, useState } from 'react';

/**
 * A braille-cell spinner drawn as a 2×4 dot grid (so it never depends on a font having braille glyphs),
 * with one animation per kind of activity. Static under reduced motion.
 */
export type SpinnerVariant = 'dots' | 'orbit' | 'scan' | 'breathe';
const FRAMES: Record<SpinnerVariant, { frames: string; ms: number; still: number }> = {
  dots: { frames: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', ms: 80, still: 2 },
  orbit: { frames: '⣾⣽⣻⢿⡿⣟⣯⣷', ms: 100, still: 0 },
  scan: { frames: '⠁⠂⠄⡀⢀⠠⠐⠈', ms: 90, still: 0 },
  breathe: { frames: '⠀⠄⠆⠇⠿⠇⠆⠄', ms: 160, still: 4 },
};
// Unicode braille: bit → (column, row) in the 2×4 cell.
const DOTS: [number, number, number][] = [[0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08], [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80]];

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function BrailleCell({ ch, size = 14 }: { ch: string; size?: number }) {
  const bits = (ch.codePointAt(0) ?? 0x2800) - 0x2800;
  return (
    <svg className="braille" width={Math.round(size * 0.62)} height={size} viewBox="0 0 10 16" aria-hidden>
      {DOTS.map(([c, r, b]) => <circle key={b} cx={2.5 + c * 5} cy={2.25 + r * 4.5} r={1.35} className={bits & b ? 'is-on' : 'is-off'} />)}
    </svg>
  );
}

export function BrailleSpinner({ variant = 'dots', size = 14 }: { variant?: SpinnerVariant; size?: number }) {
  const spec = FRAMES[variant];
  const frames = [...spec.frames];
  const [i, setI] = useState(0);
  const still = reducedMotion();
  useEffect(() => {
    if (still) return;
    setI(0);
    const t = setInterval(() => setI((x) => (x + 1) % frames.length), spec.ms);
    return () => clearInterval(t);
  }, [variant, still]); // eslint-disable-line react-hooks/exhaustive-deps
  return <BrailleCell ch={frames[still ? spec.still : i % frames.length]} size={size} />;
}

/** "27.4s", "12m, 27.4s", "1h 2m, 3.4s". */
export function fmtElapsed(ms: number): string {
  const t = Math.max(0, ms) / 1000;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (Math.floor((t % 60) * 10) / 10).toFixed(1);
  if (h) return `${h}h ${m}m, ${s}s`;
  if (m) return `${m}m, ${s}s`;
  return `${s}s`;
}

/** Ticks ten times a second, on its own, so the rest of the line doesn't re-render. */
export function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="elapsed">{fmtElapsed(now - since)}</span>;
}
