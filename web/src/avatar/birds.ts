import type { BirdAvatarShape } from '@shared/avatar-shapes';

// Exact wing path from public/assets/swarms/flock.svg, originally exported from Paper.
// Only formations change. scripts/export-bird-avatars.mts exports these as standalone SVGs.
export const BIRD_PATH = 'M-31.1 -2.6 Q-31.7 -4.4 -29.7 -5.6 C-19.6 -12.2 -5.3 -10.1 4.9 -1.3 C12.6 -9.7 22.4 -15.7 34.1 -16.3 Q36.8 -16.6 37.2 -15 Q37.4 -13.9 35.9 -12.4 C26.6 -5.2 18.3 6.9 12.5 17.5 Q10 22.2 7 18.5 C-3 7.9 -15.1 1.6 -28.4 -0.7 Q-30.6 -1 -31.1 -2.6Z';

export const BIRD_FORMATIONS: Record<BirdAvatarShape, readonly string[]> = {
  'bird-flock': ['translate(49 24) rotate(5) scale(.84)', 'translate(30 52) rotate(13) scale(.74)', 'translate(63 75) rotate(-2) scale(.77)'],
  'bird-solo': ['translate(46 48) rotate(-8) scale(1.2)'],
  'bird-soar': ['translate(47 49) rotate(-35) scale(1.16)'],
  'bird-glide': ['translate(47 47) rotate(28) scale(1.16)'],
  'bird-pair': ['translate(39 32) rotate(-10) scale(.94)', 'translate(55 66) rotate(8) scale(.94)'],
  'bird-rise': ['translate(27 75) rotate(-20) scale(.65)', 'translate(48 49) rotate(-20) scale(.76)', 'translate(65 22) rotate(-20) scale(.72)'],
  'bird-arc': ['translate(25 64) rotate(-30) scale(.6)', 'translate(46 30) rotate(-5) scale(.78)', 'translate(73 61) rotate(25) scale(.6)'],
  'bird-vee': ['translate(24 31) rotate(-10) scale(.62)', 'translate(74 31) rotate(10) scale(.62)', 'translate(47 68) scale(.9)'],
  'bird-diamond': ['translate(48 21) scale(.62)', 'translate(23 48) rotate(-15) scale(.58)', 'translate(74 48) rotate(15) scale(.58)', 'translate(48 77) scale(.62)'],
  'bird-cascade': ['translate(35 19) rotate(8) scale(.68)', 'translate(65 39) rotate(-8) scale(.68)', 'translate(32 61) rotate(8) scale(.68)', 'translate(62 81) rotate(-8) scale(.68)'],
};
