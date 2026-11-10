/**
 * Claude's pixel mascot, used for every Claude (Anthropic) model instead of the Anthropic logo.
 * Drawn on an 11×6 pixel grid so it stays crisp at 16px. It blinks now and then; on hover of its
 * row or pill it hops and its legs patter (see composer-models.css). Still under reduced motion.
 */
const BODY = '#D97757';
const EYE = '#2A1A12';

export function ClaudeMascot({ size = 16, className = '' }: { size?: number; className?: string }) {
  const h = Math.round((size * 6) / 11);
  return (
    <svg className={`claude-mascot ${className}`} width={size} height={h} viewBox="0 0 11 6" shapeRendering="crispEdges" aria-hidden>
      <g className="claude-mascot__body">
        <rect x="1" y="0" width="9" height="4" fill={BODY} />
        <rect x="0" y="2" width="11" height="1" fill={BODY} />
        <rect className="claude-mascot__eye" x="3" y="1" width="1" height="1" fill={EYE} />
        <rect className="claude-mascot__eye" x="7" y="1" width="1" height="1" fill={EYE} />
      </g>
      <g className="claude-mascot__legs-a">
        <rect x="1" y="4" width="1" height="2" fill={BODY} />
        <rect x="7" y="4" width="1" height="2" fill={BODY} />
      </g>
      <g className="claude-mascot__legs-b">
        <rect x="3" y="4" width="1" height="2" fill={BODY} />
        <rect x="9" y="4" width="1" height="2" fill={BODY} />
      </g>
    </svg>
  );
}
