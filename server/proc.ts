import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run one program without a shell: arguments go straight to it. It always settles: on close, shortly
 * after the program exits, or shortly after a timeout or an abort kills it (with everything it started),
 * even if a leftover child still holds its output open. Used for git (fetching skills) and for skill scripts.
 */

export interface ProgramResult {
  /** Exit code, or null when it was killed or never started. */
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
  /** Stopped by the caller's signal, e.g. a cancelled desk run or fetch. */
  aborted?: boolean;
  /** More output came than was kept. */
  truncated: boolean;
  /** Set when the program could not be started at all. */
  startError?: string;
}

export interface ProgramOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Bytes kept from each of stdout and stderr. */
  cap: number;
  /** Aborting it kills the program and everything it started. */
  signal?: AbortSignal;
}

// After the program exits, output still on its way gets this long. A leftover child holding the pipes must not hang the caller.
const EXIT_GRACE_MS = 2_000;

/** End the program and whatever it started. Windows needs taskkill for the children; elsewhere the process group goes (start it detached). */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const taskkill = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const k = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function runProgram(cmd: string, args: string[], opts: ProgramOptions): Promise<ProgramResult> {
  return new Promise<ProgramResult>((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, out: '', err: '', timedOut: false, aborted: true, truncated: false });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const kept = { out: 0, err: 0 };
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let done = false;
    let child: ChildProcess | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onAbort = () => stop(false);
    const finish = (code: number | null, startError?: string) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener('abort', onAbort);
      // Let go of the pipes, so nothing keeps this process waiting on them.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({
        code,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
        timedOut,
        ...(aborted ? { aborted } : {}),
        truncated,
        ...(startError ? { startError } : {}),
      });
    };
    /** Kill it for a timeout or an abort. A program that ignores the kill, or one whose exit never comes, still ends the wait. */
    const stop = (timeout: boolean) => {
      if (done || timedOut || aborted || !child) return;
      if (timeout) timedOut = true;
      else aborted = true;
      killTree(child);
      timers.push(setTimeout(() => finish(null), EXIT_GRACE_MS));
    };
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env,
        // Its own process group outside Windows, so a timeout can end everything it started.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ code: null, out: '', err: '', timedOut: false, truncated: false, startError: e instanceof Error ? e.message : 'could not start' });
      return;
    }
    const proc = child;
    const keep = (which: 'out' | 'err', list: Buffer[]) => (d: Buffer) => {
      const room = opts.cap - kept[which];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = d.length > room ? d.subarray(0, room) : d;
      if (piece.length < d.length) truncated = true;
      list.push(piece);
      kept[which] += piece.length;
    };
    proc.stdout?.on('data', keep('out', out));
    proc.stderr?.on('data', keep('err', err));
    timers.push(setTimeout(() => stop(true), opts.timeoutMs));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => finish(null, e.message));
    proc.on('exit', (code) => {
      if (!done) timers.push(setTimeout(() => finish(timedOut || aborted ? null : code), EXIT_GRACE_MS));
    });
    proc.on('close', (code) => finish(timedOut || aborted ? null : code));
  });
}

// ---------- finding programs ----------

/** A Windows path that names its drive and folder, or a \\server\share one. `\x` and `C:x` depend on the working folder. */
const WIN_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

function isAbsoluteFor(p: string, win: boolean): boolean {
  return win ? WIN_ABSOLUTE.test(p) : path.posix.isAbsolute(p);
}

/** An environment variable, by any case on Windows (a plain object from a test has no case-blind lookup). */
function envValue(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Something Windows or the OS can start at this exact path. A Microsoft Store app (python, wt) is a link that stat can't open. */
function runnableAt(file: string, win: boolean): boolean {
  try {
    if (win) {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return fs.lstatSync(file).isSymbolicLink();
      }
    }
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full path of a program, found the way HQ wants: in PATH's absolute folders only, never in the
 * current folder, a relative PATH entry, or the folder the child will run in (Windows would look there
 * first). On Windows a bare name gets PATHEXT's .com or .exe, the only kinds that start without a shell.
 * A name with a folder in it must be a full path. Null when there is none. Exported for tests.
 */
export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const text = name.trim();
  if (!text || text.includes('\0')) return null;
  const pathext = (envValue(env, 'PATHEXT', win) ?? '').split(';').map((e) => e.trim().toLowerCase());
  const exts = win ? pathext.filter((e) => e === '.com' || e === '.exe') : [''];
  if (win && !exts.length) exts.push('.com', '.exe');
  const at = (base: string): string | null => {
    // A name that already ends in .exe (or .com) is tried as it is first.
    const own = !win || exts.includes(p.extname(base).toLowerCase()) ? [''] : [];
    for (const ext of new Set([...own, ...exts])) if (runnableAt(base + ext, win)) return base + ext;
    return null;
  };
  if (text.includes('/') || (win && (text.includes('\\') || /^[A-Za-z]:/.test(text)))) {
    return isAbsoluteFor(text, win) ? at(p.normalize(text)) : null;
  }
  const key = (dir: string) => {
    const k = p.normalize(dir).replace(/[\\/]+$/, '');
    return win ? k.toLowerCase() : k;
  };
  const cwd = key(process.cwd());
  for (const raw of (envValue(env, 'PATH', win) ?? '').split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // An empty or relative entry means a folder under whatever the working folder is; the working folder itself is skipped too.
    if (!dir || !isAbsoluteFor(dir, win) || key(dir) === cwd) continue;
    const found = at(p.join(dir, text));
    if (found) return found;
  }
  return null;
}
