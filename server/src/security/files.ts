import fs from 'node:fs';
import path from 'node:path';
/** Open first, then validate the resolved descriptor: symlink races cannot redirect the returned descriptor. */
export function openOwnedFile(root: string, relative: string) {
  if(!relative||path.isAbsolute(relative)||relative.includes('\0')||relative.split(/[\\/]/).some(p=>p==='..'))throw new Error('Invalid file path.');
  const base=fs.realpathSync(root),target=path.resolve(base,relative);
  if(!target.startsWith(base+path.sep))throw new Error('Invalid file path.');
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const resolved=fs.realpathSync(`/proc/self/fd/${fd}`);
    if(!resolved.startsWith(base+path.sep)||!fs.fstatSync(fd).isFile())throw new Error('File is outside your storage.');
    return fd;
  }catch(e){fs.closeSync(fd);throw e;}
}
export function validateArchiveEntry(name: string) {
  if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some(p=>p==='..'))throw new Error('Unsafe archive entry.');
  return name;
}
