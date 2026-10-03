import type { SkillCandidate, SkillSource } from '../../../shared/types';

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

/** A fresh token for one fetch, 24 hex characters, so Cancel can stop it before the server answers. */
export function newFetchToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}
