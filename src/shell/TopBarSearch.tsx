import { Search } from 'lucide-react';
import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Agent, WorkItem } from '../../shared/types';
import { useLayer } from '../hooks/useLayer';
import { searchItems } from '../lib/search';
import { StatusLozenge } from '../ui/Lozenge';
import { TypeIcon } from '../ui/TypeIcon';

interface Props {
  items: WorkItem[] | null;
  agents: Agent[];
  projectKey: string;
  onOpen: (key: string) => void;
  compact?: boolean;
}

export interface SearchHandle {
  focus: () => void;
}

/** Ticket search: a combobox. Enter opens the highlighted ticket in the side panel. */
export const TopBarSearch = forwardRef<SearchHandle, Props>(function TopBarSearch({ items, agents, projectKey, onOpen, compact }, ref) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const disabled = items === null;
  const hits = useMemo(() => (items ? searchItems(items, q, projectKey, agents) : []), [items, q, projectKey, agents]);
  const showList = open && q.trim().length > 0;
  useLayer(showList, () => {
    setOpen(false);
    input.current?.blur();
  }, { blurFirst: false });

  const pick = (key: string) => {
    onOpen(key);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className={`topbar-search${compact ? ' compact' : ''}`}>
      <Search size={15} className="topbar-search-icon" aria-hidden />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
        aria-label="Search tickets"
        placeholder={disabled ? 'Open a project to search' : 'Search tickets'}
        disabled={disabled}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && hits[active]) {
            e.preventDefault();
            pick(hits[active].key);
          }
        }}
      />
      {!q && !disabled && <kbd className="topbar-search-kbd">/</kbd>}
      {showList && (
        <ul id={listId} role="listbox" className="search-results">
          {hits.length === 0 && <li className="search-empty">No tickets match "{q}"</li>}
          {hits.map((h, i) => (
            <li
              key={h.item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search-hit${i === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(h.key)}
            >
              <TypeIcon kind={h.item.kind} />
              <span className="ticket-key">{h.key}</span>
              <span className="search-title">{h.item.title}</span>
              <StatusLozenge status={h.item.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
