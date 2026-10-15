import type { EpicProgress } from '../../../shared/types';
import { progressParts, progressText } from './epicInfo';

/** An epic's progress as one bar: done, in progress, to do. */
export function ProgressBar({ progress, compact }: { progress: EpicProgress; compact?: boolean }) {
  const parts = progressParts(progress);
  const label = progress.total ? `${progressText(progress)}, ${progress.active} in progress, ${progress.todo} to do` : progressText(progress);
  return (
    <div className={`epic-progress${compact ? ' compact' : ''}`} role="img" aria-label={label} title={label}>
      {parts.done > 0 && <span className="epic-progress-done" style={{ width: `${parts.done}%` }} />}
      {parts.active > 0 && <span className="epic-progress-active" style={{ width: `${parts.active}%` }} />}
    </div>
  );
}
