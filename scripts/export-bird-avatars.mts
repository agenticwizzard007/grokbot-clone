import { mkdir, writeFile } from 'node:fs/promises';
import { BIRD_AVATARS } from '../server/src/avatar-shapes.js';
import { BIRD_PATH, BIRD_FORMATIONS } from '../web/src/avatar/birds.js';

const directory = new URL('../web/public/assets/swarms/avatars/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const { id, label } of BIRD_AVATARS) {
  for (const [suffix, fill] of [['', '#3043AB'], ['-night', '#9BAAF0']]) {
    const paths = BIRD_FORMATIONS[id].map(transform => `  <path transform="${transform}" d="${BIRD_PATH}" />`).join('\n');
    await writeFile(new URL(`${id}${suffix}.svg`, directory), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="${fill}" role="img">\n  <title>${label} birds</title>\n${paths}\n</svg>\n`);
  }
}
