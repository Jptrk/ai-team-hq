import fs from 'node:fs';
import path from 'node:path';
import { shellOn, type ProjectMeta } from '../../shared/types';
import { claudeEnv } from '../paths';
import { findProgram, runProgram, type ProgramResult } from '../proc';
import { globToRegExp, type ToolReply } from './codexTools';

/**
 * Desks' shell, when the founder turned it on for the project (Project settings, Shell). Claude desks get Claude
 * Code's own Bash tool; GPT desks get HQ's Bash tool below, shaped like it (Codex's own shell stays off). Either way
 * a command runs in bash (Git Bash on Windows), starting in the desk's workspace, on this PC as the founder: no
 * sandbox. Ticket runs, chat replies and QA checks get it; huddles and plans only read.
 *
 * HQ reads every command first and refuses a few things (shellRefusal): git push, any command that names a .env
 * file, a command left running in the background, and deleting outside where the desk may write (the guard's fence,
 * never .git, .env files, keys or a folder holding one, the desk's ROLE.md, memory.md and reports, or the workspace
 * and project folders themselves). It reads the command's text, the way bash would split it, so it is best effort and
 * not a fence: a script, an alias or a program can still do any of those. Everything else runs.
 */

/** Whether a run gets a shell: the project has it on, and the run is not a huddle or a plan. */
export function shellFor(meta: Pick<ProjectMeta, 'shell'>, mode: string | undefined): boolean {
  return shellOn(meta) && mode !== 'huddle' && mode !== 'plan';
}

// ---------- reading a command ----------

/** One word of a command, after quotes, the way a shell would pass it on. */
interface Word {
  text: string;
  /** Holds $ or a backtick (or %, outside bash), or starts with ~: its value is only known when it runs. */
  dynamic: boolean;
  /** Holds *, ?, [ or { outside quotes: a pattern the shell turns into file names. */
  glob: boolean;
  /** The file of a redirect (> out.txt, < in.txt), not an argument. */
  redirect: boolean;
}

/**
 * A command split into the simple commands it runs: at ; & | ( ) ` and new lines, each a list of words. posix: bash's
 * rules (backslash escapes, # comments, a lone & leaves a command running in the background); otherwise PowerShell's
 * and cmd's, where a backslash is a plain character and & runs the next command.
 */
function splitCommand(command: string, posix: boolean): { segments: Word[][]; background: boolean } {
  const segments: Word[][] = [];
  let background = false;
  let words: Word[] = [];
  let cur: Word | null = null;
  let redirectNext = false;
  const word = (): Word => {
    if (!cur) {
      cur = { text: '', dynamic: false, glob: false, redirect: redirectNext };
      redirectNext = false;
    }
    return cur;
  };
  const push = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const end = () => {
    push();
    if (words.length) segments.push(words);
    words = [];
    redirectNext = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (posix && c === '\\') {
      if (command[i + 1] === '\n') i++;
      else if (i + 1 < command.length) word().text += command[++i];
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      word().text += command.slice(i + 1, close === -1 ? command.length : close);
      i = close === -1 ? command.length : close;
      continue;
    }
    if (c === '"') {
      const w = word();
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const d = command[i];
        if (posix && d === '\\' && '"\\$`'.includes(command[i + 1] ?? '')) {
          w.text += command[++i];
          continue;
        }
        if (d === '$' || d === '`' || (!posix && d === '%')) w.dynamic = true;
        w.text += d;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      push();
      continue;
    }
    if (posix && c === '#' && !cur) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '<' || c === '>') {
      // A file descriptor right before it (2>) belongs to the redirect.
      if (cur && /^\d+$/.test((cur as Word).text)) cur = null;
      else push();
      while ('<>&|'.includes(command[i + 1] ?? '')) i++;
      // >&2 and 2>&1 name no file.
      if (command[i] === '&' && /[\d-]/.test(command[i + 1] ?? '')) {
        while (/[\d-]/.test(command[i + 1] ?? '')) i++;
        continue;
      }
      redirectNext = true;
      continue;
    }
    if (c === '&') {
      end();
      const next = command[i + 1] ?? '';
      // && runs the next command, |& is a pipe, &> a redirect. Anything else leaves a command running.
      if (next === '&') i++;
      else if (next === '>') {
        while ('>|'.includes(command[i + 1] ?? '')) i++;
        redirectNext = true;
      } else if (posix && command[i - 1] !== '|') background = true;
      continue;
    }
    if (';|()`\n'.includes(c)) {
      end();
      continue;
    }
    const w = word();
    if (c === '$' || (!posix && c === '%') || (posix && c === '~' && w.text === '')) w.dynamic = true;
    if ('*?[{'.includes(c)) w.glob = true;
    w.text += c;
  }
  end();
  return { segments, background };
}

/** "rm" for rm, /usr/bin/rm, C:\tools\rm.exe or RM.EXE. */
const programName = (text: string) =>
  path.win32
    .basename(text)
    .toLowerCase()
    .replace(/\.(exe|com|cmd|bat)$/, '');

/** Prefixes that run the program after them: env, sudo, timeout 30, nice -n 5... */
const WRAPPERS = new Set(['env', 'sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout', 'stdbuf', 'winpty']);
/** Wrapper options whose value is the next word: env -u NAME, timeout -s KILL, sudo -u user... */
const WRAPPER_VALUES = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-s', '--signal', '-k', '--kill-after', '-n', '--adjustment', '-g']);
/** bash words that come before the command they run: if git push; then rm -rf x; fi, { git push; }. */
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', '}', 'coproc']);

/** The program a simple command runs and its arguments, past VAR=x prefixes, bash keywords, wrappers and redirects. */
function commandOf(segment: Word[]): { name: string; args: Word[] } | null {
  const words = segment.filter((w) => !w.redirect);
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || KEYWORDS.has(text)) continue;
    const name = programName(text);
    if (!WRAPPERS.has(name)) return { name, args: words.slice(i + 1) };
    // A wrapper's own options (with their values) and numbers come before the program it runs.
    while (i + 1 < words.length && /^(-|\d)/.test(words[i + 1].text)) {
      i++;
      if (WRAPPER_VALUES.has(words[i].text) && i + 1 < words.length) i++;
    }
  }
  return null;
}

/** Where a path a command names points, or null when HQ can't tell. On Windows, Git Bash's /c/x is C:\x; its other / folders are its own. */
function resolveText(text: string, cwd: string | null, win: boolean): string | null {
  const p = win ? path.win32 : path.posix;
  if (win) {
    const drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(text);
    if (drive) return p.resolve(`${drive[1].toUpperCase()}:\\`, drive[2] ?? '');
    // \x is the current drive's root, and C:x a drive's own current folder: neither is known here.
    if (/^[\\/]/.test(text) || /^[A-Za-z]:(?![\\/])/.test(text)) return null;
  }
  if (p.isAbsolute(text)) return p.resolve(text);
  return cwd === null ? null : p.resolve(cwd, text);
}

// ---------- what HQ refuses ----------

export interface ShellFence {
  /** Where the command starts: the desk's workspace. */
  cwd: string;
  /**
   * Why the desk may not delete `target`, or null. With `inside`, the command deletes things under `target`, not
   * `target` itself, and inside(rel) says whether it could reach rel ('/'-separated, relative to `target`).
   */
  deleteRefusal: (target: string, inside?: (rel: string) => boolean) => string | null;
  /** Windows, where /c/x is C:\x. This PC's unless a test says otherwise. */
  win?: boolean;
}

/** A .env file named anywhere in the command: .env, ./app/.env.local, --env-file=.env. Not process.env or .envrc. */
const ENV_FILE = /(?:^|[\s'"`=:;,|&<>(){}[\]\\/])\.env(?:\.[\w.-]*)?(?![\w-])/i;
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'remove-item', 'ri', 'rimraf', 'trash', 'trash-put']);
const CMD_DELETERS = new Set(['del', 'erase', 'rd', 'rmdir']);
/** PowerShell's Remove-Item options that take a value which is not a path. */
const PS_VALUE = new Set(['-include', '-exclude', '-filter', '-credential', '-stream']);
const CHDIR = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** powershell.exe options whose value is the next word: -ExecutionPolicy Bypass, -WindowStyle Hidden, -Version 5... */
const PS_SHELL_VALUE = /^-(ex|ep|w|ve|in|if|ou|of|con|ps|se|cu)/;
/** How deep commands inside commands (bash -c "...", a quoted $(...)) are read. */
const MAX_DEPTH = 4;

/**
 * Why HQ refuses this command, or null when it may run: git push, a .env file named anywhere, a lone &, or a delete
 * outside the fence (see ShellFence). Best effort: it reads the text the way bash would split it. Exported for tests.
 */
export function shellRefusal(command: string, fence: ShellFence): string | null {
  if (ENV_FILE.test(command)) {
    return "HQ refuses any command that names a .env file: those hold the founder's secrets. Do without it, and say in your summary what you needed from it.";
  }
  return check(command, true, true, fence.cwd, fence, 0);
}

/** sure: the text is a command (not a quoted word that may be one), so a lone & in it leaves a command running. */
function check(command: string, posix: boolean, sure: boolean, start: string | null, fence: ShellFence, depth: number): string | null {
  const win = fence.win ?? process.platform === 'win32';
  const { segments, background } = splitCommand(command, posix);
  if (sure && background) return 'HQ refuses a command left running in the background (a lone &): it would outlive your run. Run it in the foreground, with a timeout if it takes long.';
  let cwd = start;
  for (const segment of segments) {
    const cmd = commandOf(segment);
    if (cmd) {
      const why = refusalFor(cmd.name, cmd.args, cwd, fence, win, depth);
      if (why) return why;
      if (CHDIR.has(cmd.name)) {
        const to = cmd.args.find((w) => w.text === '-' || (w.text !== '--' && !/^-[A-Za-z]*$/.test(w.text)));
        cwd = !to || to.dynamic || to.text === '-' ? null : resolveText(to.text, cwd, win);
      }
      // popd goes back to a folder HQ did not keep.
      if (cmd.name === 'popd' || cmd.name === 'pop-location') cwd = null;
      // Its command is read above, as that shell reads it.
      if (POSIX_SHELLS.has(cmd.name) || cmd.name === 'powershell' || cmd.name === 'pwsh' || cmd.name === 'cmd') continue;
    }
    // A command inside a quoted word (sh -c '...' after xargs or find, "$(...)") is read too.
    if (depth >= MAX_DEPTH) continue;
    for (const w of segment) {
      if (!/[\s;&|`()]/.test(w.text)) continue;
      const why = check(w.text, posix, false, cwd, fence, depth + 1);
      if (why) return why;
    }
  }
  return null;
}

function refusalFor(name: string, args: Word[], cwd: string | null, fence: ShellFence, win: boolean, depth: number): string | null {
  if (name === 'git') {
    const git = gitParts(args, cwd, win);
    if (git.dynamic) return "HQ can't tell which git command that runs. Write the git command out plainly.";
    if (git.sub === 'push') return 'HQ refuses git push: nothing leaves this PC without the founder. Commit only if you were asked to, and say in your summary what is ready to push.';
    if (git.sub === 'clean') {
      // Without -x, git clean leaves ignored files alone: .env files and keys, as a project usually has them.
      const all = git.rest.some((w) => /^-[a-zA-Z]*[xX]/.test(w.text));
      return deleteCheck('git clean', { text: '.', dynamic: false, glob: false, redirect: false }, git.dir, fence, win, (rel) => {
        const parts = rel.split('/');
        const name = parts[parts.length - 1].toLowerCase();
        return !parts.includes('.git') && (all || !(name.startsWith('.env') || /\.(pem|key|pfx|p12|crt)$/.test(name)));
      });
    }
    if (git.sub === 'rm') return deleteAll('git rm', deleteTargets('rm', git.rest), git.dir, fence, win);
    return null;
  }
  if (name === 'xargs' && args.some((w) => DELETERS.has(programName(w.text)))) {
    return 'HQ refuses xargs with a delete: it cannot tell what would be deleted. Name each path plainly, inside your workspace or the project folder.';
  }
  if (name === 'find') {
    const deletes =
      args.some((w) => w.text === '-delete') ||
      args.some((w, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(w.text) && args[i + 1] && DELETERS.has(programName(args[i + 1].text)));
    if (!deletes) return null;
    const starts: Word[] = [];
    for (const w of args) {
      if (/^[-(!]/.test(w.text)) break;
      starts.push(w);
    }
    // One -name: only what it matches goes. Anything more involved could match anything.
    const names = args.flatMap((w, i) => ((w.text === '-name' || w.text === '-iname') && args[i + 1] ? [args[i + 1].text] : []));
    const re = names.length === 1 ? globToRegExp(names[0], win) : null;
    const inside = (rel: string) => !re || rel.split('/').some((part) => re.test(part));
    for (const w of starts.length ? starts : [{ text: '.', dynamic: false, glob: false, redirect: false }]) {
      const why = deleteCheck('find', w, cwd, fence, win, inside);
      if (why) return why;
    }
    return null;
  }
  if (DELETERS.has(name)) return deleteAll(name, deleteTargets(name, args), cwd, fence, win);
  if (depth >= MAX_DEPTH) return null;
  // A shell inside the command: read what it runs, as it would read it.
  if (POSIX_SHELLS.has(name)) {
    const at = args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
    return at !== -1 && args[at + 1] ? check(args[at + 1].text, true, true, cwd, fence, depth + 1) : null;
  }
  if (name === 'eval') return check(args.map((w) => w.text).join(' '), true, true, cwd, fence, depth + 1);
  if (name === 'powershell' || name === 'pwsh') {
    const flag = (w: Word) => w.text.toLowerCase();
    if (args.some((w) => ['-e', '-ec'].includes(flag(w)) || (flag(w).length >= 3 && 'encodedcommand'.startsWith(flag(w).slice(1))))) {
      return 'HQ refuses an encoded PowerShell command: it cannot read it. Write the command out plainly.';
    }
    // Its command follows -Command; powershell.exe also runs everything from the first word that is not an option. -File runs a script.
    let from = -1;
    for (let i = 0; i < args.length; i++) {
      const f = flag(args[i]);
      if (f === '-c' || (f.length >= 4 && 'command'.startsWith(f.slice(1)))) {
        from = i + 1;
        break;
      }
      if (f.startsWith('-f')) break;
      if (f.startsWith('-')) {
        if (PS_SHELL_VALUE.test(f)) i++;
        continue;
      }
      if (name === 'powershell') from = i;
      break;
    }
    return from === -1 ? null : check(args.slice(from).map((w) => w.text).join(' '), false, true, cwd, fence, depth + 1);
  }
  if (name === 'cmd') {
    // Git Bash turns /c into C:/, so cmd is started with //c there.
    const at = args.findIndex((w) => /^[\\/]{1,2}[ck]$/i.test(w.text));
    return at === -1 ? null : check(args.slice(at + 1).map((w) => w.text).join(' '), false, true, cwd, fence, depth + 1);
  }
  return null;
}

/** git's subcommand (dynamic: made from a variable or a command's output), the words after it, and the folder it works in (-C moves it). */
function gitParts(args: Word[], cwd: string | null, win: boolean): { sub: string | null; dynamic?: boolean; rest: Word[]; dir: string | null } {
  let dir = cwd;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '-C') {
      const to = args[++i];
      dir = !to || to.dynamic ? null : resolveText(to.text, dir, win);
      continue;
    }
    if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(t)) {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return { sub: t.toLowerCase(), ...(args[i].dynamic ? { dynamic: true } : {}), rest: args.slice(i + 1), dir };
  }
  return { sub: null, rest: [], dir };
}

/** The paths a delete names, past its options: rm's -rf, cmd's /s /q, PowerShell's -Recurse (and its -Path x). */
function deleteTargets(name: string, args: Word[]): Word[] {
  const out: Word[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (options && t === '--') {
      options = false;
      continue;
    }
    if (options && t.length > 1 && t.startsWith('-')) {
      const lower = t.toLowerCase();
      if ((lower === '-path' || lower === '-literalpath') && args[i + 1]) out.push(args[++i]);
      else if (PS_VALUE.has(lower)) i++;
      continue;
    }
    if (options && CMD_DELETERS.has(name) && /^\/[a-z](:.*)?$/i.test(t)) continue;
    out.push(args[i]);
  }
  return out;
}

function deleteAll(verb: string, targets: Word[], cwd: string | null, fence: ShellFence, win: boolean): string | null {
  for (const w of targets) {
    const why = deleteCheck(verb, w, cwd, fence, win);
    if (why) return why;
  }
  return null;
}

/** Why HQ refuses `verb` deleting what `w` names (everything under it that `inside` allows, when given), or null. */
function deleteCheck(verb: string, w: Word, cwd: string | null, fence: ShellFence, win: boolean, inside?: (rel: string) => boolean): string | null {
  const unclear = `HQ can't tell what ${verb} would delete with "${w.text}". Name each path plainly, with no variables, ~ or command output, inside your workspace or the project folder.`;
  const refused = (why: string | null) => (why ? `HQ refused ${verb} "${w.text}": ${why}` : null);
  if (w.dynamic) return unclear;
  if (!w.glob) {
    const target = resolveText(w.text, cwd, win);
    return target ? refused(fence.deleteRefusal(target, inside)) : unclear;
  }
  // A pattern: all it can match sits under the folder before its first wildcard.
  const parts = w.text.replace(/\\/g, '/').split('/');
  const wild = parts.findIndex((part) => /[*?[{]/.test(part));
  const rest = parts.slice(wild);
  if (rest.some((part) => part.startsWith('.'))) return `HQ refused ${verb} "${w.text}": a pattern that matches dot files could reach .git or .env files. Name those one by one.`;
  const target = resolveText(parts.slice(0, wild).join('/') || (w.text.startsWith('/') ? '/' : '.'), cwd, win);
  if (!target) return unclear;
  const re = globToRegExp(rest.join('/'), win);
  // Like bash, a pattern that does not start with a dot never matches a dot file.
  const matches = (rel: string) => {
    const segs = rel.split('/');
    for (let k = 1; k <= segs.length; k++) {
      if (segs[k - 1].startsWith('.')) return false;
      if (re.test(segs.slice(0, k).join('/'))) return true;
    }
    return false;
  };
  return refused(fence.deleteRefusal(target, (rel) => matches(rel) && (!inside || inside(rel))));
}

// ---------- HQ's Bash tool, for GPT desks ----------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_COMMAND = 20_000;
/** Bytes kept from each of stdout and stderr, and characters the desk gets back. */
const OUTPUT_KEEP = 1024 * 1024;
const REPLY_MAX = 30_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const BASH_TOOL_SPEC = {
  description: `Run a shell command in bash (Git Bash on Windows). Every command starts in your workspace folder; cd inside the command to work elsewhere. You get the exit code and the output. Nothing can be typed in, so use non-interactive flags. It stops after timeout milliseconds (default ${DEFAULT_TIMEOUT_MS / 1000} seconds, at most ${MAX_TIMEOUT_MS / 60_000} minutes).`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, description: `Milliseconds before it is stopped (default ${DEFAULT_TIMEOUT_MS})` },
      description: { type: 'string', description: 'What it does, in 5-10 plain words' },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

export interface BashToolContext {
  /** The desk's workspace: every command starts there. */
  dir: string;
  /** HQ's guard for this run: it refuses what shellRefusal refuses, and counts what runs. */
  guard: (toolName: string, input: Record<string, unknown>, opts?: { toolUseID?: string }) => Promise<{ behavior: string; message?: string }>;
  /** The run's signal: a command still running dies with the run. */
  signal?: AbortSignal;
}

/**
 * bash for desks' commands. Windows: Git Bash, the one Claude Code uses (CLAUDE_CODE_GIT_BASH_PATH, else the one
 * next to git), never WSL's bash in System32. Null when there is none. Exported for tests.
 */
export function bashPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return findProgram('bash', env, platform);
  const own = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (own) return findProgram(own, env, platform);
  const git = findProgram('git', env, platform);
  const near = git ? path.win32.dirname(git) : null;
  const candidates = [
    // Git for Windows puts git.exe in cmd\ (or bin\, or mingw64\bin\) and bash.exe in bin\.
    ...(near ? [path.win32.join(near, '..', 'bin', 'bash.exe'), path.win32.join(near, 'bash.exe'), path.win32.join(near, '..', '..', 'bin', 'bash.exe')] : []),
    path.win32.join(env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * HQ's environment for a GPT desk's commands, as Claude Code gives its Bash: all of it but the logins HQ runs on
 * (ANTHROPIC_*, CLAUDE_*, OPENAI_*, CODEX_*). Git never climbs out of a workspace into HQ's own repository. Exported for tests.
 */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = claudeEnv({}, base);
  for (const name of Object.keys(env)) if (/^(anthropic|claude|openai|codex)_/i.test(name)) delete env[name];
  return env;
}

/** What the desk gets back: the exit code, then stdout and stderr, cut in the middle when long. Exported for tests. */
export function bashReply(r: ProgramResult, timeoutMs: number, max = REPLY_MAX): ToolReply {
  const out = r.out.replace(ANSI, '').trimEnd();
  const err = r.err.replace(ANSI, '').trimEnd();
  const secs = Math.max(1, Math.round(timeoutMs / 1000));
  const head = r.timedOut
    ? `Stopped after ${secs} second${secs === 1 ? '' : 's'}: it took too long. Output before that is below.`
    : r.aborted
      ? 'Stopped: the run was stopped. Output before that is below.'
      : `Exit code ${r.code ?? 'unknown'}.`;
  const parts = [head];
  if (out) parts.push(`--- stdout ---\n${out}`);
  if (err) parts.push(`--- stderr ---\n${err}`);
  if (!out && !err) parts.push('(no output)');
  let text = parts.join('\n\n');
  if (text.length > max) {
    const keep = Math.floor((max - 60) / 2);
    text = `${text.slice(0, keep)}\n\n[... ${text.length - 2 * keep} characters cut ...]\n\n${text.slice(-keep)}`;
  } else if (r.truncated) text += '\n\n[More output came than HQ keeps.]';
  return { ok: r.code === 0 && !r.timedOut && !r.aborted, text };
}

/** Run one command for a GPT desk. Never throws: a problem comes back as a failed reply the model can read. */
export async function runBashTool(args: Record<string, unknown>, ctx: BashToolContext, callId: string): Promise<ToolReply> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) return { ok: false, text: 'Give a command to run.' };
  if (command.length > MAX_COMMAND) return { ok: false, text: `A command can be at most ${MAX_COMMAND} characters. Put a long script in a file in your workspace and run that.` };
  const timeout = args.timeout === undefined ? DEFAULT_TIMEOUT_MS : args.timeout;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    return { ok: false, text: `timeout must be a whole number of milliseconds from 1000 to ${MAX_TIMEOUT_MS}.` };
  }
  const d = await ctx.guard('Bash', { command }, { toolUseID: callId });
  if (d.behavior !== 'allow') return { ok: false, text: d.message ?? 'HQ refused that command.' };
  const bash = bashPath();
  if (!bash) return { ok: false, text: "HQ could not find bash. On Windows, install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH in HQ's .env to bash.exe's full path." };
  const r = await runProgram(bash, ['-c', command], { cwd: ctx.dir, env: shellEnv(), timeoutMs: timeout, cap: OUTPUT_KEEP, signal: ctx.signal });
  if (r.startError) return { ok: false, text: `HQ could not start bash (${bash}): ${r.startError}` };
  return bashReply(r, timeout);
}
