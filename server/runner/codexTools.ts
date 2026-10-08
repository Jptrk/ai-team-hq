import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/**
 * HQ's own file tools for GPT desks. Codex reads files with its shell, which desks don't get, so HQ hands GPT desks
 * these instead, named and shaped like Claude Code's (Read, Write, Edit, Glob, Grep). The desk's prompt and HQ's
 * guard (claude.ts) then work the same for both models: every call is checked against the desk's fence before it
 * touches the disk. Folders are walked without following links, so a search never leaves the folder the guard let it into.
 * Grep's regular expression runs in a worker thread with a time limit (HQ_GPT_GREP_MS), never on HQ's main thread.
 */

export type FileToolName = 'Read' | 'Write' | 'Edit' | 'Glob' | 'Grep';
export const READ_ONLY_TOOLS: FileToolName[] = ['Read', 'Glob', 'Grep'];
export const ALL_FILE_TOOLS: FileToolName[] = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];

/** What a tool answers: text, or an image Read opened. */
export interface ToolReply {
  ok: boolean;
  text: string;
  image?: { mime: string; base64: string };
}

/** The guard's answer, as the Agent SDK shapes it. */
type Decision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface FileToolContext {
  /** The run's working folder: the desk's workspace. Relative paths start here. */
  dir: string;
  /** HQ's guard for this run (see guard in claude.ts). */
  guard: (toolName: string, input: Record<string, unknown>, opts?: { toolUseID?: string }) => Promise<Decision | { behavior: string; message?: string }>;
  /** Project files a write was allowed to change, by call id; and the ones it did change. See keepWrites in claude.ts. */
  pendingWrites: Map<string, string[]>;
  changed: Set<string>;
}

const READ_LINES = 2000;
const LINE_CHARS = 2000;
const READ_BYTES = 10 * 1024 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const GLOB_RESULTS = 200;
const GREP_FILE_BYTES = 2 * 1024 * 1024;
const GREP_LINES = 300;
const GREP_FILES = 200;
/** Entries a search looks at, at most: a whole drive is not a project. */
const WALK_ENTRIES = 50_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
/** How long one Grep's matching may take. A pattern like ^(a+)+$ can take hours on one line; it is stopped instead. */
const GREP_MS = Number(process.env.HQ_GPT_GREP_MS) > 0 ? Number(process.env.HQ_GPT_GREP_MS) : 20_000;
let grepMs = GREP_MS;

/** Tests only: a shorter time for Grep's matching. Call with nothing to undo. */
export function setGrepBudgetForTests(ms?: number): void {
  grepMs = ms ?? GREP_MS;
}
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const pathProp = (what: string) => ({ type: 'string', description: `${what}. Absolute, or relative to your workspace.` });

/** Each tool's description and JSON Schema, for Codex's dynamic tools. */
export const FILE_TOOL_SPECS: Record<FileToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  Read: {
    description: `Read a file: text comes back with line numbers (up to ${READ_LINES} lines; use offset and limit for more), a PNG, JPEG, GIF or WebP image comes back as the picture.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: pathProp('The file'),
        offset: { type: 'integer', minimum: 1, description: 'First line to read, 1-based' },
        limit: { type: 'integer', minimum: 1, maximum: READ_LINES, description: 'How many lines' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  Write: {
    description: 'Create a file, or replace a whole file, with this content. Folders are made as needed. Prefer Edit to change part of a file.',
    inputSchema: {
      type: 'object',
      properties: { file_path: pathProp('The file'), content: { type: 'string', description: 'The whole new content' } },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  Edit: {
    description: 'Replace exact text in a file. old_string must appear exactly once (include enough surrounding lines), unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: pathProp('The file'),
        old_string: { type: 'string', description: 'The exact text to replace, whitespace included' },
        new_string: { type: 'string', description: 'What replaces it' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  Glob: {
    description: `Find files by name pattern, like "**/*.ts" or "src/**/index.*". Newest first, at most ${GLOB_RESULTS}. Skips .git and node_modules.`,
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern, relative to path' }, path: pathProp('Folder to search (default: your workspace)') },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  Grep: {
    description: 'Search file contents with a regular expression. Skips .git, node_modules, binary and very large files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (JavaScript syntax)' },
        path: pathProp('File or folder to search (default: your workspace)'),
        glob: { type: 'string', description: 'Only files matching this, like "*.ts" or "src/**/*.tsx"' },
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'files_with_matches (default), content (matching lines), or count' },
        '-i': { type: 'boolean', description: 'Ignore case' },
        '-C': { type: 'integer', minimum: 0, maximum: 10, description: 'Lines of context around each match (content mode)' },
        head_limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'At most this many results' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
};

const fail = (text: string): ToolReply => ({ ok: false, text });
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/** Run one file tool for a GPT desk. Never throws: a problem comes back as a failed reply the model can read. */
export async function runFileTool(name: FileToolName, args: Record<string, unknown>, ctx: FileToolContext, callId: string): Promise<ToolReply> {
  try {
    switch (name) {
      case 'Read':
        return await readTool(args, ctx);
      case 'Write':
        return await writeTool(args, ctx, callId);
      case 'Edit':
        return await editTool(args, ctx, callId);
      case 'Glob':
        return await globTool(args, ctx);
      case 'Grep':
        return await grepTool(args, ctx);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return fail('No such file or folder.');
    if (code === 'EACCES' || code === 'EPERM') return fail('Permission denied.');
    if (code === 'EISDIR') return fail('That is a folder. Use Glob to list it.');
    return fail(e instanceof Error ? e.message.slice(0, 300) : 'The tool failed.');
  }
}

async function allowed(ctx: FileToolContext, tool: FileToolName, input: Record<string, unknown>, callId?: string): Promise<string | null> {
  const d = await ctx.guard(tool, input, callId ? { toolUseID: callId } : undefined);
  return d.behavior === 'allow' ? null : ((d as { message?: string }).message ?? `${tool} is not allowed here.`);
}

/** A write the guard let through went through: its project files count as changed. A failed one never does. */
function settleWrite(ctx: FileToolContext, callId: string, ok: boolean): void {
  const files = ctx.pendingWrites.get(callId);
  ctx.pendingWrites.delete(callId);
  if (ok && files) for (const f of files) ctx.changed.add(f);
}

function resolveIn(ctx: FileToolContext, p: string): string {
  return path.resolve(ctx.dir, p);
}

async function readTool(args: Record<string, unknown>, ctx: FileToolContext): Promise<ToolReply> {
  const file = str(args.file_path);
  if (!file) return fail('file_path is required.');
  const why = await allowed(ctx, 'Read', { file_path: file });
  if (why) return fail(why);
  const abs = resolveIn(ctx, file);
  const st = await fs.promises.stat(abs);
  if (st.isDirectory()) return fail('That is a folder. Use Glob to list it.');
  const mime = IMAGES[path.extname(abs).toLowerCase()];
  if (mime) {
    if (st.size > IMAGE_BYTES) return fail(`That image is over ${IMAGE_BYTES / 1024 / 1024} MB.`);
    const base64 = (await fs.promises.readFile(abs)).toString('base64');
    return { ok: true, text: `Image ${abs} (${Math.round(st.size / 1024)} KB).`, image: { mime, base64 } };
  }
  if (st.size > READ_BYTES) return fail(`That file is over ${READ_BYTES / 1024 / 1024} MB. Use Grep to find the part you need.`);
  const buf = await fs.promises.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return fail('That is a binary file; it cannot be read as text.');
  const text = buf.toString('utf8');
  if (!text) return { ok: true, text: '(empty file)' };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const from = (int(args.offset, 1, Number.MAX_SAFE_INTEGER) ?? 1) - 1;
  const count = int(args.limit, 1, READ_LINES) ?? READ_LINES;
  if (from >= lines.length) return fail(`The file has ${lines.length} lines.`);
  const shown = lines.slice(from, from + count).map((l, i) => `${String(from + i + 1).padStart(6)}\t${l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l}`);
  const end = from + shown.length;
  const more = end < lines.length ? `\n(lines ${from + 1}-${end} of ${lines.length}; pass offset ${end + 1} to read on)` : '';
  return { ok: true, text: shown.join('\n') + more };
}

async function writeTool(args: Record<string, unknown>, ctx: FileToolContext, callId: string): Promise<ToolReply> {
  const file = str(args.file_path);
  const content = str(args.content);
  if (!file || content === undefined) return fail('file_path and content are required.');
  const why = await allowed(ctx, 'Write', { file_path: file }, callId);
  if (why) return fail(why);
  const abs = resolveIn(ctx, file);
  let ok = false;
  try {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, 'utf8');
    ok = true;
  } finally {
    settleWrite(ctx, callId, ok);
  }
  const lines = content ? content.split(/\r?\n/).length : 0;
  return { ok: true, text: `Wrote ${abs} (${lines} line${lines === 1 ? '' : 's'}).` };
}

function occurrences(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

async function editTool(args: Record<string, unknown>, ctx: FileToolContext, callId: string): Promise<ToolReply> {
  const file = str(args.file_path);
  let oldText = str(args.old_string);
  let newText = str(args.new_string);
  if (!file || oldText === undefined || newText === undefined) return fail('file_path, old_string and new_string are required.');
  if (!oldText) return fail('old_string is empty. Use Write to create a file.');
  if (oldText === newText) return fail('old_string and new_string are the same.');
  const why = await allowed(ctx, 'Edit', { file_path: file }, callId);
  if (why) return fail(why);
  const abs = resolveIn(ctx, file);
  let ok = false;
  try {
    const text = await fs.promises.readFile(abs, 'utf8');
    let n = occurrences(text, oldText);
    // A file with Windows line endings: the model writes \n.
    if (n === 0 && text.includes('\r\n') && oldText.includes('\n') && !oldText.includes('\r\n')) {
      oldText = oldText.replace(/\n/g, '\r\n');
      newText = newText.replace(/\r?\n/g, '\r\n');
      n = occurrences(text, oldText);
    }
    if (n === 0) return fail('old_string was not found in the file. Read the file and copy the text exactly.');
    if (n > 1 && args.replace_all !== true) return fail(`old_string appears ${n} times. Add surrounding lines to make it unique, or set replace_all.`);
    const next = args.replace_all === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText!);
    await fs.promises.writeFile(abs, next, 'utf8');
    ok = true;
    return { ok: true, text: `Edited ${abs} (${args.replace_all === true ? `${n} replacement${n === 1 ? '' : 's'}` : '1 replacement'}).` };
  } finally {
    settleWrite(ctx, callId, ok);
  }
}

/** A glob as a regular expression over a relative, /-separated path: **, *, ?, {a,b} and [abc]. Exported for tests. */
export function globToRegExp(glob: string, ignoreCase = process.platform === 'win32'): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" is any number of folders, "**" at the end is anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) re += '\\[';
      else {
        const body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
        re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else re += /[.+^$()|\\/]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

/** The folder part of a pattern before its first wildcard: "C:/x/src/**\/*.ts" is "C:/x/src". */
function splitPattern(pattern: string): { base: string | null; rest: string } {
  const parts = pattern.replace(/\\/g, '/').split('/');
  const wild = parts.findIndex((p) => /[*?{[]/.test(p));
  if (wild <= 0) return { base: null, rest: pattern.replace(/\\/g, '/') };
  return { base: parts.slice(0, wild).join('/') || '/', rest: parts.slice(wild).join('/') };
}

interface Entry {
  abs: string;
  rel: string;
}

/** Files under root, never following links, skipping .git and node_modules. Stops at WALK_ENTRIES. */
async function walk(root: string): Promise<{ files: Entry[]; cut: boolean }> {
  const files: Entry[] = [];
  const stack = [''];
  let seen = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_ENTRIES) return { files, cut: true };
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile()) files.push({ abs: path.join(root, childRel), rel: childRel });
    }
  }
  return { files, cut: false };
}

async function globTool(args: Record<string, unknown>, ctx: FileToolContext): Promise<ToolReply> {
  const pattern = str(args.pattern)?.trim();
  if (!pattern) return fail('pattern is required.');
  const given = str(args.path);
  const why = await allowed(ctx, 'Glob', { pattern, ...(given ? { path: given } : {}) });
  if (why) return fail(why);
  const split = path.isAbsolute(pattern) ? splitPattern(pattern) : { base: null, rest: pattern.replace(/\\/g, '/') };
  const root = split.base ? path.resolve(split.base) : resolveIn(ctx, given ?? '.');
  const st = await fs.promises.stat(root);
  if (!st.isDirectory()) return fail('path must be a folder.');
  const re = globToRegExp(split.rest);
  const { files, cut } = await walk(root);
  const hits = files.filter((f) => re.test(f.rel));
  const timed = await Promise.all(hits.map(async (f) => ({ abs: f.abs, mtime: (await fs.promises.stat(f.abs).catch(() => null))?.mtimeMs ?? 0 })));
  timed.sort((a, b) => b.mtime - a.mtime);
  if (!timed.length) return { ok: true, text: `No files match ${pattern}${cut ? ' (the folder was too big to search whole; narrow the path)' : ''}.` };
  const shown = timed.slice(0, GLOB_RESULTS).map((f) => f.abs);
  const notes = [timed.length > GLOB_RESULTS ? `(${timed.length - GLOB_RESULTS} more not shown; narrow the pattern)` : '', cut ? '(the folder was too big to search whole; narrow the path)' : ''].filter(Boolean);
  return { ok: true, text: [...shown, ...notes].join('\n') };
}

/** What Grep's worker gets: the files the walk found, and how to match and show them. */
interface GrepJob {
  files: string[];
  pattern: string;
  flags: string;
  mode: 'files_with_matches' | 'content' | 'count';
  context: number;
  limit: number;
  fileBytes: number;
  lineChars: number;
}

/**
 * Grep's matching, run in a worker thread (plain JavaScript, so it needs no TypeScript loader). The same lines the
 * tool always gave: a file path, path:count, or path:line:text with "-" for a context line.
 */
const GREP_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { files, pattern, flags, mode, context, limit, fileBytes, lineChars } = workerData;
const re = new RegExp(pattern, flags);
const out = [];
let results = 0;
for (const abs of files) {
  if (results >= limit) break;
  let buf;
  try {
    if (fs.statSync(abs).size > fileBytes) continue;
    buf = fs.readFileSync(abs);
  } catch {
    continue;
  }
  if (buf.subarray(0, 8000).includes(0)) continue;
  const lines = buf.toString('utf8').split(/\\r?\\n/);
  const matching = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) matching.push(i);
  if (!matching.length) continue;
  if (mode === 'files_with_matches') {
    out.push(abs);
    results++;
  } else if (mode === 'count') {
    out.push(abs + ':' + matching.length);
    results++;
  } else {
    const hits = new Set(matching);
    const show = new Set();
    for (const i of matching) for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) show.add(j);
    for (const i of [...show].sort((a, b) => a - b)) {
      if (results >= limit) break;
      const line = lines[i].length > lineChars ? lines[i].slice(0, lineChars) + '\\u2026' : lines[i];
      out.push(abs + ':' + (i + 1) + (hits.has(i) ? ':' : '-') + line);
      if (hits.has(i)) results++;
    }
  }
}
parentPort.postMessage({ out, results });
`;

/**
 * Run Grep's matching off HQ's main thread, within grepMs. A regular expression that backtracks without end (say
 * ^(a+)+$ on a long line) would otherwise stall every run, page and timer in HQ; past the time the worker is ended.
 * 'slow' when it ran out of time.
 */
function grepInWorker(job: GrepJob): Promise<{ out: string[]; results: number } | 'slow'> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER, { eval: true, workerData: job, execArgv: [] });
    let settled = false;
    const end = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      settle();
    };
    const timer = setTimeout(() => end(() => resolve('slow')), grepMs);
    worker.once('message', (m: { out: string[]; results: number }) => end(() => resolve(m)));
    worker.once('error', (e) => end(() => reject(e)));
    worker.once('exit', () => end(() => reject(new Error('The search stopped before it finished.'))));
  });
}

async function grepTool(args: Record<string, unknown>, ctx: FileToolContext): Promise<ToolReply> {
  const pattern = str(args.pattern);
  if (!pattern) return fail('pattern is required.');
  const given = str(args.path);
  const why = await allowed(ctx, 'Grep', { pattern, ...(given ? { path: given } : {}) });
  if (why) return fail(why);
  const flags = args['-i'] === true ? 'i' : '';
  try {
    new RegExp(pattern, flags);
  } catch {
    return fail('That is not a valid regular expression.');
  }
  const mode = args.output_mode === 'content' || args.output_mode === 'count' ? args.output_mode : 'files_with_matches';
  const context = int(args['-C'], 0, 10) ?? 0;
  const limit = int(args.head_limit, 1, 1000) ?? (mode === 'content' ? GREP_LINES : GREP_FILES);
  const root = resolveIn(ctx, given ?? '.');
  const st = await fs.promises.stat(root);
  let files: Entry[];
  let cut = false;
  if (st.isDirectory()) {
    const walked = await walk(root);
    files = walked.files;
    cut = walked.cut;
  } else files = [{ abs: root, rel: path.basename(root) }];
  const globText = str(args.glob)?.trim();
  if (globText) {
    const g = globToRegExp(globText.replace(/\\/g, '/'));
    const byName = !globText.includes('/');
    files = files.filter((f) => g.test(byName ? path.basename(f.rel) : f.rel));
  }

  const found = files.length
    ? await grepInWorker({ files: files.map((f) => f.abs), pattern, flags, mode, context, limit, fileBytes: GREP_FILE_BYTES, lineChars: LINE_CHARS })
    : { out: [], results: 0 };
  if (found === 'slow') return fail('That search took too long; simplify the pattern or narrow the path.');
  const { out, results } = found;
  if (!out.length) return { ok: true, text: `No matches${cut ? ' (the folder was too big to search whole; narrow the path)' : ''}.` };
  if (results >= limit) out.push(`(stopped at ${limit} results; narrow the search or raise head_limit)`);
  if (cut) out.push('(the folder was too big to search whole; narrow the path)');
  return { ok: true, text: out.join('\n') };
}
