/** Official Swarm artwork, shared by join and connection screens. */
export function SwarmMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return <span className={`swarm-mark ${className}`} style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }} aria-hidden="true">
    <img className="brand-image brand-image--light" src="/assets/swarms/flock.svg" width={size} height={size} alt="" />
    <img className="brand-image brand-image--night" src="/assets/swarms/flock-night.svg" width={size} height={size} alt="" />
  </span>;
}
