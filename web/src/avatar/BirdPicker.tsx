import { useId } from 'react';
import { BIRD_AVATARS } from '@shared/avatar-shapes';
import type { AvatarShape, AvatarColor } from '@shared/types';
import { BotAvatar } from './BotAvatar';
import './BirdPicker.css';

/** Native radios provide arrow-key selection and retain an unselected legacy value. */
export function BirdPicker({ shape, color, onShape }: { shape: AvatarShape; color: AvatarColor; onShape: (shape: AvatarShape) => void }) {
  const name = useId();
  return <div className="bird-picker" role="radiogroup" aria-label="Character shape">
    {BIRD_AVATARS.map(bird => <label key={bird.id} className="bird-picker__choice">
      <input type="radio" name={name} value={bird.id} aria-label={bird.label} checked={shape === bird.id} onChange={() => onShape(bird.id)} />
      <BotAvatar shape={bird.id} color={color} size={32} />
      <span className="bird-picker__label">{bird.label}</span>
    </label>)}
  </div>;
}
