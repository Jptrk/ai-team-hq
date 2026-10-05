import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectSkillsResponse, SkillCandidate, SkillMeta, SkillPick, SkillPreview, SkillSource } from '../shared/types';
import { scrub } from './mcpCli';
import { isInside, SKILL_ID, slug } from './paths';
import { findProgram, runProgram } from './proc';
import { allProjects, now, type Project } from './store';

/**
 * Skills: one library for all of HQ, turned on per desk in each project.
 *
 *   data/skills/skills.json          the library: every installed skill
 *   data/skills/lib/<id>/            an installed copy of one skill's folder
 *   data/skills/.staging/<token>/    a repo fetched for you to pick from; gone after install or cancel,
 *                                    on start, and once it is 30 minutes old
 *   data/skills/.no-hooks/           an empty folder: the only place git may look for hooks
 *
 * A skill is a folder with a SKILL.md (frontmatter with name and description, then instructions) and
 * maybe scripts, data and templates. HQ fetches a GitHub repo with git, lists every SKILL.md in it, and
 * copies the ones you pick. Only regular files are copied: never links, .git or node_modules.
 * HQ doesn't use the SDK's own skill loader: a desk's system prompt lists its skills and it reads them.
 */

const SKILLS_DIR = path.resolve(process.cwd(), 'data', 'skills');
const REGISTRY_FILE = path.join(SKILLS_DIR, 'skills.json');
/** Installed skills, one folder each. */
export const SKILLS_LIB = path.join(SKILLS_DIR, 'lib');
const STAGING_DIR = path.join(SKILLS_DIR, '.staging');
const HOOKS_DIR = path.join(SKILLS_DIR, '.no-hooks');

const STAGING_MAX_MS = 30 * 60_000;
/** Fetched repos waiting for a pick at once. A new fetch drops the oldest. */
const MAX_STAGED = 3;
const GIT_TIMEOUT_MS = 90_000;
/** How often a running fetch's folder is measured, so a huge repo stops early. */
const FETCH_POLL_MS = 3_000;
/** How long a new fetch waits for one you cancelled to stop. */
const CANCEL_WAIT_MS = 5_000;
const MAX_SKILLS_PER_REPO = 50;
const MAX_DEPTH = 20;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
/** Renaming a folder Windows still holds a file in: this many tries, this far apart. */
const RENAME_TRIES = 4;
const RENAME_WAIT_MS = 150;

/** Sizes HQ refuses: a whole fetched repo, and one skill's folder. */
export interface SkillLimits {
  cloneFiles: number;
  cloneBytes: number;
  skillFiles: number;
  skillBytes: number;
}
const DEFAULT_LIMITS: SkillLimits = { cloneFiles: 5000, cloneBytes: 150 * 1024 * 1024, skillFiles: 2000, skillBytes: 25 * 1024 * 1024 };
let limits: SkillLimits = DEFAULT_LIMITS;

/** Folders never walked or copied. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules']);
const NO_SKIP: ReadonlySet<string> = new Set();
/** Scripts a desk may run, by extension. */
const SCRIPT_KIND: Record<string, 'python' | 'node'> = { '.py': 'python', '.js': 'node', '.cjs': 'node', '.mjs': 'node' };
/** Folders of a skill's tests and tooling: nothing in them is one of its scripts. */
const NOT_SCRIPT_DIRS: ReadonlySet<string> = new Set(['test', 'tests', '__tests__', 'spec', 'fixtures', '__pycache__', '.venv', 'venv', 'node_modules']);
/** Test files by name: test_x.py, x_test.py, conftest.py, x.test.js, x.spec.mjs. */
const TEST_FILE = /^(test_.*\.py|.*_test\.py|conftest\.py|.*\.(test|spec)\..*)$/i;
const TOKEN = /^[0-9a-f]{24}$/;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A failure with the HTTP status the route should answer with, and a sentence that is safe to show. */
export class SkillError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------- GitHub links ----------

export interface GithubSource {
  /** owner/repo */
  repo: string;
  ref?: string;
  /** A folder inside the repo, with / between parts. */
  path?: string;
}

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_PART = /^[A-Za-z0-9_.-]{1,200}$/;
// Characters Windows refuses in file names, plus control characters.
const BAD_PATH_CHAR = /[\u0000-\u001f\u007f<>:"|?*\\]/;

/**
 * A GitHub link, strictly checked: https only, github.com, no user name or token, owner/repo of plain
 * characters, then optionally /tree/<branch or tag>/<folder> (or /blob/... to a file, which means its folder).
 * A branch with a / in its name can't be told apart from a folder, so the first part after tree is the branch.
 * Returns the source, or a sentence saying what is wrong.
 */
export function parseGithubUrl(raw: unknown): GithubSource | string {
  if (typeof raw !== 'string' || !raw.trim()) return 'Paste a GitHub link.';
  const text = raw.trim();
  if (text.length > 2000) return 'That link is too long.';
  if (/[\s\u0000-\u001f\u007f\\]/.test(text)) return "That doesn't look like a GitHub link.";
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return 'Use the full link, like https://github.com/owner/repo.';
  }
  if (u.protocol !== 'https:') return 'Use an https:// link to github.com.';
  if (u.username || u.password) return 'Leave any user name or token out of the link.';
  const host = u.hostname.toLowerCase();
  if ((host !== 'github.com' && host !== 'www.github.com') || u.port) return 'Only github.com links work.';

  const parts: string[] = [];
  for (const piece of u.pathname.split('/')) {
    if (!piece) continue;
    let part: string;
    try {
      part = decodeURIComponent(piece);
    } catch {
      return "That doesn't look like a GitHub link.";
    }
    if (part === '.' || part === '..' || part.includes('/') || BAD_PATH_CHAR.test(part) || part.length > 255) return 'That link has a folder name HQ can not use.';
    parts.push(part);
  }
  const [owner, repoPart, kind, ref, ...rest] = parts;
  if (!owner || !repoPart) return 'Link to a repo, like https://github.com/owner/repo.';
  const dotGit = /\.git$/i.test(repoPart);
  const repo = dotGit ? repoPart.slice(0, -4) : repoPart;
  for (const name of [owner, repo]) {
    if (!NAME_PART.test(name) || name === '.' || name === '..') return 'That owner or repo name is not valid.';
  }
  const full = `${owner}/${repo}`;
  if (parts.length === 2) return { repo: full };
  if (dotGit || (kind !== 'tree' && kind !== 'blob')) return 'Link to the repo, or to a folder in it (…/tree/main/folder).';
  if (!ref) return { repo: full };
  if (!REF_PART.test(ref) || ref.startsWith('-') || ref.startsWith('.') || ref.includes('..') || ref.endsWith('.lock')) return 'That branch or tag name is not valid.';
  // A link to a file means its folder: a link to a SKILL.md is that skill.
  const folder = kind === 'blob' ? rest.slice(0, -1) : rest;
  const sub = folder.join('/');
  if (sub.length > 1000) return 'That link is too long.';
  return { repo: full, ref, ...(sub ? { path: sub } : {}) };
}

// ---------- SKILL.md ----------

/** One scalar from a simple YAML block: plain, quoted, or a | or > block. */
function scalar(first: string, more: string[]): string {
  const value = first.trim();
  const block = /^[|>][+-]?[0-9]?[+-]?(\s+#.*)?$/.exec(value);
  if (block) {
    const lines = [...more];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
    const body = lines.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : ''));
    if (value.startsWith('|')) return body.join('\n').trim();
    // Folded: lines of a paragraph join with spaces, a blank line starts a new one.
    const out: string[] = [];
    let para: string[] = [];
    for (const line of body) {
      if (line.trim()) para.push(line.trim());
      else if (para.length) {
        out.push(para.join(' '));
        para = [];
      }
    }
    if (para.length) out.push(para.join(' '));
    return out.join('\n').trim();
  }
  const joined = [value, ...more.map((l) => l.trim())].filter(Boolean).join(' ');
  if (value.startsWith('"')) {
    let out = '';
    for (let i = 1; i < joined.length; i++) {
      const c = joined[i];
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = joined[++i];
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(joined.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(joined.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (e !== undefined) out += e;
    }
    return out;
  }
  if (value.startsWith("'")) {
    let out = '';
    for (let i = 1; i < joined.length; i++) {
      if (joined[i] !== "'") out += joined[i];
      else if (joined[i + 1] === "'") {
        out += "'";
        i++;
      } else return out;
    }
    return out;
  }
  // A nested map or a list is not a string.
  if (!value && more.some((l) => /^\s+(-\s|[A-Za-z0-9_-]+:(\s|$))/.test(l))) return '';
  // Plain: a " #" starts a comment. Found with one linear search: a /\s+#.*$/ backtracks for ages on a long run of spaces.
  const comment = joined.search(/\s#/);
  return (comment === -1 ? joined : joined.slice(0, comment)).trim();
}

/** The frontmatter keys at the top level of a SKILL.md (a simple YAML subset), and the markdown after it. Exported for tests. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const s = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!s.startsWith('---\n')) return { data: {}, body: s };
  const end = /\n(---|\.\.\.)[ \t]*(\n|$)/.exec(s.slice(3));
  if (!end) return { data: {}, body: s };
  const head = s.slice(4, 3 + end.index);
  const body = s.slice(3 + end.index + end[0].length);
  const data: Record<string, string> = {};
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const more: string[] = [];
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || /^[ \t]/.test(lines[j]))) more.push(lines[j++]);
    i = j - 1;
    data[m[1]] = scalar(m[2] ?? '', more);
  }
  return { data, body };
}

/** The first paragraph of plain text in markdown: no headings, code, lists of links or HTML. */
function firstParagraph(body: string): string {
  const lines: string[] = [];
  let fence = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!line) {
      if (lines.length) break;
      continue;
    }
    if (/^(#|<|!\[|\||---|===)/.test(line)) {
      if (lines.length) break;
      continue;
    }
    lines.push(line);
  }
  return lines.join(' ');
}

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A skill's name and description from its SKILL.md, falling back to the folder name and the first paragraph. Exported for tests. */
export function skillInfo(text: string, folderName: string): { name: string; description: string } {
  const { data, body } = parseFrontmatter(text);
  const name = clip(oneLine(data.name ?? ''), MAX_NAME) || clip(oneLine(folderName), MAX_NAME) || 'skill';
  const description = clip(oneLine(data.description ?? '') || oneLine(firstParagraph(body)), MAX_DESCRIPTION);
  return { name, description };
}

// ---------- files ----------

interface FileEntry {
  /** Relative to the folder, with / between parts. */
  rel: string;
  abs: string;
  size: number;
}

/**
 * Regular files under `root`, never through a link (Windows junctions count as links) and never into
 * a skipped folder. Stops once past the limits, with `over` set. Exported for tests.
 */
export function listFiles(root: string, max: { files: number; bytes: number }, skip: ReadonlySet<string> = SKIP_DIRS): { files: FileEntry[]; bytes: number; over: boolean } {
  const files: FileEntry[] = [];
  let bytes = 0;
  const walk = (dir: string, rel: string): boolean => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return true;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        if (skip.has(name.toLowerCase())) continue;
        if (!walk(abs, r)) return false;
        continue;
      }
      if (!st.isFile()) continue;
      files.push({ rel: r, abs, size: st.size });
      bytes += st.size;
      if (files.length > max.files || bytes > max.bytes) return false;
    }
    return true;
  };
  const ok = walk(root, '');
  return { files, bytes, over: !ok };
}

/** `rel` appears in the text as a path of its own, not as the end of a longer name like my-search.py. */
function mentions(text: string, rel: string): boolean {
  for (let i = text.indexOf(rel); i !== -1; i = text.indexOf(rel, i + 1)) {
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + rel.length] ?? '';
    if (!/[A-Za-z0-9_.-]/.test(before) && !/[A-Za-z0-9_/-]/.test(after)) return true;
  }
  return false;
}

/**
 * The scripts a desk may run, from a skill's files (relative, with / between parts): Python and Node files in
 * its top-level scripts/ folder, or named in its SKILL.md. Never tests, fixtures, caches or a virtual
 * environment, so front-end code under templates/ and a scripts/tests/test_core.py never run. Exported for tests.
 */
export function runnableScripts(rels: readonly string[], skillMd: string): string[] {
  const text = skillMd.replace(/\\/g, '/');
  return rels.filter((rel) => {
    if (!SCRIPT_KIND[path.posix.extname(rel).toLowerCase()]) return false;
    const parts = rel.split('/');
    if (parts.slice(0, -1).some((dir) => NOT_SCRIPT_DIRS.has(dir.toLowerCase()))) return false;
    if (TEST_FILE.test(parts[parts.length - 1])) return false;
    return (parts.length > 1 && parts[0].toLowerCase() === 'scripts') || mentions(text, rel);
  });
}

/** A skill folder's SKILL.md (any case), or '' when there is none. Only its start: script names are in the docs, not after 256 KB. */
function skillMdIn(dir: string, files?: readonly FileEntry[]): string {
  const entry = files?.find((f) => f.rel.toLowerCase() === 'skill.md');
  let file = entry?.abs;
  if (!file && !files) {
    try {
      const name = fs.readdirSync(dir).find((n) => n.toLowerCase() === 'skill.md');
      file = name ? path.join(dir, name) : undefined;
    } catch {
      /* no folder */
    }
  }
  try {
    return file ? readStart(file, 256 * 1024) : '';
  } catch {
    return '';
  }
}

const scriptsIn = (dir: string, files: FileEntry[]) => runnableScripts(files.map((f) => f.rel), skillMdIn(dir, files));

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** A real folder inside `root` (no link on the way), or null. `rel` uses / between parts. */
function folderIn(root: string, rel: string): string | null {
  const abs = path.resolve(root, ...rel.split('/').filter(Boolean));
  if (!isInside(abs, root)) return null;
  // Every step must be a real folder, not a link to somewhere else.
  let at = path.resolve(root);
  for (const part of path.relative(root, abs).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    try {
      const st = fs.lstatSync(at);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return abs;
}

// ---------- the library ----------

interface Registry {
  version: 1;
  skills: SkillMeta[];
}

let registry: Registry | null = null;
/** The library is the real one: skills.json was read as it is, or HQ wrote it. Missing or unreadable, it is empty for now, and desks must not lose skills over that. */
let registryTrusted = false;

/** One saved entry with every field in shape, or null. A hand edit with a bad id must never turn into a path outside lib/. */
function entryOf(raw: unknown): SkillMeta | null {
  const s = raw as Partial<SkillMeta> | null;
  if (!s || typeof s.id !== 'string' || !SKILL_ID.test(s.id)) return null;
  const src = (s.source ?? {}) as Partial<SkillSource>;
  return {
    id: s.id,
    name: typeof s.name === 'string' && s.name ? s.name : s.id,
    description: typeof s.description === 'string' ? s.description : '',
    source: {
      repo: typeof src.repo === 'string' ? src.repo : '',
      ...(typeof src.ref === 'string' ? { ref: src.ref } : {}),
      path: typeof src.path === 'string' ? src.path : '',
      ...(typeof src.commit === 'string' ? { commit: src.commit } : {}),
    },
    installedAt: typeof s.installedAt === 'string' ? s.installedAt : new Date(0).toISOString(),
    files: Number(s.files) || 0,
    bytes: Number(s.bytes) || 0,
    scripts: Array.isArray(s.scripts) ? s.scripts.filter((x): x is string => typeof x === 'string') : [],
    scriptsAllowed: s.scriptsAllowed === true,
  };
}

function reg(): Registry {
  if (registry) return registry;
  let skills: SkillMeta[] = [];
  if (fs.existsSync(REGISTRY_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Partial<Registry>;
      skills = (Array.isArray(parsed.skills) ? parsed.skills : []).map(entryOf).filter((s): s is SkillMeta => s !== null);
      // Installed before HQ left tests and front-end code out: the same rule applies now. It only ever narrows the list.
      for (const s of skills) s.scripts = runnableScripts(s.scripts, skillMdIn(path.join(SKILLS_LIB, s.id)));
      registryTrusted = true;
    } catch (e) {
      // Keep the unreadable file for you to look at, rather than overwrite it with an empty library.
      const keep = `${REGISTRY_FILE}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(REGISTRY_FILE, keep);
      } catch {
        /* leave it */
      }
      console.warn(`[hq] skills: could not read skills.json (${e instanceof Error ? e.message : 'error'}). Kept it as ${path.basename(keep)}; the library starts empty.`);
    }
  }
  registry = { version: 1, skills };
  return registry;
}

function saveRegistry(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  // Written beside it, then swapped in, so a crash mid-write never leaves half a library.
  const tmp = `${REGISTRY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg(), null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
  registryTrusted = true;
}

/** Every installed skill, by name. */
export function listLibrary(): SkillMeta[] {
  return [...reg().skills].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : 1));
}

export function getSkill(id: string): SkillMeta | undefined {
  return reg().skills.find((s) => s.id === id);
}

/** An installed skill's folder. Only ever inside data/skills/lib. */
export function skillDir(id: string): string {
  if (!SKILL_ID.test(id)) throw new SkillError('That is not a skill id.', 400);
  return path.join(SKILLS_LIB, id);
}

const sameSource = (s: SkillSource, repo: string, folder: string) => s.repo.toLowerCase() === repo.toLowerCase() && s.path === folder;

// Windows can't make folders with these names.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function baseId(name: string, folderName: string): string {
  const id = slug(name) || slug(folderName) || 'skill';
  return RESERVED.test(id) ? `${id}-skill` : id;
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
  return id;
}

// ---------- finding skills ----------

/** Same SKILL.md (line endings and a BOM aside) and the same other files at the same sizes: the same skill, copied. */
function fingerprint(skillMd: string, files: readonly FileEntry[]): string {
  const hash = createHash('sha256');
  hash.update((skillMd.charCodeAt(0) === 0xfeff ? skillMd.slice(1) : skillMd).replace(/\r\n?/g, '\n').trim());
  const others = files.filter((f) => f.rel.toLowerCase() !== 'skill.md').map((f) => `${f.rel}\u0000${f.size}`);
  for (const line of others.sort()) hash.update(`\u0001${line}`);
  return hash.digest('hex');
}

/** Which copy of a skill to keep: one under .claude/skills/, then under a top-level skills/, then the shallowest. */
function keepRank(rel: string): [number, number, string] {
  const where = `/${rel}/`.includes('/.claude/skills/') ? 0 : rel.startsWith('skills/') ? 1 : 2;
  return [where, rel.split('/').filter(Boolean).length, rel];
}

function rankBefore(a: string, b: string): boolean {
  const [x, y] = [keepRank(a), keepRank(b)];
  return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2];
}

/**
 * Every SKILL.md under `root` (or under its folder `onlyPath`), case-insensitively, never through a link
 * and never inside .git or node_modules. With `repo`, a skill from the same folder of the same repo, or one
 * whose id is taken, counts as already installed. A skill that is a copy of another one in the repo (same
 * SKILL.md and files) is marked duplicateOf the copy worth keeping. `truncated` says HQ stopped looking:
 * at 50 skills or 20 folders deep.
 */
export function discoverSkills(root: string, onlyPath?: string, repo?: string): { skills: SkillCandidate[]; truncated: boolean } {
  const start = onlyPath ? folderIn(root, onlyPath) : path.resolve(root);
  if (!start) throw new SkillError(`There is no folder ${onlyPath} in that repo.`, 404);
  const found: { dir: string; file: string }[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_SKILLS_PER_REPO) {
      truncated = true;
      return;
    }
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    const stats = names.map((name) => {
      try {
        return { name, st: fs.lstatSync(path.join(dir, name)) };
      } catch {
        return null;
      }
    });
    const skillFile = stats.find((e) => e && e.st.isFile() && e.name.toLowerCase() === 'skill.md');
    if (skillFile) found.push({ dir, file: path.join(dir, skillFile.name) });
    for (const e of stats) {
      if (!e || e.st.isSymbolicLink() || !e.st.isDirectory() || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(start, 0);

  const lib = reg().skills;
  const seen = found.map(({ dir, file }) => {
    const rel = path.relative(path.resolve(root), dir).split(path.sep).filter(Boolean).join('/');
    // The repo's own root is named after the repo, not HQ's staging folder.
    const folderName = rel ? path.basename(dir) : (repo?.split('/')[1] ?? path.basename(dir));
    const text = readStart(file, 1024 * 1024);
    const listing = listFiles(dir, { files: limits.skillFiles, bytes: limits.skillBytes });
    return { rel, folderName, text, listing, print: fingerprint(text, listing.files) };
  });
  // One copy of each skill is worth keeping; the others say which one they copy.
  const keeper = new Map<string, string>();
  for (const s of seen) {
    const kept = keeper.get(s.print);
    if (kept === undefined || rankBefore(s.rel, kept)) keeper.set(s.print, s.rel);
  }
  // The copies worth keeping take the plain ids first.
  const order = [...seen].sort((a, b) => Number(keeper.get(a.print) !== a.rel) - Number(keeper.get(b.print) !== b.rel));
  const taken = new Set(lib.map((s) => s.id));
  const byPath = new Map<string, SkillCandidate>();
  for (const { rel, folderName, text, listing, print } of order) {
    const { name, description } = skillInfo(text, folderName);
    const same = repo ? lib.find((s) => sameSource(s.source, repo, rel)) : undefined;
    const base = baseId(name, folderName);
    const id = same?.id ?? uniqueId(base, taken);
    taken.add(id);
    const kept = keeper.get(print)!;
    byPath.set(rel, {
      path: rel,
      name,
      description,
      id,
      files: listing.files.length,
      bytes: listing.bytes,
      scripts: runnableScripts(listing.files.map((f) => f.rel), text),
      alreadyInstalled: Boolean(same) || lib.some((s) => s.id === base),
      ...(same ? { replaces: same.id } : {}),
      ...(kept !== rel ? { duplicateOf: kept } : {}),
      ...(listing.over ? { problem: `Too big: over ${limits.skillFiles} files or ${mb(limits.skillBytes)}.` } : {}),
    });
  }
  return { skills: seen.map((s) => byPath.get(s.rel)!), truncated };
}

/** The start of a file: a SKILL.md's frontmatter and first paragraph are near the top. */
function readStart(file: string, max = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- fetching ----------

/**
 * Puts a copy of the repo at `dest` and says which commit it is. Aborting `signal` (Cancel, or a repo that
 * grew too big) must stop it soon. Tests pass one that copies a local folder.
 */
export type SkillFetcher = (src: { repo: string; ref?: string }, dest: string, signal?: AbortSignal) => Promise<{ commit?: string }>;

// ---------- programs ----------

/** Full paths HQ found for git and Python, by the name asked for. Only hits are kept, so installing one later works without a restart. */
const programs = new Map<string, string>();

/** A program's full path, looked up once (see findProgram: never the working folder), or null. */
function programPath(name: string): string | null {
  const hit = programs.get(name);
  if (hit) return hit;
  const found = findProgram(name);
  if (found) programs.set(name, found);
  return found;
}

/** The git HQ fetches with, as HQ_GIT names it: a full path, or a name looked up in PATH. git by default. */
export function gitName(): string {
  return process.env.HQ_GIT?.trim() || 'git';
}

export function gitProgram(): string | null {
  return programPath(gitName());
}

/** The Python HQ runs skill scripts with, as HQ_PYTHON names it, else python on Windows (there is no python3 there), python3 elsewhere. */
export function pythonName(): string {
  return process.env.HQ_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
}

/** Its full path, or null when there is none (or HQ_PYTHON is a relative path). */
export function pythonProgram(): string | null {
  return programPath(pythonName());
}

// ---------- git ----------

/** The oldest Git HQ fetches with. 2.45.1 fixed clones a hostile repo could use to run code (CVE-2024-32002 and others); 2.45.2 fixed what that broke. */
export const MIN_GIT_VERSION = '2.45.2';

/** The version in `git --version`'s line, as printed ("2.32.0.windows.2") and as numbers ([2, 32, 0]). Null when it isn't one. Exported for tests. */
export function parseGitVersion(printed: string): { text: string; parts: [number, number, number] } | null {
  const m = /\bgit version ((\d+)\.(\d+)(?:\.(\d+))?\S*)/i.exec(printed);
  return m ? { text: m[1], parts: [Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] } : null;
}

/** `version` is `min` or newer, part by part. Exported for tests. */
export function versionAtLeast(version: readonly number[], min: string): boolean {
  const want = min.split('.').map(Number);
  for (let i = 0; i < want.length; i++) {
    const have = version[i] ?? 0;
    if (have !== want[i]) return have > want[i];
  }
  return true;
}

/**
 * HQ's environment for git, without any of git's own variables HQ was started with (GIT_DIR, GIT_WORK_TREE,
 * GIT_CONFIG_*, GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH ...): they could point the clone somewhere else or add
 * settings. Then HQ's: never ask for a login (a private repo fails at once instead of waiting on a prompt
 * nobody sees), no LFS downloads, and no looking for a repo above `ceiling`. Exported for tests.
 */
export function gitEnv(ceiling: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) if (!/^git_/i.test(name)) env[name] = value;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    // Only https is allowed (see gitSafety), but a user config that rewrites links to ssh must never wait on a passphrase either.
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CEILING_DIRECTORIES: ceiling,
  };
}

/**
 * Settings for every git command HQ runs on a fetched repo, given before the command so they hold for all of
 * it: no sign-in helper, no links (a checked-out link can point anywhere), hooks only from an empty folder,
 * no file-system monitor program, and https as the only way to fetch (no ssh, git://, file:// or ext::).
 */
function gitSafety(hooksDir: string): string[] {
  return [
    '-c',
    'credential.helper=',
    '-c',
    'core.symlinks=false',
    '-c',
    'core.longpaths=true',
    '-c',
    `core.hooksPath=${hooksDir.split(path.sep).join('/')}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
  ];
}

/** git's arguments for a fetch: the settings above, then a shallow clone of one branch, no tags, no submodules, -- before the https link. Pure, for tests. */
export function cloneArgs(src: { repo: string; ref?: string }, dest: string, hooksDir: string): string[] {
  return [
    ...gitSafety(hooksDir),
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    ...(src.ref ? ['--branch', src.ref] : []),
    '--',
    `https://github.com/${src.repo}.git`,
    dest,
  ];
}

/** data/skills/.no-hooks, empty: anything in it is cleared first. */
function emptyHooksDir(): string {
  try {
    if (fs.readdirSync(HOOKS_DIR).length) removeTree(HOOKS_DIR);
  } catch {
    /* not there yet */
  }
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  return HOOKS_DIR;
}

/** Git versions already checked, by path. */
const gitChecked = new Set<string>();

/** Refuse a Git too old to clone an untrusted repo safely. Run once per git, outside any repo. */
async function checkGitVersion(git: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (gitChecked.has(git)) return;
  const r = await runProgram(git, ['--version'], { cwd, env, timeoutMs: 15_000, cap: 4096, signal });
  if (r.aborted) throw new SkillError('The fetch was cancelled.', 410);
  if (r.startError) throw new SkillError('HQ needs Git to fetch skills and could not start it. Install Git (git-scm.com), then try again.', 501);
  const version = parseGitVersion(r.out);
  if (!version) throw new SkillError(`HQ could not tell which version of Git it has. Install Git ${MIN_GIT_VERSION} or newer from git-scm.com.`, 501);
  if (!versionAtLeast(version.parts, MIN_GIT_VERSION)) {
    throw new SkillError(`Git ${version.text} is too old to fetch skills safely; install Git ${MIN_GIT_VERSION} or newer from git-scm.com.`, 501);
  }
  gitChecked.add(git);
}

/** What git printed, as a sentence. Never the command line. */
function gitMessage(src: { repo: string; ref?: string }, printed: string): string {
  const text = scrub(printed, [], 400);
  if (/transport '?[\w+-]+'? not allowed/i.test(text)) {
    return 'Your Git settings rewrite GitHub links to another protocol (url.insteadOf). HQ only fetches skills over https.';
  }
  if (src.ref && /remote branch .* not found|not found in upstream/i.test(text)) return `${src.repo} has no branch or tag "${src.ref}".`;
  if (/not found|could not read username|terminal prompts disabled|authentication failed|returned error: 40[134]/i.test(text)) {
    return `HQ could not fetch ${src.repo}. Check the link. Private repos don't work: HQ fetches without signing in.`;
  }
  if (/could not resolve host|unable to access|failed to connect|timed out/i.test(text)) return 'HQ could not reach GitHub. Check the internet connection and try again.';
  const last = text.split(/\r?\n/).filter(Boolean).pop();
  return `Git could not fetch ${src.repo}${last ? `: ${last}` : '.'}`;
}

/**
 * A shallow clone of one branch with git found by full path, Git 2.45.2 or newer only (see cloneArgs and
 * gitSafety). No shell, and never run inside the fetched repo: always from the staging folder around it.
 */
export const gitFetcher: SkillFetcher = async (src, dest, signal) => {
  const git = gitProgram();
  if (!git) throw new SkillError(`HQ needs Git to fetch skills and could not find it${process.env.HQ_GIT?.trim() ? ' at HQ_GIT' : ''}. Install Git (git-scm.com), then try again.`, 501);
  const cwd = path.dirname(dest);
  const env = gitEnv(cwd);
  await checkGitVersion(git, cwd, env, signal);
  const hooks = emptyHooksDir();
  const r = await runProgram(git, cloneArgs(src, dest, hooks), { cwd, env, timeoutMs: GIT_TIMEOUT_MS, cap: 64 * 1024, signal });
  if (r.aborted) throw new SkillError('The fetch was cancelled.', 410);
  if (r.startError) throw new SkillError('HQ needs Git to fetch skills and could not start it. Install Git (git-scm.com), then try again.', 501);
  if (r.timedOut) throw new SkillError(`GitHub did not finish sending ${src.repo} within ${GIT_TIMEOUT_MS / 1000} seconds. Try again, or link a smaller repo.`, 504);
  if (r.code !== 0) throw new SkillError(gitMessage(src, r.err || r.out), 502);
  const head = await runProgram(git, [...gitSafety(hooks), '-C', dest, 'rev-parse', 'HEAD'], { cwd, env, timeoutMs: 15_000, cap: 4096, signal });
  const commit = head.out.trim();
  return /^[0-9a-f]{40}$/.test(commit) ? { commit } : {};
};

let fetcher: SkillFetcher = gitFetcher;
let fetchPollMs = FETCH_POLL_MS;
let rename: (from: string, to: string) => void = fs.renameSync;

/**
 * Tests swap the fetcher (no network, no git), the size limits, how often a fetch is measured, and the folder
 * rename (to act out a file Windows holds open). Called with nothing, all go back.
 */
export function setSkillTestHooks(hooks: { fetcher?: SkillFetcher; limits?: Partial<SkillLimits>; pollMs?: number; rename?: (from: string, to: string) => void } = {}): void {
  fetcher = hooks.fetcher ?? gitFetcher;
  limits = { ...DEFAULT_LIMITS, ...(hooks.limits ?? {}) };
  fetchPollMs = hooks.pollMs ?? FETCH_POLL_MS;
  rename = hooks.rename ?? fs.renameSync;
}

// ---------- staging ----------

interface Staged {
  dir: string;
  /** The fetched repo. */
  root: string;
  repo: string;
  ref?: string;
  commit?: string;
  createdAt: number;
  skills: SkillCandidate[];
}

const staged = new Map<string, Staged>();

/** Delete a folder HQ made. Links inside it go first, as links, so deleting never reaches through one. Throws when it can't. */
function removeTree(dir: string): void {
  const unlinkLinks = (at: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(at, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          fs.unlinkSync(abs);
        } catch {
          // A Windows junction to a folder goes with rmdir, which removes the link and never its target.
          fs.rmdirSync(abs);
        }
      } else if (st.isDirectory()) unlinkLinks(abs);
    }
  };
  if (!fs.existsSync(dir)) return;
  unlinkLinks(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function removeDir(dir: string): void {
  try {
    removeTree(dir);
  } catch (e) {
    console.warn(`[hq] skills: could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Drop fetched repos older than 30 minutes, also ones an earlier run of HQ left behind, and old copies a
 * reinstall or a remove could not delete at the time (.old-, .del-).
 */
export function sweepStaging(nowMs = Date.now()): void {
  const cutoff = nowMs - STAGING_MAX_MS;
  for (const [token, st] of staged) {
    if (st.createdAt >= cutoff) continue;
    staged.delete(token);
    removeDir(st.dir);
  }
  // Not while installing: a reinstall is moving folders right now.
  if (!busy) {
    try {
      for (const name of fs.readdirSync(SKILLS_LIB)) if (/^\.(old|del)-/.test(name)) removeDir(path.join(SKILLS_LIB, name));
    } catch {
      /* no library yet */
    }
  }
  let names: string[];
  try {
    names = fs.readdirSync(STAGING_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (staged.has(name) || fetching?.token === name) continue;
    const dir = path.join(STAGING_DIR, name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) removeDir(dir);
    } catch {
      /* gone already */
    }
  }
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * On start: no fetched repo survives a restart, nor a copy an install left half-done. Projects forget skills
 * the library no longer has (only when the library was read as it is). Then sweep now and then.
 */
export function initSkills(): void {
  staged.clear();
  removeDir(STAGING_DIR);
  try {
    // Names starting with a dot are HQ's own half-finished copies; skill ids never start with one.
    for (const name of fs.readdirSync(SKILLS_LIB)) if (name.startsWith('.')) removeDir(path.join(SKILLS_LIB, name));
  } catch {
    /* no library yet */
  }
  const ids = new Set(reg().skills.map((s) => s.id));
  if (registryTrusted) {
    for (const p of allProjects()) {
      const gone = Object.keys(p.state.skillDesks ?? {}).filter((id) => !ids.has(id));
      if (!gone.length) continue;
      for (const id of gone) delete p.state.skillDesks[id];
      p.commit();
    }
  }
  if (!sweeper) {
    sweeper = setInterval(() => sweepStaging(), 5 * 60_000);
    sweeper.unref();
  }
}

// One fetch or install at a time.
let busy: 'preview' | 'install' | null = null;
/** Settles when the fetch or install running now ends. */
let idle: Promise<void> = Promise.resolve();
/** The fetch running now, so Cancel can stop it. */
let fetching: { token: string; controller: AbortController } | null = null;

async function locked<T>(what: 'preview' | 'install', fn: () => Promise<T>): Promise<T> {
  // A fetch you cancelled is on its way out (its git is being killed): wait a moment for it rather than refuse.
  if (busy === 'preview' && fetching?.controller.signal.aborted) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([idle, new Promise<void>((resolve) => (timer = setTimeout(resolve, CANCEL_WAIT_MS)))]);
    clearTimeout(timer);
  }
  if (busy) throw new SkillError(busy === 'preview' ? 'HQ is still fetching another link. Wait for it to finish.' : 'An install is still running. Wait for it to finish.', 409);
  busy = what;
  let done!: () => void;
  idle = new Promise<void>((resolve) => (done = resolve));
  try {
    return await fn();
  } finally {
    busy = null;
    done();
  }
}

/**
 * Fetch a GitHub link into a staging folder and list the skills in it. Installs nothing. `requested` is a
 * token the page made up, so it can cancel the fetch before the answer comes; HQ makes one otherwise.
 * While git runs, the folder is measured every few seconds, and a repo far past the size limit is stopped.
 */
export async function previewSkills(url: unknown, requested?: unknown): Promise<SkillPreview> {
  const src = parseGithubUrl(url);
  if (typeof src === 'string') throw new SkillError(src, 400);
  if (requested !== undefined && (typeof requested !== 'string' || !TOKEN.test(requested))) throw new SkillError('That fetch id is not valid.', 400);
  return locked('preview', async () => {
    sweepStaging();
    const token = (requested as string | undefined) ?? randomBytes(12).toString('hex');
    if (staged.has(token)) throw new SkillError('That fetch id is in use. Try again.', 409);
    // A few fetched repos wait at once, at most: the oldest goes to make room.
    while (staged.size >= MAX_STAGED) {
      const [oldest, st] = staged.entries().next().value as [string, Staged];
      staged.delete(oldest);
      removeDir(st.dir);
    }
    const dir = path.join(STAGING_DIR, token);
    const root = path.join(dir, 'repo');
    fs.mkdirSync(dir, { recursive: true });
    const controller = new AbortController();
    fetching = { token, controller };
    // The fetched repo plus git's own copy of it: twice the limit is far past what could pass the check after.
    let tooBig = false;
    const poll = setInterval(() => {
      if (!listFiles(root, { files: limits.cloneFiles + 1000, bytes: limits.cloneBytes * 2 }, NO_SKIP).over) return;
      tooBig = true;
      controller.abort();
    }, fetchPollMs);
    const tooBigError = () => new SkillError(`${src.repo} is too big for HQ: over ${limits.cloneFiles} files or ${mb(limits.cloneBytes)}.`, 413);
    try {
      let commit: string | undefined;
      try {
        ({ commit } = await fetcher({ repo: src.repo, ref: src.ref }, root, controller.signal));
      } finally {
        clearInterval(poll);
        fetching = null;
      }
      if (controller.signal.aborted) throw new SkillError('The fetch was cancelled.', 410);
      const size = listFiles(root, { files: limits.cloneFiles, bytes: limits.cloneBytes }, new Set(['.git']));
      if (size.over) throw tooBigError();
      const { skills, truncated } = discoverSkills(root, src.path, src.repo);
      if (!skills.length) throw new SkillError(src.path ? `There is no SKILL.md in ${src.path} of ${src.repo}.` : `There is no SKILL.md in ${src.repo}.`, 404);
      staged.set(token, { dir, root, repo: src.repo, ref: src.ref, commit, createdAt: Date.now(), skills });
      console.log(`[hq] skills: found ${skills.length} in ${src.repo}${src.ref ? ` (${src.ref})` : ''}${truncated ? ', and stopped looking' : ''}`);
      return { token, repo: src.repo, ...(src.ref ? { ref: src.ref } : {}), ...(commit ? { commit } : {}), skills, ...(truncated ? { truncated } : {}) };
    } catch (e) {
      removeDir(dir);
      // A stopped fetch fails its own way; say why it was stopped instead.
      if (tooBig) throw tooBigError();
      if (controller.signal.aborted) throw new SkillError('The fetch was cancelled.', 410);
      throw e;
    }
  });
}

/** Stop a fetch that is still running, or throw away a fetched repo you decided not to install from. */
export function cancelPreview(token: string): void {
  if (fetching?.token === token) fetching.controller.abort();
  const st = staged.get(token);
  if (!st) return;
  staged.delete(token);
  removeDir(st.dir);
}

function parsePicks(raw: unknown): SkillPick[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new SkillError('Pick at least one skill.', 400);
  if (raw.length > MAX_SKILLS_PER_REPO) throw new SkillError('That is too many skills at once.', 400);
  const picks: SkillPick[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || typeof p.path !== 'string' || p.path.length > 1000 || typeof p.allowScripts !== 'boolean') throw new SkillError('Each pick needs a path and allowScripts.', 400);
    if (picks.some((x) => x.path === p.path)) throw new SkillError('A skill was picked twice.', 400);
    picks.push({ path: p.path, allowScripts: p.allowScripts });
  }
  return picks;
}

/** Rename a folder, trying a few times: Windows refuses while anything (a virus scan, a desk reading a file) holds a file inside. */
async function renameRetry(from: string, to: string): Promise<boolean> {
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return true;
    } catch {
      if (i >= RENAME_TRIES) return false;
      await delay(RENAME_WAIT_MS);
    }
  }
}

/**
 * Copy one skill's regular files into lib/<id>, replacing what was there. Returns what landed. The new copy is
 * made beside it, then the installed folder moves aside whole and the new one takes its place. When the
 * installed folder can't move, it stays exactly as it was: a reinstall never leaves half a skill.
 */
async function copySkill(from: string, id: string): Promise<{ files: number; bytes: number; scripts: string[] }> {
  const listing = listFiles(from, { files: limits.skillFiles, bytes: limits.skillBytes });
  if (listing.over) throw new SkillError(`That skill is too big: over ${limits.skillFiles} files or ${mb(limits.skillBytes)}.`, 413);
  const dest = skillDir(id);
  const tag = randomBytes(4).toString('hex');
  const tmp = path.join(SKILLS_LIB, `.new-${id}-${tag}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of listing.files) {
      const to = path.join(tmp, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.abs, to);
    }
  } catch {
    removeDir(tmp);
    throw new SkillError(`HQ could not copy ${id}'s files.`, 500);
  }
  const inUse = new SkillError(`HQ could not replace ${id}: one of its files is in use. Try again in a moment.`, 409);
  const old = path.join(SKILLS_LIB, `.old-${id}-${tag}`);
  const had = fs.existsSync(dest);
  if (had && !(await renameRetry(dest, old))) {
    removeDir(tmp);
    throw inUse;
  }
  if (!(await renameRetry(tmp, dest))) {
    // Put the installed copy back where it was.
    if (had && !(await renameRetry(old, dest))) console.warn(`[hq] skills: could not put ${id} back after a failed reinstall. Reinstall it.`);
    removeDir(tmp);
    throw inUse;
  }
  if (had) removeDir(old);
  return { files: listing.files.length, bytes: listing.bytes, scripts: scriptsIn(from, listing.files) };
}

/** No "type" here, so a skill's .js scripts run as plain Node scripts, not as part of HQ's own package. */
function ensureLibPackage(): void {
  const file = path.join(SKILLS_LIB, 'package.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ private: true, description: 'Skills installed in AI Team HQ. Managed by HQ.' }, null, 2)}\n`);
}

/**
 * Install the skills you picked from a fetched repo. A skill from the same folder of the same repo replaces
 * its earlier install and keeps its id, so the desks that have it keep it; scriptsAllowed takes your new choice.
 */
export async function installSkills(token: unknown, rawPicks: unknown): Promise<SkillMeta[]> {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new SkillError('Find the skills first.', 400);
  const picks = parsePicks(rawPicks);
  return locked('install', async () => {
    sweepStaging();
    const st = staged.get(token);
    if (!st) throw new SkillError('That list expired. Find the skills again.', 410);
    const chosen = picks.map((pick) => ({ pick, cand: st.skills.find((c) => c.path === pick.path) }));
    for (const { cand } of chosen) {
      if (!cand) throw new SkillError('Pick skills from the list.', 400);
      if (cand.problem) throw new SkillError(`${cand.name}: ${cand.problem}`, 413);
    }
    fs.mkdirSync(SKILLS_LIB, { recursive: true });
    ensureLibPackage();
    const r = reg();
    const taken = new Set(r.skills.map((s) => s.id));
    const done: SkillMeta[] = [];
    for (const { pick, cand } of chosen as { pick: SkillPick; cand: SkillCandidate }[]) {
      const from = folderIn(st.root, cand.path);
      if (!from) throw new SkillError(`${cand.name}'s folder is gone. Find the skills again.`, 410);
      const existing = r.skills.find((s) => sameSource(s.source, st.repo, cand.path));
      const id = existing?.id ?? uniqueId(baseId(cand.name, cand.path ? path.basename(from) : st.repo.split('/')[1]), taken);
      taken.add(id);
      const copied = await copySkill(from, id);
      // A new skill starts on no desk: an entry some project still has for its id (a hand edit, a remove that stopped halfway) must not carry over.
      if (!existing) clearDesks(id);
      const meta: SkillMeta = {
        id,
        name: cand.name,
        description: cand.description,
        source: { repo: st.repo, ...(st.ref ? { ref: st.ref } : {}), path: cand.path, ...(st.commit ? { commit: st.commit } : {}) },
        installedAt: now(),
        files: copied.files,
        bytes: copied.bytes,
        scripts: copied.scripts,
        scriptsAllowed: pick.allowScripts && copied.scripts.length > 0,
      };
      r.skills = [...r.skills.filter((s) => s.id !== id), meta];
      // Saved after each one, so a later failure never loses the folders already copied.
      saveRegistry();
      done.push(meta);
    }
    staged.delete(token);
    removeDir(st.dir);
    const allowed = done.filter((s) => s.scriptsAllowed).map((s) => s.id);
    console.log(`[hq] skills: installed ${done.map((s) => s.id).join(', ')} from ${st.repo}${st.commit ? `@${st.commit.slice(0, 7)}` : ''}${allowed.length ? `; scripts allowed for ${allowed.join(', ')}` : ''}`);
    return listLibrary();
  });
}

/** Take a skill id off every project's desks, quietly. */
function clearDesks(id: string): void {
  for (const p of allProjects()) {
    if (!p.state.skillDesks?.[id]) continue;
    delete p.state.skillDesks[id];
    p.commit();
  }
}

/**
 * Delete a skill from HQ: its files, its library entry, and its place on every project's desks. Its folder
 * first moves aside whole (.del-<id>-<tag>), so a file in use leaves it installed as it was; deleting the
 * moved folder can fail without harm, since the next sweep or restart clears it.
 */
export function removeSkill(id: string): SkillMeta[] {
  if (busy) throw new SkillError('HQ is fetching or installing skills. Wait for it to finish.', 409);
  const r = reg();
  const skill = r.skills.find((s) => s.id === id);
  if (!skill) throw new SkillError('That skill is not installed. Reload the page.', 404);
  const dir = skillDir(id);
  if (!isInside(dir, SKILLS_LIB) || path.resolve(dir) === path.resolve(SKILLS_LIB)) throw new SkillError('That is not a skill folder.', 400);
  const aside = path.join(SKILLS_LIB, `.del-${id}-${randomBytes(4).toString('hex')}`);
  if (fs.existsSync(dir)) {
    try {
      rename(dir, aside);
    } catch {
      throw new SkillError(`HQ could not delete ${skill.name}'s files: one of them is in use. Try again in a moment.`, 409);
    }
  }
  r.skills = r.skills.filter((s) => s.id !== id);
  saveRegistry();
  for (const p of allProjects()) {
    if (!p.state.skillDesks?.[id]) continue;
    delete p.state.skillDesks[id];
    p.log('you', `Removed the skill ${skill.name} from HQ, so no desk here has it any more`);
    p.commit();
  }
  removeDir(aside);
  console.log(`[hq] skills: removed ${id}`);
  return listLibrary();
}

/** Allow or stop a skill's scripts, for every project. */
export function setScriptsAllowed(id: string, on: boolean): SkillMeta[] {
  const skill = reg().skills.find((s) => s.id === id);
  if (!skill) throw new SkillError('That skill is not installed. Reload the page.', 404);
  if (on && !skill.scripts.length) throw new SkillError(`${skill.name} has no scripts.`, 400);
  if (skill.scriptsAllowed !== on) {
    skill.scriptsAllowed = on;
    saveRegistry();
    console.log(`[hq] skills: scripts ${on ? 'allowed' : 'no longer allowed'} for ${id}`);
  }
  return listLibrary();
}

// ---------- per project ----------

/** Turn a skill on for these desks in one project. Unknown ids and the founder drop out; none at all turns it off here. Returns the desks saved. */
export function setSkillDesks(p: Project, id: string, desks: string[]): string[] {
  const skill = getSkill(id);
  if (!skill) throw new SkillError('That skill is not installed. Reload the page.', 404);
  const s = p.state;
  s.skillDesks ??= {};
  const picked = s.agents.filter((a) => !a.isHuman && desks.includes(a.id));
  const before = s.skillDesks[id] ?? [];
  const after = picked.map((a) => a.id);
  if (after.length) s.skillDesks[id] = after;
  else delete s.skillDesks[id];
  if (before.join(',') !== after.join(',')) {
    p.log('you', after.length ? `Skill ${skill.name} on for ${picked.map((a) => a.name).join(', ')}` : `Skill ${skill.name} turned off for every desk`);
  }
  p.commit();
  return after;
}

/**
 * Give several skills to some desks, or take them off, in one project at once: "All desks" on a skill, or a whole
 * repo's skills. Each skill keeps its other desks, so a page showing older desks can't undo someone else's change.
 * A desk in both lists comes off. Unknown ids and the founder drop out. Any unknown skill changes nothing.
 * Returns the skills that changed.
 */
export function changeSkillDesks(p: Project, ids: string[], add: string[], remove: string[]): string[] {
  const skills: SkillMeta[] = [];
  for (const id of new Set(ids)) {
    const skill = getSkill(id);
    if (!skill) throw new SkillError('That skill is not installed. Reload the page.', 404);
    skills.push(skill);
  }
  const s = p.state;
  s.skillDesks ??= {};
  const adding = new Set(add);
  const dropping = new Set(remove);
  const desks = s.agents.filter((a) => !a.isHuman);
  const changed: SkillMeta[] = [];
  for (const skill of skills) {
    const before = s.skillDesks[skill.id] ?? [];
    const after = desks.filter((a) => !dropping.has(a.id) && (adding.has(a.id) || before.includes(a.id))).map((a) => a.id);
    if (before.join(',') === after.join(',')) continue;
    if (after.length) s.skillDesks[skill.id] = after;
    else delete s.skillDesks[skill.id];
    changed.push(skill);
  }
  if (!changed.length) return [];
  const repos = new Set(changed.map((k) => k.source.repo.toLowerCase()));
  const what =
    changed.length === 1
      ? `Skill ${changed[0].name}`
      : changed.length <= 3
        ? `Skills ${changed.map((k) => k.name).join(', ')}`
        : `${changed.length} skills${repos.size === 1 ? ` from ${changed[0].source.repo}` : ''}`;
  const who = (picked: Set<string>) => {
    const list = desks.filter((a) => picked.has(a.id));
    return list.length > 1 && list.length === desks.length ? 'every desk' : list.map((a) => a.name).join(', ');
  };
  const on = who(new Set(add.filter((d) => !dropping.has(d))));
  const off = who(dropping);
  p.log('you', `${what} ${[on && `on for ${on}`, off && `off for ${off}`].filter(Boolean).join(', ')}`);
  p.commit();
  return changed.map((k) => k.id);
}

/** The Skills page for one project. */
export function projectSkills(p: Project): ProjectSkillsResponse {
  const library = listLibrary();
  const desks: Record<string, string[]> = {};
  for (const s of library) {
    const on = p.state.skillDesks?.[s.id];
    if (on?.length) desks[s.id] = [...on];
  }
  return { library, desks };
}

/** The installed skills turned on for this desk in this project, by id, so a prompt built from them stays the same. */
export function skillsForDesk(p: Project, agentId: string): SkillMeta[] {
  return reg()
    .skills.filter((s) => p.state.skillDesks?.[s.id]?.includes(agentId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- scripts ----------

/**
 * The program and arguments for one of a skill's scripts, or why it can't run. The script must be one the
 * skill lists, a path inside its folder (no absolute path, no .., and no link out of it), and Python or Node.
 * The program is a full path: Node is HQ's own, Python is looked up in PATH (never the desk's folder).
 * `rel` is the script's path inside the skill, as listed.
 */
export function resolveSkillScript(skill: SkillMeta, script: unknown): { cmd: string; args: string[]; rel: string } | { error: string } {
  if (typeof script !== 'string' || !script.trim()) return { error: 'Name the script, like "scripts/search.py".' };
  if (script.length > 400 || script.includes('\0')) return { error: 'That script path is not valid.' };
  const raw = script.trim().replace(/\\/g, '/');
  if (path.isAbsolute(script.trim()) || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { error: 'Give the path inside the skill folder, like "scripts/search.py", not a full path.' };
  }
  if (raw.split('/').includes('..')) return { error: 'The script must be inside the skill folder.' };
  const rel = path.posix.normalize(raw).replace(/^\.\//, '');
  const kind = SCRIPT_KIND[path.posix.extname(rel).toLowerCase()];
  if (!kind) return { error: 'Only Python (.py) and Node (.js, .cjs, .mjs) scripts can run.' };
  if (!skill.scripts.includes(rel)) {
    const list = skill.scripts.slice(0, 20).join(', ');
    return { error: `${rel} is not one of ${skill.name}'s scripts.${list ? ` Its scripts: ${list}${skill.scripts.length > 20 ? ', …' : ''}.` : ''}` };
  }
  const dir = skillDir(skill.id);
  const abs = path.join(dir, ...rel.split('/'));
  if (!isInside(abs, dir)) return { error: 'The script must be inside the skill folder.' };
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
    if (!isInside(real, fs.realpathSync.native(dir))) return { error: 'The script must be inside the skill folder.' };
    if (!fs.statSync(real).isFile()) return { error: `${rel} is not a file.` };
  } catch {
    return { error: `${rel} is missing from ${skill.name}'s folder. Reinstall the skill.` };
  }
  const cmd = kind === 'python' ? pythonProgram() : process.execPath;
  if (!cmd) return { error: `HQ could not find Python (${pythonName()}). Install Python 3, or set HQ_PYTHON in HQ's .env to its full path.` };
  return { cmd, args: [real], rel };
}
