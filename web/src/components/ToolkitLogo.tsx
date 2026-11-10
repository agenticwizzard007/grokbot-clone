import { useState } from 'react';
import { toolkitLogo } from '../lib/toolkitLogos';

/** The same artwork and proportions in the catalog, settings, and chat cards. */
export function ToolkitLogo({ slug, name, logo, size = 40, radius = size / 5, variant = 'tile' }: { slug?: string; name: string; logo?: string; size?: number; radius?: number; variant?: 'tile' | 'mark' }) {
  const source = toolkitLogo({ slug, name, logo });
  const [failedSource, setFailedSource] = useState<string>();
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  const markSize = variant === 'mark' ? size : size * 0.7;
  return (
    <span className={`toolkit-logo${variant === 'mark' ? ' toolkit-logo--mark' : ''}`} style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
      {source && source !== failedSource ? (
        <img src={source} alt="" width={markSize} height={markSize} onError={() => setFailedSource(source)} draggable={false} />
      ) : (
        <span className="toolkit-logo__letter" style={{ fontSize: size * 0.42 }}>{letter}</span>
      )}
    </span>
  );
}
