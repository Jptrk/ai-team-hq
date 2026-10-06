import fs from 'node:fs';
import path from 'node:path';

/**
 * Desks never delete for good. A file or folder a desk deletes moves into the project's trash in HQ's data folder,
 * where you can get it back:
 *   data/projects/<project>/trash/<when>-<desk>/<workspace|project>/<its path>
 * Nothing empties the trash on its own.
 */

export function trashRoot(pid: string): string {
  return path.resolve(process.cwd(), 'data', 'projects', pid, 'trash');
}

/** One trash folder per deletion, named by time and desk: "2026-10-07T09-15-02-417Z-leo". */
export function trashBatch(pid: string, agentId: string, at = new Date()): string {
  return path.join(trashRoot(pid), `${at.toISOString().replace(/[:.]/g, '-')}-${agentId}`);
}

/** Moves src to dest, which must not exist. Across drives (a project folder on D:) it is copied, then removed. */
export function moveToTrash(src: string, dest: string): void {
  if (fs.existsSync(dest)) throw Object.assign(new Error('The trash already has that path.'), { code: 'EEXIST' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}
