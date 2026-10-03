import { Plus, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, ProjectSkillsResponse, SkillMeta } from '../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';
import { timeAgo } from '../util';
import { InstallSkillModal } from './skills/InstallSkillModal';
import { folderUrl, plural, sizeLabel, sourceLabel } from './skills/skillInfo';

interface Props {
  pid: string;
  agents: Agent[];
  ownerName: string;
  notify: Notify;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// A second click on Remove counts for this long.
const REMOVE_ARMED_MS = 5_000;

/** Skills: the library (installed once for all projects) and, for this project, which desks have each one. */
export function SkillsPanel({ pid, agents, ownerName, notify }: Props) {
  const [data, setData] = useState<ProjectSkillsResponse | null>(null);
  // Skills with an action on its way. Each has its own, so one finishing never frees another.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // The last load failed: with nothing shown yet, offer a retry instead of "Loading..." forever.
  const [loadFailed, setLoadFailed] = useState(false);
  const [installing, setInstalling] = useState(false);
  // A fresh dialog after every close, so it starts at the link again.
  const [installKey, setInstallKey] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Bumped whenever an action starts or ends: a load that began before then is older than what's shown.
  const version = useRef(0);
  const desks = agents.filter((a) => !a.isHuman);

  const load = useCallback(async () => {
    const v = ++version.current;
    setLoadFailed(false);
    try {
      const res = await api.projectSkills(pid);
      if (version.current === v) setData(res);
    } catch (e) {
      if (version.current !== v) return;
      setError(msg(e, 'Could not load skills'));
      setLoadFailed(true);
    }
  }, [pid]);

  const retry = () => {
    setError(null);
    void load();
  };

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!installing) setInstallKey((k) => k + 1);
  }, [installing]);

  // A Remove click that isn't followed up disarms on its own.
  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(null), REMOVE_ARMED_MS);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);

  const markBusy = (id: string, on: boolean) =>
    setBusy((b) => {
      const next = new Set(b);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Run one skill's action; an error goes in the banner. */
  const act = async (skill: SkillMeta, run: () => Promise<ProjectSkillsResponse>, done?: () => void) => {
    markBusy(skill.id, true);
    setError(null);
    setConfirmRemove(null);
    version.current++;
    try {
      const res = await run();
      version.current++;
      setData(res);
      done?.();
    } catch (e) {
      setError(msg(e, 'That did not work'));
    } finally {
      markBusy(skill.id, false);
    }
  };

  const toggleDesk = (skill: SkillMeta, id: string) => {
    const on = data?.desks[skill.id] ?? [];
    void act(skill, () => api.setSkillDesks(pid, skill.id, on.includes(id) ? on.filter((d) => d !== id) : [...on, id]));
  };

  const setScripts = (skill: SkillMeta, allowed: boolean) => {
    // Scripts run on this PC as you, so allowing them is a deliberate choice.
    if (
      allowed &&
      !window.confirm(
        `Allow scripts for ${skill.name}? Desks with this skill can then run its ${plural(skill.scripts.length, 'script')} on this PC, as ${ownerName}, in every project where it is on. They are not sandboxed: a script can read and change anything you can. A project's read-only setting and HQ's file rules don't limit scripts: they can write anywhere you can. Only allow this for skills you trust.`,
      )
    )
      return;
    void act(
      skill,
      async () => {
        await api.updateSkill(skill.id, { scriptsAllowed: allowed });
        return api.projectSkills(pid);
      },
      () => notify(allowed ? `Scripts allowed for ${skill.name}` : `${skill.name}'s scripts are off`, { tone: allowed ? 'warning' : 'info' }),
    );
  };

  const remove = (skill: SkillMeta) => {
    if (confirmRemove !== skill.id) {
      setConfirmRemove(skill.id);
      return;
    }
    void act(
      skill,
      async () => {
        await api.removeSkill(skill.id);
        return api.projectSkills(pid);
      },
      () => notify(`Removed ${skill.name}`, { tone: 'success' }),
    );
  };

  const onInstalled = (library: SkillMeta[], count: number) => {
    setInstalling(false);
    version.current++;
    setData((d) => ({ library, desks: d?.desks ?? {} }));
    notify(`Installed ${plural(count, 'skill')}. Turn ${count === 1 ? 'it' : 'them'} on for desks below.`, { tone: 'success' });
    // Desks keep a reinstalled skill; load them again to be sure.
    void load();
  };

  const library = data?.library ?? [];
  const armed = confirmRemove ? library.find((s) => s.id === confirmRemove) : undefined;

  const renderSkill = (skill: SkillMeta) => {
    const on = data?.desks[skill.id] ?? [];
    const isBusy = busy.has(skill.id);
    const confirming = confirmRemove === skill.id;
    const link = folderUrl(skill.source);
    const n = skill.scripts.length;
    return (
      <li key={skill.id} className={`skill${on.length ? ' on' : ''}`}>
        <div className="skill-body">
          <span className="skill-name">{skill.name}</span>
          {skill.description && <p className="skill-desc">{skill.description}</p>}
          <p className="skill-sub">
            From{' '}
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="mono">
                {sourceLabel(skill.source)}
              </a>
            ) : (
              <span className="mono">{sourceLabel(skill.source)}</span>
            )}{' '}
            · {plural(skill.files, 'file')}, {sizeLabel(skill.bytes)} · installed {timeAgo(skill.installedAt)}
          </p>
        </div>

        {n > 0 ? (
          <div className="skill-scripts">
            <details className="skill-script-list">
              <summary>{plural(n, 'script')}</summary>
              <ul className="mono">
                {skill.scripts.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
            <label className="skill-allow">
              <span className="switch">
                <input type="checkbox" checked={skill.scriptsAllowed} disabled={isBusy} onChange={(e) => setScripts(skill, e.target.checked)} />
                <span className="switch-track" aria-hidden />
              </span>
              Allow scripts
            </label>
            {skill.scriptsAllowed && (
              <p className="field-hint skill-warn">
                <span className="warn">Scripts allowed:</span> desks with this skill can run them on this PC, as you, in every project where it is on. They are not sandboxed.
              </p>
            )}
          </div>
        ) : (
          <p className="field-hint">No scripts. Its text only guides desks.</p>
        )}

        <div className="conn-desks">
          <span className="label">Desks in this project</span>
          <div className="chips">
            {desks.map((a) => {
              const picked = on.includes(a.id);
              return (
                <button key={a.id} type="button" className={`mention-chip${picked ? ' on' : ''}`} aria-pressed={picked} disabled={isBusy} onClick={() => toggleDesk(skill, a.id)}>
                  <span className="dot" style={{ background: a.color }} />
                  {a.name}
                </button>
              );
            })}
          </div>
          {on.length === 0 && <span className="field-hint">Off in this project. Pick the desks that should have it.</span>}
        </div>

        <div className="conn-actions">
          <span className="grow" />
          <button
            type="button"
            className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`}
            disabled={isBusy}
            onClick={() => remove(skill)}
            onBlur={() => confirming && setConfirmRemove(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && confirming) {
                // Only the armed button: Escape here must not also close anything else.
                e.stopPropagation();
                setConfirmRemove(null);
              }
            }}
          >
            {confirming ? 'Click again to remove' : 'Remove'}
          </button>
        </div>
        {confirming && <p className="field-hint conn-remove-note">Removes it from HQ: every project and every desk loses it.</p>}
      </li>
    );
  };

  return (
    <section className="page narrow-page skills">
      <div className="page-head">
        <h3 className="page-title">Skills</h3>
        {library.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setInstalling(true)}>
            <Plus size={16} aria-hidden /> Install a skill
          </button>
        )}
      </div>
      <p className="muted skills-intro">
        Skills are installed once for all your projects and turned on per desk here. A skill's text guides the desks that have it. Its scripts run on this PC only if
        you allow them, and they are not sandboxed, so allow them only for skills you trust.
      </p>
      {error && (
        <p className="banner danger" role="alert">
          {error}
        </p>
      )}
      {/* Announces the armed Remove button, which only changes its own text. */}
      <p className="sr-only" aria-live="polite">
        {armed ? `Click Remove on ${armed.name} again to remove it from HQ.` : ''}
      </p>

      {!data ? (
        loadFailed ? (
          <button type="button" className="btn btn-outline btn-sm" onClick={retry}>
            Try again
          </button>
        ) : (
          <p className="small muted">Loading...</p>
        )
      ) : library.length === 0 ? (
        <div className="empty skills-empty">
          <Sparkles size={28} aria-hidden />
          <p className="empty-title">No skills yet</p>
          <p>Install one from a GitHub link, like a repo of Claude Code skills. HQ lists every skill in it, and you pick.</p>
          <button type="button" className="btn btn-primary" onClick={() => setInstalling(true)}>
            <Plus size={16} aria-hidden /> Install a skill
          </button>
        </div>
      ) : (
        <ul className="conn-list skill-list">{library.map(renderSkill)}</ul>
      )}

      <InstallSkillModal key={installKey} open={installing} onClose={() => setInstalling(false)} onInstalled={onInstalled} />
    </section>
  );
}
