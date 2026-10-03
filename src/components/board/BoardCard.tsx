import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DragEvent } from 'react';
import type { Agent, WorkItem } from '../../../shared/types';
import { Avatar } from '../../ui/Avatar';
import { StatusLozenge } from '../../ui/Lozenge';
import { TypeIcon } from '../../ui/TypeIcon';
import { ticketKey } from '../../util';

interface Props {
  item: WorkItem;
  projectKey: string;
  owner?: Agent;
  selected: boolean;
  dragging: boolean;
  onOpen: (key: string) => void;
  onDragStart: (e: DragEvent, id: string) => void;
  onDragEnd: () => void;
  left?: { label: string; onClick: () => void };
  right?: { label: string; onClick: () => void };
}

export function BoardCard({ item, projectKey, owner, selected, dragging, onOpen, onDragStart, onDragEnd, left, right }: Props) {
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
      <div className="bcard-foot">
        <TypeIcon kind={item.kind} />
        <span className="ticket-key">{key}</span>
        {/* Only statuses that share a column get a tag; sign-off has its own. */}
        {(item.status === 'held' || item.status === 'sent-back' || item.status === 'approved') && <StatusLozenge status={item.status} />}
        {item.status === 'sent-back' && item.qa?.result === 'fail' && <span className="chip qa-chip">QA failed</span>}
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
