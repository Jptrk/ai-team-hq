import { useEffect, useRef, useState } from 'react';
import type { SkillCandidate, SkillMeta, SkillPreview } from '../../../shared/types';
import { api } from '../../api';
import { Modal } from '../../shell/Modal';
import { Lozenge } from '../../ui/Lozenge';
import { newFetchToken, pickedAtFirst, plural, repoUrl, sizeLabel } from './skillInfo';

interface Props {
  open: boolean;
  onClose: () => void;
  /** After an install: the whole library, and how many were installed. */
  /** `repo` is the owner/repo the skills came from. */
  onInstalled: (library: SkillMeta[], count: number, repo: string) => void;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Install skills: paste a GitHub link, HQ fetches it and lists every SKILL.md in it, you pick which to
 * install and whether each one's scripts may run. Leaving without installing throws the fetched copy away,
 * and leaving while it is still fetching stops the fetch. Copies of a skill found elsewhere in the repo sit
 * under "duplicates", unticked. Remounted after every close, so it always starts at the link.
 */
export function InstallSkillModal({ open, onClose, onInstalled }: Props) {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [allow, setAllow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'find' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The fetch on the server, running or fetched, until it is installed or thrown away. Set before the fetch starts, so Cancel can stop it.
  const token = useRef<string | null>(null);
  const closed = useRef(!open);
  // A second click before the first one's answer would only be refused.
  const sending = useRef(false);

  const discard = () => {
    const t = token.current;
    token.current = null;
    if (t) void api.cancelSkillPreview(t).catch(() => undefined);
  };

  useEffect(() => {
    closed.current = !open;
    if (!open) discard();
  }, [open]);
  useEffect(
    () => () => {
      closed.current = true;
      discard();
    },
    [],
  );

  // An install that is under way finishes first: closing then would hide whether it worked.
  const close = () => {
    if (busy !== 'install') onClose();
  };

  const find = async () => {
    if (sending.current) return;
    const link = url.trim();
    if (!link) {
      setError('Paste a GitHub link.');
      return;
    }
    sending.current = true;
    setBusy('find');
    setError(null);
    discard();
    const t = newFetchToken();
    token.current = t;
    try {
      const res = await api.previewSkills(link, t);
      // Closed while it was fetching: nobody will pick from it.
      if (closed.current) {
        void api.cancelSkillPreview(res.token).catch(() => undefined);
        return;
      }
      token.current = res.token;
      setPreview(res);
      setPicked(Object.fromEntries(res.skills.map((s) => [s.path, pickedAtFirst(s)])));
      setAllow({});
    } catch (e) {
      // Nothing waits on the server after a failed fetch.
      if (token.current === t) token.current = null;
      if (!closed.current) setError(msg(e, 'Could not fetch that link'));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const chosen = preview ? preview.skills.filter((s) => picked[s.path] && !s.problem) : [];

  const install = async () => {
    if (!preview || !chosen.length || sending.current) return;
    sending.current = true;
    setBusy('install');
    setError(null);
    try {
      const library = await api.installSkills(
        preview.token,
        chosen.map((s) => ({ path: s.path, allowScripts: Boolean(allow[s.path]) && s.scripts.length > 0 })),
      );
      // Installed: the server already threw the fetched copy away.
      token.current = null;
      onInstalled(library, chosen.length, preview.repo);
    } catch (e) {
      setError(msg(e, 'Could not install those skills'));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const back = () => {
    discard();
    setPreview(null);
    setError(null);
  };

  const footer = (
    <>
      {preview && (
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={back}>
          Back
        </button>
      )}
      <span className="grow" />
      <button type="button" className="btn btn-ghost" disabled={busy === 'install'} onClick={close}>
        Cancel
      </button>
      {preview ? (
        <button type="button" className="btn btn-primary" disabled={busy !== null || chosen.length === 0} onClick={() => void install()}>
          {busy === 'install' ? 'Installing...' : `Install ${plural(chosen.length, 'skill')}`}
        </button>
      ) : (
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void find()}>
          {busy === 'find' ? 'Fetching...' : 'Find skills'}
        </button>
      )}
    </>
  );

  const repoLink = preview ? repoUrl(preview.repo) : null;
  // duplicateOf is '' for a copy of the skill at the repo's root.
  const main = preview ? preview.skills.filter((s) => s.duplicateOf === undefined) : [];
  const dupes = preview ? preview.skills.filter((s) => s.duplicateOf !== undefined) : [];

  const renderPick = (s: SkillCandidate) => {
    const on = Boolean(picked[s.path]) && !s.problem;
    return (
      <li key={s.path} className={`skill-pick${on ? ' on' : ''}`}>
        <label className="check skill-pick-head">
          <input type="checkbox" checked={on} disabled={Boolean(s.problem) || busy !== null} onChange={(e) => setPicked((p) => ({ ...p, [s.path]: e.target.checked }))} />
          <span className="skill-name">{s.name}</span>
        </label>
        {s.replaces ? (
          <Lozenge tone="info">Installed — reinstall to update</Lozenge>
        ) : s.alreadyInstalled ? (
          <Lozenge tone="warning" title="Another installed skill has this name">
            Name taken: installs as {s.id}
          </Lozenge>
        ) : null}
        {s.duplicateOf !== undefined && (
          <Lozenge title="The same SKILL.md and files">
            Same as <span className="mono">{s.duplicateOf || 'the repo itself'}</span>
          </Lozenge>
        )}
        {s.description && <p className="skill-desc">{s.description}</p>}
        <p className="skill-sub">
          <span className="mono">{s.path || 'the repo itself'}</span> · {plural(s.files, 'file')}, {sizeLabel(s.bytes)}
        </p>
        {s.problem && <p className="field-hint bad">{s.problem}</p>}
        {s.scripts.length > 0 && !s.problem && (
          <div className="skill-scripts">
            <details className="skill-script-list">
              <summary>{plural(s.scripts.length, 'script')} it can run</summary>
              <ul className="mono">
                {s.scripts.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </details>
            <label className="check">
              <input type="checkbox" checked={Boolean(allow[s.path])} disabled={!on || busy !== null} onChange={(e) => setAllow((a) => ({ ...a, [s.path]: e.target.checked }))} /> Allow scripts
            </label>
            <p className={`field-hint skill-warn${allow[s.path] ? '' : ' muted'}`}>
              {allow[s.path] ? (
                <>
                  <span className="warn">Not sandboxed:</span> desks with this skill can run these scripts on this PC, as you. Only allow it for skills you trust.
                </>
              ) : (
                'Off: desks read the skill but never run its scripts. You can allow them later.'
              )}
            </p>
          </div>
        )}
        {s.scripts.length === 0 && !s.problem && <p className="field-hint">No scripts it can run. Tests and front-end code never run.</p>}
      </li>
    );
  };

  return (
    <Modal open={open} onClose={close} title="Install a skill" size="wide" footer={footer}>
      <div className="create-form install-skill">
        {!preview ? (
          <>
            <label className="field">
              <span className="label">GitHub link</span>
              <input
                className="mono"
                value={url}
                spellCheck={false}
                placeholder="https://github.com/owner/repo"
                disabled={busy !== null}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void find();
                  }
                }}
              />
              <span className="field-hint">
                A public repo, or a folder in one (…/tree/main/.claude/skills/name). HQ fetches it and lists every skill in it. Nothing is installed until you pick.
              </span>
            </label>
            {busy === 'find' && (
              <p className="small muted" role="status">
                Fetching from GitHub... A big repo can take up to a minute. Cancel stops it.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="small muted">
              {plural(main.length, 'skill')} in{' '}
              {repoLink ? (
                <a href={repoLink} target="_blank" rel="noopener noreferrer">
                  {preview.repo}
                </a>
              ) : (
                preview.repo
              )}
              {preview.ref ? ` (${preview.ref})` : ''}
              {preview.commit ? ` at ${preview.commit.slice(0, 7)}` : ''}. Pick the ones to install. They are installed once for all your projects, and stay off until you turn them on for desks.
            </p>
            {preview.truncated && (
              <p className="banner warning" role="status">
                HQ stopped looking after 50 skills or 20 folders deep, so this list may be missing some. Link a folder in the repo to see the rest.
              </p>
            )}
            <ul className="skill-picks">{main.map(renderPick)}</ul>
            {dupes.length > 0 && (
              <details className="skill-dupes">
                <summary>
                  {plural(dupes.length, 'duplicate')}: the same files as a skill above, elsewhere in the repo
                </summary>
                <ul className="skill-picks">{dupes.map(renderPick)}</ul>
              </details>
            )}
          </>
        )}
        {error && (
          <p className="banner danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
