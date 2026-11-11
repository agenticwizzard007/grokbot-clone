import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export function validFolderPath(value: string) {
  return value.length <= 1000 && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255)
    && /^[A-Za-z0-9_-]{1,120}$/.test(value.split('/')[0]);
}
export const mcpFoldersSchema = z.array(z.string().refine(validFolderPath, 'Choose a folder from your files.')).max(8).default([])
  .refine(values => values.every((value, i) => !values.some((other, j) => i !== j && (value === other || value.startsWith(other + '/')))), 'Choose each folder once without overlapping parent folders.');

/** Resolve each component relative to an open directory, without following links.
 * The caller owns the returned descriptor. Keep it open until the host bind mount
 * has completed; a later pathname replacement must never change the selected inode. */
export function openMcpFolder(root: string, relative: string): number {
  if (!validFolderPath(relative) || !path.isAbsolute(root) || fs.realpathSync(root) !== root) throw new Error('Folder is unavailable.');
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let fd = fs.openSync(root, flags);
  try {
    for (const component of relative.split('/')) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${component}`, flags);
      fs.closeSync(fd); fd = next;
      if (!fs.realpathSync(`/proc/self/fd/${fd}`).startsWith(root + path.sep)) throw new Error('Folder is unavailable.');
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
