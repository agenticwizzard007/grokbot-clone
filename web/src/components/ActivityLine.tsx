import { useEffect, useState } from 'react';
import type { Bot, LiveState, Row } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { activityPhrase } from '../lib/phrases';
import { BrailleSpinner, ElapsedTimer, type SpinnerVariant } from './BrailleSpinner';
import type { ActivityKind } from '@shared/types';

/** Which spinner animation fits what the Bot is doing. */
function variantFor(kind: ActivityKind | undefined, waiting: boolean): SpinnerVariant {
  if (waiting || kind === 'waiting_for_you') return 'breathe';
  if (kind === 'browsing_web' || kind === 'on_its_computer') return 'scan';
  if (kind === 'searching_web' || kind === 'reading_web' || kind === 'connecting_service' || kind === 'messaging_named' || kind === 'running_commands' || kind === 'waiting_on_command') return 'orbit';
  return 'dots';
}

/** The single live "activity line": avatar mark + shimmering phrase + a braille spinner and a running clock. */
export function ActivityLine({ bot, live, rows }: { bot: Bot; live: LiveState; rows: Row[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const since = live.startedAt ?? live.activity?.since ?? live.awaiting?.since ?? now;
  const tick = Math.floor((now - (live.activity?.since ?? since)) / 6000);
  const phrase = activityPhrase(live, rows, tick);
  const waiting = !live.isRunning && (live.awaiting || live.activity?.kind === 'waiting_for_you');
  return (
    <div className={`activity-line${waiting ? ' is-waiting' : ''}`} role="status" aria-live="polite">
      <span className="activity-line__mark"><BotAvatarFor bot={bot} size={20} /></span>
      <span className="activity-line__text shimmer" key={phrase}>{phrase}</span>
      <span className="activity-timer" title={waiting ? 'Waiting for you' : 'Working'}>
        <BrailleSpinner variant={variantFor(live.activity?.kind, !!waiting)} />
        <ElapsedTimer since={waiting ? live.awaiting?.since ?? since : since} />
      </span>
      {waiting && live.awaiting?.reason && <span className="activity-line__time">{live.awaiting.reason}</span>}
    </div>
  );
}
