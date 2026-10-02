import path from 'node:path';
import type { ToolKind } from '../../shared/activity';

/**
 * What each live run's last tool did, so the Office can tell Coding from Working.
 * In memory only: it's about what a desk is doing this minute. One map for every project.
 */

const lastTool = new Map<string, { kind: ToolKind; at: number }>();

// Runs time out after 10 minutes, so an entry nobody has touched for 30 belongs to a run long gone.
const FORGET_MS = 30 * 60_000;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

type Block = { type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } };

/** Strictly inside `root`: not the folder itself, not beside it ("..env.local" is a file in it, "..\x" is not). */
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../') && !path.isAbsolute(rel);
}

/** "\\?\C:\x" is "C:\x", and "\\?\UNC\server\share" is "\\server\share". */
function plainPath(file: string): string {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(file)) return `\\\\${file.slice(8)}`;
  return /^[\\/]{2}\?[\\/]/.test(file) ? file.slice(4) : file;
}

/**
 * Writing or editing a file in the project folder is coding. Anything else, reports in the desk's own folder
 * included, is not. `projectDir` is null when the run may not write there (read-only project, QA check, huddle),
 * so a write the guard is about to refuse never shows as coding. Relative paths resolve against `cwd`, the run's
 * working folder (the desk's workspace), as the SDK does.
 */
export function toolKind(name: string, input: Block['input'], projectDir: string | null, cwd: string): ToolKind {
  if (!WRITE_TOOLS.has(name) || !projectDir) return 'other';
  const file = input?.file_path ?? input?.notebook_path;
  if (typeof file !== 'string' || !file) return 'other';
  const target = path.resolve(cwd, plainPath(file));
  // A linked folder can sit around HQ: the desk's own workspace is never the project.
  if (target === path.resolve(cwd) || within(cwd, target)) return 'other';
  return within(projectDir, target) ? 'code' : 'other';
}

/** Record the last tool used in an assistant message of a run. See toolKind for `projectDir` and `cwd`. */
export function noteTools(runId: string, msg: unknown, projectDir: string | null, cwd: string): void {
  if ((msg as { type?: string } | null)?.type !== 'assistant') return;
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content as Block[]) {
    if (b.type === 'tool_use' && typeof b.name === 'string') setLastTool(runId, toolKind(b.name, b.input, projectDir, cwd));
  }
}

/** Last tool for each of these running runs. Old entries from any project are dropped as they age out. */
export function lastTools(running: Set<string>, now = Date.now()): Record<string, ToolKind> {
  const out: Record<string, ToolKind> = {};
  for (const [id, t] of lastTool) {
    if (running.has(id)) out[id] = t.kind;
    else if (now - t.at > FORGET_MS) lastTool.delete(id);
  }
  return out;
}

/** The runner calls this through noteTools; tests and the demo set it directly. */
export function setLastTool(runId: string, kind: ToolKind, at = Date.now()): void {
  lastTool.set(runId, { kind, at });
}
