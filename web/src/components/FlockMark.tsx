/** Official Paper artwork; static artwork is used when reduced motion is requested. */
export function FlockMark({ size = 32, working = false }: { size?: number; working?: boolean }) {
  return <span className={`flock-mark${working ? ' is-working' : ''}`} style={{ width: size, height: size }} aria-hidden>
    <img className="brand-image brand-image--light flock-mark__static" src="/assets/swarms/flock.svg" alt="" />
    <img className="brand-image brand-image--night flock-mark__static" src="/assets/swarms/flock-night.svg" alt="" />
    {working && <>
      <img className="brand-image brand-image--light flock-mark__moving" src="/assets/swarms/flock-working-light.svg" alt="" />
      <img className="brand-image brand-image--night flock-mark__moving" src="/assets/swarms/flock-working-night.svg" alt="" />
    </>}
  </span>;
}
