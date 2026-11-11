import fs from 'node:fs';
import { db } from '../db.js';
import { env } from '../env.js';
import { assertTenant } from '../deployment.js';
import { openMcpFolder, validFolderPath } from '../security/mcp-folders.js';

function ownsFolder(userId: string, folder: string) {
  assertTenant(userId);
  if (!validFolderPath(folder) || !db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(folder.split('/')[0], userId)) throw new Error('Folder not found.');
}
export function validateMcpFolders(userId: string, folders: string[]) {
  for (const folder of folders) {
    ownsFolder(userId, folder);
    try { fs.closeSync(openMcpFolder(env.filesDir, folder)); }
    catch { throw new Error('Folder not found.'); }
  }
}
/** Only folders in the owner's Library; never database, desktop or runner homes. */
export function listMcpFolders(userId: string, folder = '', after = '') {
  assertTenant(userId);
  if (after.length > 1000) throw new Error('Folder not found.');
  const choices: { path: string; name: string }[] = [];
  if (!folder) {
    const bots = db.prepare('SELECT id,name FROM bots WHERE user_id=? AND id>? ORDER BY id LIMIT 201').all(userId, after) as { id: string; name: string }[];
    for (const bot of bots.slice(0, 200)) {
      try { validateMcpFolders(userId, [bot.id]); choices.push({ path: bot.id, name: bot.name }); } catch { /* No local Library yet. */ }
    }
    return { folders: choices, next: bots.length === 201 ? bots[199].id : null };
  }
  ownsFolder(userId, folder);
  let fd: number | undefined;
  try {
    fd = openMcpFolder(env.filesDir, folder);
    const dir = fs.opendirSync(`/proc/self/fd/${fd}`);
    try {
      let count = 0;
      for (let entry; (entry = dir.readSync());) {
        if (++count > 5000) throw new Error('Folder has too many entries. Choose a smaller folder.');
        const relative = `${folder}/${entry.name}`;
        if (!entry.isDirectory() || !validFolderPath(relative) || relative <= after) continue;
        choices.push({ path: relative, name: entry.name });
        choices.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        if (choices.length > 201) choices.pop();
      }
    } finally { dir.closeSync(); }
    const more = choices.length > 200; choices.splice(200);
    return { folders: choices, next: more ? choices.at(-1)!.path : null };
  } catch { throw new Error('Folder not found or too large to browse.'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
