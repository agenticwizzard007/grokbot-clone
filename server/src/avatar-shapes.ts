/** Suggested avatars. Legacy shapes stay in AvatarShape for stored Bots and imports. */
export const BIRD_AVATARS = [
  { id: 'bird-flock', label: 'Flock' },
  { id: 'bird-solo', label: 'Solo' },
  { id: 'bird-soar', label: 'Soar' },
  { id: 'bird-glide', label: 'Glide' },
  { id: 'bird-pair', label: 'Pair' },
  { id: 'bird-rise', label: 'Rise' },
  { id: 'bird-arc', label: 'Arc' },
  { id: 'bird-vee', label: 'Vee' },
  { id: 'bird-diamond', label: 'Diamond' },
  { id: 'bird-cascade', label: 'Cascade' },
] as const;

export type BirdAvatarShape = typeof BIRD_AVATARS[number]['id'];
export const BIRD_SHAPES = BIRD_AVATARS.map(({ id }) => id);
export const DEFAULT_AVATAR_SHAPE: BirdAvatarShape = 'bird-flock';

export function isBirdShape(shape: string): shape is BirdAvatarShape {
  return BIRD_SHAPES.some(id => id === shape);
}
