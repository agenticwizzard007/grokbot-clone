import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { BIRD_SHAPES, isBirdShape } from '@shared/avatar-shapes';
import type { CSSProperties } from 'react';
import { userFacingLive } from '../lib/audience';
import { palette } from '../lib/colors';
import { useStore } from '../store';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from './shapes.gen';
import { BIRD_PATH, BIRD_FORMATIONS } from './birds';
import './BotAvatar.css';

/** Shapes without an exported SVG fall back to the closest silhouette we have. */
const FALLBACK: Partial<Record<AvatarShape, string>> = {
  bean: 'teardrop', squircle: 'square', capsule: 'tablet', cylinder: 'tablet', gem: 'hex', crystal: 'hex',
  shield: 'house', dome: 'house', arch: 'house', leaf: 'teardrop',
};

export function shapeDef(shape: AvatarShape | string): ShapeDef {
  return SHAPES[shape] ?? SHAPES[FALLBACK[shape as AvatarShape] ?? 'blob'] ?? SHAPES.blob;
}

/** Bird suggestions only. Stored legacy silhouettes remain renderable. */
export const PICKER_SHAPES: readonly AvatarShape[] = BIRD_SHAPES;

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. Legacy silhouettes retain their original overflow. */
  size: number;
  star?: boolean;
  /** Selected-shape ring (white gap + gray outline following the silhouette). */
  ring?: boolean;
  className?: string;
  title?: string;
  working?: boolean;
}

const OVERDRAW = 55.2 / 36;

export function BotAvatar({ shape, color, size, star, ring, className, title, working }: Props) {
  const bird = isBirdShape(shape) ? shape : null;
  const def = shapeDef(shape);
  const draw = size * OVERDRAW;
  const off = (draw - size) / 2;
  const fill = palette(color).fill;
  // Stroke widths in viewBox units: viewBox width maps to `draw` px.
  const vbw = Number(def.viewBox.split(/\s+/)[2]);
  const px = vbw / draw;
  return (
    <span className={`bot-avatar${working ? ' bot-avatar--working' : ''} ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      {/* Separate SVG families so switching a stored silhouette drops its cached drawing size and paint. */}
      {bird ? <svg key="bird" className="bot-avatar__bird" data-bird={bird} width={size} height={size} viewBox="0 0 100 100" style={{ '--bird-fill': color === 'black' ? 'var(--color-text-primary)' : fill } as CSSProperties} aria-hidden>
        {ring && <rect x="2" y="2" width="96" height="96" rx="20" fill="none" stroke="currentColor" strokeWidth="3" />}
        <g fill="currentColor">{BIRD_FORMATIONS[bird].map((transform, i) => <path key={i} d={BIRD_PATH} transform={transform} />)}</g>
      </svg> : <svg key="legacy" width={draw} height={draw} viewBox={def.viewBox} style={{ position: 'absolute', left: -off, top: -off, overflow: 'visible' }} aria-hidden>
        {ring && <path d={def.outline} fill="#1C1C1C3D" stroke="#1C1C1C3D" strokeWidth={px * 2 * 3.4} strokeLinejoin="round" />}
        {ring && <path d={def.outline} fill="#FFFFFF" stroke="#FFFFFF" strokeWidth={px * 2 * 2.4} strokeLinejoin="round" />}
        <path d={def.outline} fill="#FFFFFF" />
        <path d={def.d} fill={fill} fillRule="evenodd" />
      </svg>}
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

type AvatarBot = Pick<Bot, 'name'> & Partial<Pick<Bot, 'id' | 'isPrimary'>> & {
  avatarShape: Props['shape'];
  avatarColor: Props['color'];
};

export function BotAvatarFor({ bot, size, star, className, working }: { bot: AvatarBot; size: number; star?: boolean; className?: string; working?: boolean }) {
  // Snapshots with a real ID use that Bot's live state, even outside the selected chat.
  // Raw BotAvatar shape previews stay independent of the store.
  const isWorking = useStore(state => {
    if (!bot.id) return !!working;
    const live = userFacingLive(state.live[bot.id]);
    return !!live?.isRunning && !live.awaiting;
  });
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={!bot.isPrimary && star} className={className} title={bot.name} working={isWorking} />;
}
