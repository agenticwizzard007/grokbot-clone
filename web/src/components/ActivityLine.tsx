import { useEffect, useState } from 'react';
import { useDisplayText } from '../lib/useDisplayText';
import type { Bot, LiveState, Row } from '@shared/types';
import { FlockMark } from './FlockMark';
import { activityPhrase } from '../lib/phrases';
import { BrailleSpinner, ElapsedTimer, type SpinnerVariant } from './BrailleSpinner';
import type { ActivityKind } from '@shared/types';
import { modelSelection, useModels } from '../lib/models';

/** Which spinner animation fits what the Bot is doing. */
function variantFor(kind: ActivityKind | undefined): SpinnerVariant {
  if (kind === 'browsing_web' || kind === 'on_its_computer') return 'scan';
  if (kind === 'searching_web' || kind === 'reading_web' || kind === 'connecting_service' || kind === 'messaging_named' || kind === 'running_commands' || kind === 'waiting_on_command') return 'orbit';
  return 'dots';
}

/** Phrase rotation updates only its own text, never the activity row or history. */
function WorkingPhrase({ live, rows }: { live: LiveState; rows: Row[] }) {
  const clean = useDisplayText();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 6000);
    return () => clearInterval(timer);
  }, []);
  const since = live.activity?.since ?? live.startedAt ?? now;
  const phrase = clean(activityPhrase(live, rows, Math.max(0, Math.floor((now - since) / 6000))));
  return <span className="activity-line__text shimmer" key={phrase}>{phrase}</span>;
}

/** Working status animates locally; requests for input stay calm until answered. */
export function ActivityLine({ bot, live, rows }: { bot: Bot; live: LiveState; rows: Row[] }) {
  const clean = useDisplayText();
  const effort = useModels(catalog => modelSelection(bot, catalog).effort);
  const [mountedAt] = useState(Date.now);
  const waiting = !!live.awaiting || live.activity?.kind === 'waiting_for_you';
  const since = live.startedAt ?? live.activity?.since ?? mountedAt;
  const waitingSince = new Date(live.awaiting?.since ?? live.activity?.since ?? since);
  return (
    <div className={`activity-line effort-motion${waiting ? ' is-waiting' : ''}`} data-effort={waiting ? undefined : effort ?? undefined} role="status" aria-live="polite">
      <span className="activity-line__mark"><FlockMark size={32} working={!waiting} /></span>
      {waiting ? <>
        <span className="activity-line__text">Needs your input</span>
        <time className="activity-line__time" dateTime={waitingSince.toISOString()} title={waitingSince.toLocaleString([], { dateStyle: 'full', timeStyle: 'long' })}>
          Waiting since {waitingSince.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </time>
      </> : <>
        <WorkingPhrase live={live} rows={rows} />
        <span className="activity-timer" title="Working">
          <BrailleSpinner variant={variantFor(live.activity?.kind)} />
          <ElapsedTimer since={since} />
        </span>
      </>}
      {waiting && live.awaiting?.reason && <span className="activity-line__time">{clean(live.awaiting.reason)}</span>}
    </div>
  );
}
