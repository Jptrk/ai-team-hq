import { useState } from 'react';
import { autoLimitsOf, type AutoStatus, type ProjectMeta } from '../../shared/types';
import { ConfirmInline } from '../ui/ConfirmInline';
import { autoTodayText, goalLabel, timeAgo } from '../util';

interface Props {
  project: ProjectMeta;
  auto: AutoStatus;
  /** Connections set to Auto in this project: desks change things there without asking, Autopilot or not. */
  autoConnections: number;
  /** HQ is paused for everyone: the header and the banner say so already. */
  paused: boolean;
  onChange: (patch: { autopilot?: boolean; goalMode?: boolean }) => Promise<void>;
  onResume: () => Promise<void>;
}

/**
 * The board's switches for what the team does on its own, and today's count against the limits.
 * Turning Autopilot on asks first: it works and spends while nobody watches. Turning anything off never asks.
 */
export function AutoBar({ project, auto, autoConnections, paused, onChange, onResume }: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const limits = autoLimitsOf(project);
  const hasGoal = Boolean(project.goal?.trim());

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  // Your own Pause shows in the header; here only what holds this project.
  const hold = auto.hold && !(paused && (auto.hold.kind === 'paused' || auto.hold.kind === 'usage' || auto.hold.kind === 'account')) ? auto.hold : null;

  return (
    <div className="auto-bar">
      <div className="auto-switches">
        <label className="auto-switch" title={project.autopilot ? 'Turn Autopilot off' : 'Turn Autopilot on'}>
          <span className="switch">
            <input
              type="checkbox"
              checked={Boolean(project.autopilot)}
              disabled={busy}
              onChange={(e) => {
                if (e.target.checked) setAsking(true);
                else void run(() => onChange({ autopilot: false }));
              }}
            />
            <span className="switch-track" aria-hidden />
          </span>
          Autopilot
        </label>
        <label
          className="auto-switch"
          title={
            !hasGoal
              ? 'Write a goal in Project settings first'
              : !project.autopilot
                ? 'Goal mode needs Autopilot on'
                : project.goalMode
                  ? 'Turn Goal mode off'
                  : 'Turn Goal mode on'
          }
        >
          <span className="switch">
            <input
              type="checkbox"
              checked={Boolean(project.goalMode)}
              disabled={busy || !project.autopilot || !hasGoal}
              onChange={(e) => void run(() => onChange({ goalMode: e.target.checked }))}
            />
            <span className="switch-track" aria-hidden />
          </span>
          Goal
        </label>
        <span className="auto-today muted small" title="What the team started on its own today, and its estimated spend. Your own clicks never count.">
          {autoTodayText(auto.today)}
        </span>
      </div>
      {auto.goal && project.goal && (
        <p className="goal-strip small">
          <span className={`chip goal-status goal-${auto.goal.planning ? 'planning' : auto.goal.status}`} title={auto.goal.note}>
            {goalLabel(auto.goal)}
          </span>
          <span className="goal-text" title={project.goal}>
            {project.goal.length > 90 ? `${project.goal.slice(0, 89)}…` : project.goal}
          </span>
          <span className="muted">
            {auto.goal.open}/{auto.goal.cap} open · {auto.goal.lastPlanAt ? `planned ${timeAgo(auto.goal.lastPlanAt)}` : 'not planned yet'}
          </span>
          <a className="goal-edit" href={`#/p/${project.id}/settings`}>
            Edit
          </a>
        </p>
      )}
      {hold && (
        <p className="auto-hold small" role="status">
          Waiting: {hold.text}.
          {hold.kind === 'halted' && (
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void run(onResume)}>
              Resume Autopilot
            </button>
          )}
        </p>
      )}
      {asking && (
        <ConfirmInline
          title={`Turn on Autopilot for ${project.name}?`}
          confirmLabel="Turn on"
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() =>
            void run(async () => {
              await onChange({ autopilot: true });
              setAsking(false);
            })
          }
        >
          Free desks start their next To do ticket on their own, while you are away too, up to {limits.runs} runs and ${limits.usd} a day. Pause in the header
          stops everything the team starts on its own.
          {autoConnections > 0 &&
            ` ${autoConnections} connection${autoConnections === 1 ? ' is' : 's are'} on Auto, so desks change things there without asking.`}
        </ConfirmInline>
      )}
    </div>
  );
}
