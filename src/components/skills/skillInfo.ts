import type { SkillCandidate, SkillMeta, SkillSource } from '../../../shared/types';

/** Pure helpers for the Skills page and the install dialog. Tested in src/ui.test.ts. */

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The repo on GitHub, or null for anything that is not plainly owner/repo. */
export function repoUrl(repo: string): string | null {
  return REPO.test(repo) ? `https://github.com/${repo}` : null;
}

/** The skill's folder on GitHub, at the commit it was installed from when HQ knows it. */
export function folderUrl(source: SkillSource): string | null {
  const base = repoUrl(source.repo);
  if (!base) return null;
  const at = source.commit ?? source.ref;
  if (!source.path) return at ? `${base}/tree/${encodeURIComponent(at)}` : base;
  return `${base}/tree/${encodeURIComponent(at ?? 'HEAD')}/${source.path.split('/').map(encodeURIComponent).join('/')}`;
}

/** "owner/repo", plus the folder inside it. */
export function sourceLabel(source: SkillSource): string {
  return source.path ? `${source.repo}/${source.path}` : source.repo;
}

/**
 * Ticked when the install dialog opens: a skill that can be installed and is the one to keep. A copy of
 * another skill in the repo, or one whose name another installed skill holds, waits for you to tick it.
 */
export function pickedAtFirst(s: Pick<SkillCandidate, 'problem' | 'duplicateOf' | 'alreadyInstalled' | 'replaces'>): boolean {
  // duplicateOf is '' for a copy of the skill at the repo's root.
  return !s.problem && s.duplicateOf === undefined && !(s.alreadyInstalled && !s.replaces);
}

/** Skills that came from one GitHub repo, shown together on the Skills page. */
export interface SkillGroup {
  /** owner/repo, lowercased: GitHub names don't care about case. */
  key: string;
  repo: string;
  skills: SkillMeta[];
}

/** The library grouped by the repo each skill came from: groups by repo name, skills by name. */
export function groupByRepo(skills: readonly SkillMeta[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const s of skills) {
    const key = s.source.repo.toLowerCase();
    const g = groups.get(key) ?? { key, repo: s.source.repo, skills: [] };
    g.skills.push(s);
    groups.set(key, g);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  for (const g of groups.values()) g.skills.sort((a, b) => byName(a.name, b.name) || byName(a.id, b.id));
  return [...groups.values()].sort((a, b) => byName(repoParts(a.repo).name, repoParts(b.repo).name) || byName(a.repo, b.repo));
}

/** "ui-ux-pro-max-skill" and "nextlevelbuilder" from "nextlevelbuilder/ui-ux-pro-max-skill". */
export function repoParts(repo: string): { owner: string; name: string } {
  const cut = repo.indexOf('/');
  return cut < 0 ? { owner: '', name: repo } : { owner: repo.slice(0, cut), name: repo.slice(cut + 1) };
}

/** The open repo groups saved in this browser, or null when none were saved or the value is unreadable. */
export function parseOpenGroups(raw: string | null): ReadonlySet<string> | null {
  if (!raw) return null;
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? new Set(list.filter((k): k is string => typeof k === 'string')) : null;
  } catch {
    return null;
  }
}

/** The groups that are open: the saved ones that still exist, or with nothing saved a lone group. */
export function openKeys(stored: ReadonlySet<string> | null, keys: readonly string[]): Set<string> {
  if (!stored) return new Set(keys.length === 1 ? keys : []);
  return new Set(keys.filter((k) => stored.has(k)));
}

/** The open groups after opening or closing one, kept to groups that exist. */
export function withOpen(stored: ReadonlySet<string> | null, keys: readonly string[], key: string, open: boolean): Set<string> {
  const next = openKeys(stored, keys);
  if (open) next.add(key);
  else next.delete(key);
  return next;
}

/** A fresh token for one fetch, 24 hex characters, so Cancel can stop it before the server answers. */
export function newFetchToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}
