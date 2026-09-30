import fs from 'node:fs';
import path from 'node:path';
import type { PathCheck, ProjectMeta } from '../shared/types';

/** The HQ app's own folder. Agents may never write into it outside their workspace. */
export const HQ_ROOT = path.resolve(process.cwd());

/** Strip the quotes Windows "Copy as path" adds, plus stray whitespace. */
export function cleanPath(raw: string): string {
  return raw.trim().replace(/^["']+|["']+$/g, '').trim();
}

/** True when `child` is `root` or lives under it. Case-insensitive on Windows via path.relative. */
export function isInside(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** Jira-style key from a name: initials for multi-word names, first letters otherwise. */
export function suggestKey(name: string, taken: string[]): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let key = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 4);
  key = key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  if (key.length < 2) key = `${key}PR`.slice(0, 3);
  const used = new Set(taken.map((k) => k.toUpperCase()));
  if (!used.has(key)) return key;
  for (let n = 2; n < 100; n++) {
    const next = `${key.slice(0, 8)}${n}`;
    if (!used.has(next)) return next;
  }
  return key;
}

/** Root-level instruction file agents should read: CLAUDE.md first, then AGENTS.md. */
export function instructionsFileIn(dir: string): string | null {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

export function folderExists(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function checkFolder(raw: string, projects: ProjectMeta[], exceptId?: string): PathCheck {
  const cleaned = cleanPath(raw);
  const empty: PathCheck = {
    ok: false,
    path: cleaned,
    exists: false,
    isDir: false,
    isGit: false,
    instructionsFile: null,
    hasReadme: false,
    suggestedName: '',
    suggestedKey: '',
  };
  if (!cleaned) return { ...empty, error: 'Paste a folder path' };
  if (!path.isAbsolute(cleaned)) return { ...empty, error: 'Use a full path, like C:\\Users\\you\\project' };
  const abs = path.resolve(cleaned);
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    return { ...empty, path: abs, error: 'Folder not found' };
  }
  if (!isDir) return { ...empty, path: abs, exists: true, error: 'That is a file, not a folder' };
  if (isInside(abs, HQ_ROOT)) return { ...empty, path: abs, exists: true, isDir: true, error: 'That folder is inside AI Team HQ itself' };

  const name = path.basename(abs) || abs;
  const others = projects.filter((p) => p.id !== exceptId);
  const inUse = others.find((p) => p.path && samePath(p.path, abs));
  return {
    ok: true,
    path: abs,
    exists: true,
    isDir: true,
    isGit: fs.existsSync(path.join(abs, '.git')),
    instructionsFile: instructionsFileIn(abs),
    hasReadme: fs.existsSync(path.join(abs, 'README.md')),
    suggestedName: name,
    suggestedKey: suggestKey(name, others.map((p) => p.key)),
    inUseBy: inUse?.name,
  };
}
