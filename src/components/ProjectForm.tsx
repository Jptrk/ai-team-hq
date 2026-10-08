import { useEffect, useState } from 'react';
import { autoLimitsOf, hasQa, MAX_GOAL, projectProvider, signoffOn, type PathCheck, type ProjectAccess, type ProjectSummary, type Provider, type TeamTemplate } from '../../shared/types';
import { api } from '../api';
import { AVATAR_FALLBACK, cleanPath, suggestKey } from '../util';
import { ProjectAvatar } from './ProjectAvatar';

interface Props {
  mode: 'create' | 'edit';
  project?: ProjectSummary;
  projects: ProjectSummary[];
  onCancel: () => void;
  onSaved: (project: ProjectSummary) => void;
  onArchived?: (archivedTo: string) => void;
  /** GPT desks can run: HQ has a ChatGPT login you said yes to. */
  gptReady?: boolean;
  /** Claude desks can run now (Meta.claudeReady). */
  claudeReady?: boolean;
}

const MODELS: { id: Provider; title: string; sub: string }[] = [
  { id: 'claude', title: 'Claude', sub: 'Your Claude login or API key. Connections and web search work.' },
  { id: 'gpt', title: 'GPT', sub: "Your ChatGPT plan, through HQ's Codex. No connections or web search yet." },
];

const TEAMS: { id: TeamTemplate; title: string; desks: string }[] = [
  { id: 'dev', title: 'Dev team', desks: 'Tech Lead, Frontend, Backend, QA, DevOps, Code Reviewer, Docs' },
  { id: 'business', title: 'Business team', desks: 'COO, EA, Pipeline, Prospecting, Inbound, Automation, Design, HR' },
  { id: 'design', title: 'Design team', desks: 'Design Lead, Product, UI, Brand, Research, Content, Motion, Design Systems' },
  { id: 'blank', title: 'Blank', desks: 'One generalist. Add your own desks after.' },
];

export function ProjectForm({ mode, project, projects, onCancel, onSaved, onArchived, gptReady, claudeReady }: Props) {
  const editing = mode === 'edit' && project;
  const [folder, setFolder] = useState(project?.path ?? '');
  const [name, setName] = useState(project?.name ?? '');
  const [key, setKey] = useState(project?.key ?? '');
  const [template, setTemplate] = useState<TeamTemplate>(project?.template ?? 'dev');
  const [access, setAccess] = useState<ProjectAccess>(project?.access ?? 'read');
  const [signoff, setSignoff] = useState(project ? signoffOn(project) : true);
  const [provider, setProvider] = useState<Provider>(project ? projectProvider(project) : 'claude');
  const [autopilot, setAutopilot] = useState(Boolean(project?.autopilot));
  const [goalMode, setGoalMode] = useState(Boolean(project?.goalMode));
  const [goal, setGoal] = useState(project?.goal ?? '');
  const limits = autoLimitsOf(project ?? {});
  const [runsText, setRunsText] = useState(String(limits.runs));
  const [usdText, setUsdText] = useState(String(limits.usd));
  const [nameTouched, setNameTouched] = useState(Boolean(editing));
  const [keyTouched, setKeyTouched] = useState(Boolean(editing));
  const [check, setCheck] = useState<PathCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const takenKeys = projects.filter((p) => p.id !== project?.id).map((p) => p.key);

  // Live folder check, debounced.
  useEffect(() => {
    const value = cleanPath(folder);
    if (!value) {
      setCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const handle = window.setTimeout(async () => {
      try {
        const result = await api.checkPath(value, project?.id);
        setCheck(result);
        if (result.ok) {
          if (!nameTouched) setName(result.suggestedName);
          if (!keyTouched) setKey(result.suggestedKey);
        }
      } catch {
        setCheck(null);
      } finally {
        setChecking(false);
      }
    }, 300);
    return () => window.clearTimeout(handle);
    // nameTouched/keyTouched only gate auto-fill; re-running on them would re-fetch for nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, project?.id]);

  const onName = (value: string) => {
    setName(value);
    setNameTouched(true);
    if (!keyTouched) setKey(suggestKey(value, takenKeys));
  };

  const hasFolder = Boolean(cleanPath(folder));
  const folderBad = hasFolder && !checking && check !== null && !check.ok;
  const keyValue = key.trim().toUpperCase();
  const keyBad = keyValue !== '' && (!/^[A-Z][A-Z0-9]{1,9}$/.test(keyValue) || takenKeys.includes(keyValue));
  const runs = Number(runsText);
  const usd = Number(usdText);
  const runsBad = runsText.trim() === '' || !Number.isInteger(runs) || runs < 1 || runs > 500;
  const usdBad = usdText.trim() === '' || !Number.isFinite(usd) || usd < 1 || usd > 1000;
  const goalBad = goalMode && !goal.trim();
  const autoBad = Boolean(editing) && (runsBad || usdBad || goalBad);
  const canSave = name.trim() !== '' && keyValue !== '' && !keyBad && !folderBad && !(hasFolder && checking) && !autoBad && !busy;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), key: keyValue, path: cleanPath(folder), access: hasFolder ? access : ('read' as ProjectAccess), signoff };
    // What the team does on its own is set once the project exists.
    // Only what you changed here, so a switch flipped on the board meanwhile is not undone.
    const before = { autopilot: Boolean(project?.autopilot), goalMode: Boolean(project?.goalMode), goal: project?.goal ?? '', limits: autoLimitsOf(project ?? {}) };
    const auto = {
      ...(autopilot !== before.autopilot ? { autopilot } : {}),
      ...((autopilot && goalMode) !== before.goalMode ? { goalMode: autopilot && goalMode } : {}),
      ...(goal.trim() !== before.goal.trim() ? { goal: goal.trim() } : {}),
      ...(runs !== before.limits.runs || usd !== before.limits.usd ? { autoLimits: { runs, usd } } : {}),
    };
    // Only a change of model is sent: it starts every desk on a new conversation.
    const model = !editing || provider !== projectProvider(project) ? { provider } : {};
    try {
      const saved = editing ? await api.updateProject(project.id, { ...body, ...auto, ...model }) : await api.createProject({ ...body, template, ...model });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!editing) return;
    if (!confirmArchive) {
      setConfirmArchive(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { archivedTo } = await api.archiveProject(project.id);
      onArchived?.(archivedTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove');
      setConfirmArchive(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow-page">
      <button className="link-btn back-link" onClick={onCancel}>
        &larr; {editing ? 'Back to board' : 'Cancel'}
      </button>
      <div className="page-head">
        <h2 className="page-title">{editing ? 'Project settings' : 'Create project'}</h2>
        {keyValue && <ProjectAvatar project={{ key: keyValue, color: project?.color ?? AVATAR_FALLBACK }} size={34} />}
      </div>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="label">Project folder</span>
          <input
            className="mono"
            value={folder}
            placeholder="C:\Users\you\code\my-app"
            spellCheck={false}
            onChange={(e) => setFolder(e.target.value)}
            onBlur={() => setFolder((f) => cleanPath(f))}
          />
          <FolderHint folder={hasFolder} checking={checking} check={check} />
        </label>

        <div className="field-row">
          <label className="field grow">
            <span className="label">Name</span>
            <input value={name} maxLength={60} placeholder="My app" onChange={(e) => onName(e.target.value)} />
          </label>
          <label className="field key">
            <span className="label">Key</span>
            <input
              className="mono"
              value={key}
              maxLength={10}
              placeholder="MA"
              onChange={(e) => {
                setKey(e.target.value.toUpperCase());
                setKeyTouched(true);
              }}
            />
          </label>
        </div>
        <p className={`field-hint${keyBad ? ' bad' : ''}`}>
          {keyBad
            ? takenKeys.includes(keyValue)
              ? `${keyValue} is taken by another project`
              : 'Key: 2-10 letters or digits, starting with a letter'
            : `Tickets will be numbered ${keyValue || 'KEY'}-1, ${keyValue || 'KEY'}-2...`}
        </p>

        {!editing && (
          <fieldset className="field">
            <legend className="label">Team</legend>
            <div className="choices two">
              {TEAMS.map((t) => (
                <label key={t.id} className={`choice${template === t.id ? ' on' : ''}`}>
                  <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
                  <span className="choice-title">{t.title}</span>
                  <span className="choice-sub">{t.desks}</span>
                </label>
              ))}
            </div>
            <p className="field-hint">Every new team gets its own names, different from your other projects.</p>
          </fieldset>
        )}

        <fieldset className="field">
          <legend className="label">Model</legend>
          <div className="choices two">
            {MODELS.map((m) => (
              <label key={m.id} className={`choice${provider === m.id ? ' on' : ''}`}>
                <input type="radio" name="provider" value={m.id} checked={provider === m.id} onChange={() => setProvider(m.id)} />
                <span className="choice-title">{m.title}</span>
                <span className="choice-sub">{m.sub}</span>
              </label>
            ))}
          </div>
          <p className="field-hint">
            Every desk in this project runs on it.
            {editing && provider !== projectProvider(project) && ' Switching starts every desk on a new conversation; their memory.md stays. Wait for runs to finish first.'}
            {provider === 'gpt' && !gptReady && ' Sign in to ChatGPT on the Accounts page, or work here waits.'}
            {provider === 'claude' && !claudeReady && " Claude can't run on HQ now, so work here waits until it can: see the Accounts page."}
          </p>
        </fieldset>

        <fieldset className="field" disabled={!hasFolder}>
          <legend className="label">What agents can do in the folder</legend>
          <div className="choices two">
            <label className={`choice${access === 'read' ? ' on' : ''}`}>
              <input type="radio" name="access" value="read" checked={access === 'read'} onChange={() => setAccess('read')} />
              <span className="choice-title">Read only</span>
              <span className="choice-sub">Read code, write plans and diffs into reports. Recommended.</span>
            </label>
            <label className={`choice${access === 'write' ? ' on' : ''}`}>
              <input type="radio" name="access" value="write" checked={access === 'write'} onChange={() => setAccess('write')} />
              <span className="choice-title">Read &amp; write</span>
              <span className="choice-sub">Edit files directly. Never .git, node_modules, .env or keys. No shell, no commits.</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="field">
          <legend className="label">Sign-off</legend>
          <label className="check signoff-check">
            <input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} /> Finished tickets wait for your sign-off before Done
          </label>
          <p className="field-hint">
            {signoff
              ? 'They show in Needs you: Mark done, or Send back with the changes you want.'
              : `Finished tickets go straight to Done${hasQa(template) ? ' once QA passes them' : ''}.${editing ? ' Tickets already waiting for sign-off stay until you mark them done.' : ''}`}
          </p>
        </fieldset>

        {editing && (
          <fieldset className="field auto-settings">
            <legend className="label">Team runs on its own</legend>
            <label className="check signoff-check">
              <input
                type="checkbox"
                checked={autopilot}
                onChange={(e) => {
                  setAutopilot(e.target.checked);
                  if (!e.target.checked) setGoalMode(false);
                }}
              />{' '}
              Autopilot: free desks start their next To do ticket on their own
            </label>
            <p className="field-hint">
              {autopilot ? (
                <>
                  <span className="warn">On:</span> the team works and spends while you are away, up to the daily limits below. Pause in the header stops it.
                </>
              ) : (
                'Off: To do tickets wait until you put someone on them.'
              )}
            </p>
            <label className="check signoff-check">
              <input type="checkbox" checked={goalMode} disabled={!autopilot} onChange={(e) => setGoalMode(e.target.checked)} /> Goal mode: the lead plans tickets toward a goal
            </label>
            {(goalMode || goal) && (
              <label className="field">
                <span className="label">Goal</span>
                <textarea value={goal} maxLength={MAX_GOAL} rows={4} placeholder="Ship the redesigned checkout by Friday: new cart page, saved cards, and tests." onChange={(e) => setGoal(e.target.value)} />
                <span className={`field-hint${goalBad ? ' bad' : ''}`}>
                  {goalBad
                    ? 'Write the goal, or turn Goal mode off.'
                    : 'The lead turns it into tickets for the team, at most 5 at a time and 8 open, and tells you in Needs you when it is reached or stuck.'}
                </span>
              </label>
            )}
            <div className="field-row">
              <label className="field">
                <span className="label">Runs per day</span>
                <input type="number" inputMode="numeric" min={1} max={500} step={1} value={runsText} onChange={(e) => setRunsText(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Spend per day ($)</span>
                <input type="number" inputMode="decimal" min={1} max={1000} step={1} value={usdText} onChange={(e) => setUsdText(e.target.value)} />
              </label>
            </div>
            <p className={`field-hint${runsBad || usdBad ? ' bad' : ''}`}>
              {runsBad
                ? 'Runs per day: a whole number from 1 to 500.'
                : usdBad
                  ? 'Spend per day: from $1 to $1000.'
                  : 'Counts every run the team starts on its own: Autopilot, goal planning, hand-offs, chat replies between desks, QA checks. Your own clicks never count. Spend is the SDK estimate. Both reset at midnight; past them, the team waits.'}
            </p>
          </fieldset>
        )}

        {error && <p className="banner danger">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            {busy ? 'Saving...' : editing ? 'Save changes' : 'Create project'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>

      {editing && (
        <section className="danger-zone">
          <h3 className="label">Remove project</h3>
          <p className="small muted">
            Moves this project&rsquo;s board and agent workspaces to data/archive. The linked folder is not touched.
          </p>
          <button className={`btn ${confirmArchive ? 'btn-danger' : 'btn-outline'}`} disabled={busy} onClick={() => void archive()}>
            {confirmArchive ? `Click again to remove ${project.key}` : 'Remove project'}
          </button>
        </section>
      )}
    </div>
  );
}

function FolderHint({ folder, checking, check }: { folder: boolean; checking: boolean; check: PathCheck | null }) {
  if (!folder) return <span className="field-hint">Optional. Paste a path; quotes from "Copy as path" are fine. Leave empty for a project with no code.</span>;
  if (checking || !check) return <span className="field-hint">Checking...</span>;
  if (!check.ok) return <span className="field-hint bad">{check.error}</span>;
  const facts = [check.isGit ? 'git repo' : 'not a git repo', check.instructionsFile ? `${check.instructionsFile} goes into every agent's prompt` : null, check.hasReadme ? 'README found' : null].filter(Boolean);
  return (
    <span className="field-hint good">
      Folder found · {facts.join(' · ')}
      {check.inUseBy && <span className="warn"> · also linked to {check.inUseBy}</span>}
    </span>
  );
}
