import { ChevronRight, Plus, Sparkles, Users } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Agent, ProjectSkillsResponse, SkillMeta } from '../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';
import { KEYS, storage } from '../lib/storage';
import { ConfirmInline } from '../ui/ConfirmInline';
import { timeAgo } from '../util';
import { InstallSkillModal } from './skills/InstallSkillModal';
import { deskCoverage, folderUrl, groupByRepo, openKeys, parseOpenGroups, plural, repoParts, repoUrl, sizeLabel, sourceLabel, withOpen, type Coverage, type SkillGroup } from './skills/skillInfo';

interface Props {
  pid: string;
  agents: Agent[];
  ownerName: string;
  notify: Notify;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// A chip that covers several skills or desks: pressed when all are on, mixed (dashed) when only some are.
const pressed = (c: Coverage) => (c === 'all' ? true : c === 'some' ? 'mixed' : false);
const chipClass = (c: Coverage) => `mention-chip${c === 'all' ? ' on' : c === 'some' ? ' some' : ''}`;

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
  // The skill whose "Allow scripts" waits for your yes.
  const [confirmScripts, setConfirmScripts] = useState<string | null>(null);
  // Repo groups that are open. Null until you open or close one: then a lone group starts open, several start closed.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string> | null>(() => parseOpenGroups(storage.get(KEYS.skillGroups)));
  const saveOpenGroups = (next: ReadonlySet<string>) => {
    setOpenGroups(next);
    storage.set(KEYS.skillGroups, JSON.stringify([...next]));
  };
  // Bumped whenever an action starts or ends: a load that began before then is older than what's shown.
  const version = useRef(0);
  // Actions on their way. When two overlap their answers can land out of order, so the last to finish loads again.
  const inFlight = useRef(0);
  const overlapped = useRef(false);
  const uid = useId();
  const desks = agents.filter((a) => !a.isHuman);
  const deskIds = desks.map((a) => a.id);

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

  const markBusy = (ids: readonly string[], on: boolean) =>
    setBusy((b) => {
      const next = new Set(b);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  /** Run an action on these skills; an error goes in the banner. */
  const act = async (ids: readonly string[], run: () => Promise<ProjectSkillsResponse>, done?: () => void) => {
    markBusy(ids, true);
    setError(null);
    setConfirmRemove(null);
    setConfirmScripts((c) => (c && ids.includes(c) ? null : c));
    version.current++;
    if (inFlight.current++ > 0) overlapped.current = true;
    try {
      const res = await run();
      version.current++;
      setData(res);
      done?.();
    } catch (e) {
      setError(msg(e, 'That did not work'));
    } finally {
      markBusy(ids, false);
      if (--inFlight.current === 0 && overlapped.current) {
        overlapped.current = false;
        void load();
      }
    }
  };

  const toggleDesk = (skill: SkillMeta, id: string) => {
    const on = data?.desks[skill.id] ?? [];
    void act([skill.id], () => api.setSkillDesks(pid, skill.id, on.includes(id) ? on.filter((d) => d !== id) : [...on, id]));
  };

  /** Give these skills to these desks, or take them off, in one go. `said` is the toast, if any. */
  const changeDesks = (skills: readonly SkillMeta[], deskList: string[], on: boolean, said?: string) => {
    const ids = skills.map((s) => s.id);
    void act(ids, () => api.changeSkillDesks(pid, ids, on ? { add: deskList } : { remove: deskList }), said ? () => notify(said, { tone: 'success' }) : undefined);
  };

  const setScripts = (skill: SkillMeta, allowed: boolean, confirmed = false) => {
    // Scripts run on this PC as you, so allowing them waits for a yes in the page.
    if (allowed && !confirmed) {
      setConfirmScripts(skill.id);
      return;
    }
    setConfirmScripts(null);
    void act(
      [skill.id],
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
      [skill.id],
      async () => {
        await api.removeSkill(skill.id);
        return api.projectSkills(pid);
      },
      () => notify(`Removed ${skill.name}`, { tone: 'success' }),
    );
  };

  const onInstalled = (library: SkillMeta[], count: number, repo: string) => {
    setInstalling(false);
    // Open the repo you just installed from, so its skills are right there to turn on; the rest stay as they were.
    // Starts from what was showing, so a lone group that was open by default stays open.
    saveOpenGroups(withOpen(open, groupByRepo(library).map((g) => g.key), repo.toLowerCase(), true));
    version.current++;
    setData((d) => ({ library, desks: d?.desks ?? {} }));
    notify(`Installed ${plural(count, 'skill')}. Turn ${count === 1 ? 'it' : 'them'} on for desks below.`, { tone: 'success' });
    // Desks keep a reinstalled skill; load them again to be sure.
    void load();
  };

  const library = data?.library ?? [];
  const groups = groupByRepo(library);
  const keys = groups.map((g) => g.key);
  const open = openKeys(openGroups, keys);
  const setGroupOpen = (key: string, nowOpen: boolean) => {
    if (open.has(key) === nowOpen) return;
    if (!nowOpen) {
      // A question left open inside a closed group would stay hidden and keep answering Esc.
      const ids = new Set(groups.find((g) => g.key === key)?.skills.map((s) => s.id));
      setConfirmScripts((c) => (c && ids.has(c) ? null : c));
      setConfirmRemove((c) => (c && ids.has(c) ? null : c));
    }
    saveOpenGroups(withOpen(openGroups, keys, key, nowOpen));
  };
  const armed = confirmRemove ? library.find((s) => s.id === confirmRemove) : undefined;

  const renderSkill = (skill: SkillMeta) => {
    const on = data?.desks[skill.id] ?? [];
    const everyDesk = deskCoverage([skill.id], data?.desks ?? {}, deskIds);
    const allOn = everyDesk === 'all';
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
            {confirmScripts === skill.id && !skill.scriptsAllowed && (
              <ConfirmInline
                title={`Allow scripts for ${skill.name}?`}
                confirmLabel="Allow scripts"
                busy={isBusy}
                onConfirm={() => setScripts(skill, true, true)}
                onCancel={() => setConfirmScripts(null)}
              >
                Desks with this skill can then run its {plural(n, 'script')} on this PC, as {ownerName}, in every project where it is on. They are not sandboxed: a script can
                read and change anything you can, and a project's read-only setting and HQ's file rules don't limit it. Only allow this for skills you trust.
              </ConfirmInline>
            )}
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
          <span className="label" id={`${uid}-desks-${skill.id}`}>
            Desks in this project
          </span>
          <div className="chips" role="group" aria-labelledby={`${uid}-desks-${skill.id}`}>
            {desks.length > 1 && (
              <button
                type="button"
                className={`${chipClass(everyDesk)} all-desks`}
                aria-pressed={pressed(everyDesk)}
                title={allOn ? 'Turn it off for every desk' : 'Turn it on for every desk'}
                disabled={isBusy}
                onClick={() => changeDesks([skill], deskIds, !allOn)}
              >
                <Users size={12} aria-hidden />
                All desks
              </button>
            )}
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

  /** A repo's switch for all its skills on every desk, and chips to give one desk all of them. */
  const renderGroupDesks = (g: SkillGroup) => {
    const n = g.skills.length;
    if (!data || !desks.length || n < 2) return null;
    const ids = g.skills.map((s) => s.id);
    const cover = deskCoverage(ids, data.desks, deskIds);
    const everywhere = ids.filter((id) => deskCoverage([id], data.desks, deskIds) === 'all').length;
    const groupBusy = ids.some((id) => busy.has(id));
    const scripted = g.skills.filter((s) => s.scriptsAllowed).length;
    const { name } = repoParts(g.repo);
    // Says where things end up: "every skill" is right even when some already were.
    const turn = (deskList: string[], on: boolean, who: string) =>
      changeDesks(g.skills, deskList, on, `Every skill from ${name} is ${on ? 'on' : 'off'} for ${who}`);
    const hintId = `${uid}-cover-${g.key}`;
    const chipsId = `${uid}-give-${g.key}`;
    return (
      <div className="skill-group-desks">
        <label className="skill-allow">
          <span className="switch">
            <input
              type="checkbox"
              checked={cover === 'all'}
              ref={(el) => {
                // Some on, some off: the switch shows halfway, and reads as mixed.
                if (el) el.indeterminate = cover === 'some';
              }}
              aria-describedby={hintId}
              disabled={groupBusy}
              onChange={() => turn(deskIds, cover !== 'all', 'every desk')}
            />
            <span className="switch-track" aria-hidden />
          </span>
          All skills here, every desk
        </label>
        <span className="field-hint" id={hintId}>
          {everywhere} of {n} on for every desk
        </span>
        {desks.length > 1 && (
          <div className="conn-desks">
            <span className="label" id={chipsId}>
              Give every skill here to
            </span>
            <div className="chips" role="group" aria-labelledby={chipsId}>
              {desks.map((a) => {
                const c = deskCoverage(ids, data.desks, [a.id]);
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={chipClass(c)}
                    aria-pressed={pressed(c)}
                    title={c === 'all' ? `Take all ${n} off ${a.name}` : `Give ${a.name} all ${n}`}
                    disabled={groupBusy}
                    onClick={() => turn([a.id], c !== 'all', a.name)}
                  >
                    <span className="dot" style={{ background: a.color }} />
                    {a.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {scripted > 0 && (
          <p className="field-hint skill-warn">
            <span className="warn">{scripted === 1 ? '1 skill here has' : `${scripted} skills here have`} scripts allowed:</span> every desk you turn{' '}
            {scripted === 1 ? 'it' : 'them'} on for can run {scripted === 1 ? 'its' : 'their'} scripts on this PC, as you. They are not sandboxed.
          </p>
        )}
      </div>
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
        <ul className="conn-list skill-groups">
          {groups.map((g) => {
            const { owner, name } = repoParts(g.repo);
            const onHere = g.skills.filter((s) => (data.desks[s.id] ?? []).length > 0).length;
            const allowed = g.skills.filter((s) => s.scriptsAllowed).length;
            const link = repoUrl(g.repo);
            return (
              <li key={g.key} className="skill-group">
                <details
                  open={open.has(g.key)}
                  onToggle={(e) => {
                    // React passes toggle events up, so the inner "N scripts" list would land here too.
                    if (e.target !== e.currentTarget) return;
                    setGroupOpen(g.key, e.currentTarget.open);
                  }}
                >
                  <summary className="skill-group-head">
                    <ChevronRight size={16} className="skill-group-chevron" aria-hidden />
                    <span className="skill-group-title">
                      <span className="skill-group-name">{name}</span>
                      {owner && <span className="skill-group-owner">{owner}</span>}
                    </span>
                    <span className="skill-group-meta">
                      {plural(g.skills.length, 'skill')}
                      {onHere > 0 && <span className="skill-group-on"> · {onHere} on here</span>}
                      {allowed > 0 && <span> · scripts allowed on {allowed}</span>}
                    </span>
                  </summary>
                  <div className="skill-group-body">
                    {link && (
                      <p className="skill-group-link">
                        <a href={link} target="_blank" rel="noopener noreferrer" className="mono">
                          github.com/{g.repo}
                        </a>
                      </p>
                    )}
                    {renderGroupDesks(g)}
                    <ul className="skill-list">{g.skills.map(renderSkill)}</ul>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}

      <InstallSkillModal key={installKey} open={installing} onClose={() => setInstalling(false)} onInstalled={onInstalled} />
    </section>
  );
}
