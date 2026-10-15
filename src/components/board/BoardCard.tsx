import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DragEvent } from 'react';
import type { Agent, Epic, WorkItem } from '../../../shared/types';
import { EpicTag } from '../epics/EpicTag';
import { Avatar } from '../../ui/Avatar';
import { StatusLozenge } from '../../ui/Lozenge';
import { TypeIcon } from '../../ui/TypeIcon';
import { holdText, ticketKey } from '../../util';

interface Props {
  item: WorkItem;
  projectKey: string;
  owner?: Agent;
  /** The ticket's epic, shown as a tag that opens it. */
  epic?: Epic;
  /** Tickets it is blocked by that are not done yet, in words for the Blocked tag; null when nothing blocks it. */
  blocked: string | null;
  selected: boolean;
  dragging: boolean;
  onOpen: (key: string) => void;
  onDragStart: (e: DragEvent, id: string) => void;
  onDragEnd: () => void;
  left?: { label: string; onClick: () => void };
  right?: { label: string; onClick: () => void };
}

export function BoardCard({ item, projectKey, owner, epic, blocked, selected, dragging, onOpen, onDragStart, onDragEnd, left, right }: Props) {
  const key = ticketKey(item, projectKey);
  return (
    <article
      className={`bcard${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      data-card={item.id}
      draggable
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      aria-current={selected ? 'true' : undefined}
    >
      <button type="button" className="bcard-title" onClick={() => onOpen(key)}>
        {item.title}
      </button>
      {epic && <EpicTag epic={epic} projectKey={projectKey} onOpen={onOpen} />}
      <div className="bcard-foot">
        <TypeIcon kind={item.kind} />
        <span className="ticket-key">{key}</span>
        {/* Only statuses that share a column get a tag; sign-off has its own. */}
        {(item.status === 'held' || item.status === 'sent-back' || item.status === 'approved') && <StatusLozenge status={item.status} />}
        {item.status === 'sent-back' && item.qa?.result === 'fail' && <span className="chip qa-chip">QA failed</span>}
        {item.origin === 'goal' && (
          <span className="chip goal-chip" title="Planned by the lead toward the project goal">
            Goal
          </span>
        )}
        {blocked && (
          <span className="chip blocked-chip" title={blocked}>
            Blocked
          </span>
        )}
        {/* A start waiting for its blockers shows as Blocked; one waiting for HQ as Waiting. */}
        {item.autoHold && !(blocked && item.autoHold.why === 'blocked') && (
          <span className="chip held-chip" title={holdText(item.autoHold)}>
            Waiting
          </span>
        )}
        {item.autoSkip && (
          <span className="chip skip-chip" title={`Autopilot left this for you: ${item.autoSkip.why}`}>
            Auto-skipped
          </span>
        )}
        <span className="bcard-spacer" />
        <span className="bcard-moves">
          {left && (
            <button type="button" className="icon-btn sm" onClick={left.onClick} aria-label={left.label} title={left.label}>
              <ChevronLeft size={15} />
            </button>
          )}
          {right && (
            <button type="button" className="icon-btn sm" onClick={right.onClick} aria-label={right.label} title={right.label}>
              <ChevronRight size={15} />
            </button>
          )}
        </span>
        {owner && <Avatar name={owner.name} color={owner.color} size={22} running={owner.running} title={`Assignee: ${owner.name}`} />}
      </div>
    </article>
  );
}
