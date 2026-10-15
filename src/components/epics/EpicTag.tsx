import type { Epic } from '../../../shared/types';
import { ticketKey } from '../../util';

/** A ticket's epic as a small tag: its color as a dot, and its title. Opens the epic. */
export function EpicTag({ epic, projectKey, onOpen }: { epic: Epic; projectKey: string; onOpen: (key: string) => void }) {
  const key = ticketKey(epic, projectKey);
  return (
    <button type="button" className="epic-tag" onClick={() => onOpen(key)} title={`Epic ${key}: ${epic.title}`}>
      <span className="epic-dot" style={{ background: epic.color }} aria-hidden />
      <span className="epic-tag-text">{epic.title}</span>
    </button>
  );
}
