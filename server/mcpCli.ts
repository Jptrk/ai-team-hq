import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { MASK, TOKEN_PREFIXES, type BuiltSpec, type CliScope } from '../shared/mcpSpec';
import { claudeEnv } from './paths';
import { findProgram } from './proc';

/**
 * Runs Claude Code's own `claude mcp ...` commands, so servers are saved exactly where and how
 * Claude Code saves them. It uses the CLI that ships with the Agent SDK (the same one desks run),
 * never whatever `claude` is first on PATH. No shell: arguments go straight to the program.
 */

/** Claude Code's settings folder: credentials and settings.json. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Claude Code's main config file, with every MCP server outside a repo's .mcp.json. */
export function claudeJsonPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/**
 * The claude program, always as a full path: runCli starts it in a project folder, and Windows would run a
 * claude.exe planted there before one on PATH. HQ_CLAUDE_BIN may be a full path or a name looked up in PATH.
 */
export function claudeBin(): string {
  const own = process.env.HQ_CLAUDE_BIN?.trim();
  if (own) {
    const found = findProgram(own);
    if (!found) throw new Error('HQ_CLAUDE_BIN must be a full path, or a program on PATH.');
    return found;
  }
  const require = createRequire(import.meta.url);
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  return path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
}

export interface CliResult {
  code: number | null;
  /** Scrubbed of every secret. */
  out: string;
  err: string;
  timedOut: boolean;
}

const OUTPUT_CAP = 256 * 1024;
// After the program exits, output still on its way gets this long. A leftover child holding the pipes must not hang the queue.
const EXIT_GRACE_MS = 2_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TOKEN_PREFIXED = new RegExp(`\\b(${TOKEN_PREFIXES})[-_][A-Za-z0-9_\\-]+`, 'g');
const LONG_TOKEN = /\b[A-Za-z0-9_\-]{32,}\b/g;

/** Blank every secret (as typed, JSON-escaped and URL-encoded), bearer tokens and token-like words. */
export function scrub(text: string, secrets: string[] = [], max = 300): string {
  let s = text.replace(ANSI, '');
  for (const secret of secrets) {
    if (secret.length < 3) continue;
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) s = s.split(form).join(MASK);
  }
  s = s.replace(/Bearer\s+\S+/gi, `Bearer ${MASK}`).replace(TOKEN_PREFIXED, MASK).replace(LONG_TOKEN, MASK);
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A sentence from what the CLI printed. Never the command line: it holds the secrets. */
export function cliMessage(r: CliResult, fallback: string): string {
  if (r.timedOut) return 'Claude Code did not answer in time.';
  const lines = (r.err || r.out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(-2).join(' ') : fallback;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run one `claude` command. Calls are queued, so two never write Claude Code's config at once.
 * Errors come back as a result, never as a throw carrying the command line. It always settles:
 * on close, shortly after the program exits, or shortly after a timeout kills it, even if a
 * leftover child still holds its output open. `bin` is for tests.
 */
export function runCli(args: string[], opts: { cwd: string; secrets?: string[]; timeoutMs?: number; bin?: string }): Promise<CliResult> {
  const secrets = opts.secrets ?? [];
  const run = () =>
    new Promise<CliResult>((resolve) => {
      let out = '';
      let err = '';
      let timedOut = false;
      let done = false;
      let child: ReturnType<typeof spawn> | null = null;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (code: number | null, fallback?: string) => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
        // Let go of the pipes, so nothing keeps this process waiting on them.
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        resolve({ code, out: scrub(out, secrets, 2000), err: fallback ?? scrub(err, secrets, 2000), timedOut });
      };
      try {
        child = spawn(opts.bin ?? claudeBin(), args, {
          cwd: opts.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: claudeEnv({ DISABLE_AUTOUPDATER: '1' }),
        });
      } catch {
        resolve({ code: null, out: '', err: 'Could not start Claude Code.', timedOut: false });
        return;
      }
      const proc = child;
      timers.push(
        setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            /* already gone */
          }
          // A program that ignores the kill, or one whose exit never comes, still ends the wait.
          timers.push(setTimeout(() => finish(null), EXIT_GRACE_MS));
        }, opts.timeoutMs ?? 30_000),
      );
      proc.stdout?.on('data', (d: Buffer) => {
        if (out.length < OUTPUT_CAP) out += d.toString('utf8');
      });
      proc.stderr?.on('data', (d: Buffer) => {
        if (err.length < OUTPUT_CAP) err += d.toString('utf8');
      });
      proc.on('error', () => finish(null, 'Could not start Claude Code.'));
      proc.on('exit', (code) => {
        if (!done) timers.push(setTimeout(() => finish(timedOut ? null : code), EXIT_GRACE_MS));
      });
      proc.on('close', (code) => finish(timedOut ? null : code));
    });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export function addArgs(spec: Pick<BuiltSpec, 'name' | 'scope' | 'config'>): string[] {
  return ['mcp', 'add-json', '--scope', spec.scope, '--', spec.name, JSON.stringify(spec.config)];
}

export function removeArgs(name: string, scope: CliScope): string[] {
  return ['mcp', 'remove', '--scope', scope, '--', name];
}

export function logoutArgs(name: string): string[] {
  return ['mcp', 'logout', '--', name];
}

/**
 * Windows Terminal's arguments: start in `folder`, optionally running `<bin> mcp login <name>`.
 * Windows Terminal reads ; as "new tab" even inside one argument, so every ; is escaped as \;.
 * Each piece stays one argument (spawn quotes the ones with spaces). Pure, for tests.
 */
export function terminalArgs(folder: string, loginName?: string, bin?: string): string[] {
  const esc = (s: string) => s.replaceAll(';', '\\;');
  const args = ['-d', esc(folder)];
  if (loginName && bin) args.push(esc(bin), 'mcp', 'login', '--', esc(loginName));
  return args;
}

/**
 * Open Windows Terminal in the project folder, optionally running `claude mcp login <name>` there,
 * with the same claude.exe HQ uses, never whatever `claude` is first on PATH. The caller checks the name.
 * It's your own terminal window: nothing runs through HQ's web page.
 */
export function openTerminal(folder: string, loginName?: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Opening a terminal is only set up for Windows.'));
  let bin: string | undefined;
  if (loginName) {
    try {
      bin = claudeBin();
    } catch {
      return Promise.reject(new Error("HQ can't find its Claude Code program. Open a terminal and run claude mcp login yourself."));
    }
  }
  const args = terminalArgs(folder, loginName, bin);
  return new Promise((resolve, reject) => {
    const child = spawn('wt.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', () => reject(new Error('Windows Terminal was not found. Install it from the Microsoft Store, or open a terminal yourself.')));
  });
}
