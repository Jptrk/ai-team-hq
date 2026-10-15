import { Search, X } from 'lucide-react';
import type { Agent, Epic } from '../../../shared/types';
import { Avatar } from '../../ui/Avatar';
import { EMPTY_FILTER, isFiltered, type BoardFilter } from './filter';

interface Props {
  filter: BoardFilter;
  onChange: (f: BoardFilter) => void;
  /** Desks that own at least one ticket. */
  people: Agent[];
  /** The project's epics, for the Epic filter. Hidden while there are none. */
  epics: Epic[];
}

export function BoardToolbar({ filter, onChange, people, epics }: Props) {
  const toggle = (id: string) =>
    onChange({ ...filter, assignees: filter.assignees.includes(id) ? filter.assignees.filter((a) => a !== id) : [...filter.assignees, id] });
  return (
    <div className="board-toolbar" role="search">
      <label className="toolbar-search">
        <Search size={14} aria-hidden />
        <input className="input" type="search" placeholder="Filter this board" aria-label="Filter this board" value={filter.text} onChange={(e) => onChange({ ...filter, text: e.target.value })} />
      </label>
      <div className="avatar-filter" role="group" aria-label="Filter by assignee">
        {people.map((a) => (
          <button key={a.id} type="button" className={`avatar-toggle${filter.assignees.includes(a.id) ? ' on' : ''}`} aria-pressed={filter.assignees.includes(a.id)} onClick={() => toggle(a.id)} title={a.name}>
            <Avatar name={a.name} color={a.color} size={28} />
            <span className="sr-only">{a.name}</span>
          </button>
        ))}
      </div>
      {(epics.length > 0 || filter.epic) && (
        <select className={`input epic-filter${filter.epic ? ' on' : ''}`} aria-label="Filter by epic" value={filter.epic} onChange={(e) => onChange({ ...filter, epic: e.target.value })}>
          <option value="">All epics</option>
          <option value="none">No epic</option>
          {epics.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="btn btn-outline btn-sm" aria-pressed={filter.needsMe} onClick={() => onChange({ ...filter, needsMe: !filter.needsMe })}>
        Needs me
      </button>
      {isFiltered(filter) && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(EMPTY_FILTER)}>
          <X size={13} aria-hidden /> Clear filters
        </button>
      )}
    </div>
  );
}
