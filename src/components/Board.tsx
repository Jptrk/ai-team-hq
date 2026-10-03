import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { boardColumns, type Agent, type ItemStatus, type WorkItem } from '../../shared/types';
import { agentById, ticketKey } from '../util';
import { BoardCard } from './board/BoardCard';
import { BoardToolbar } from './board/BoardToolbar';
import { EMPTY_FILTER, filterItems, isFiltered, type BoardFilter } from './board/filter';

interface Props {
  items: WorkItem[];
  agents: Agent[];
  projectKey: string;
  selectedId?: string;
  onOpen: (key: string) => void;
  onMove: (id: string, status: ItemStatus) => Promise<void>;
  /** Pauses the state poll while a card is dragged. */
  onDragActive: (on: boolean) => void;
  flash: (text: string) => void;
  /** Show the QA column: dev-team projects. It also shows while tickets are in it. */
  qa: boolean;
  /** Show the Sign-off column: projects with sign-off on. It also shows while tickets are in it. */
  signoff: boolean;
}

export function Board({ items, agents, projectKey, selectedId, onOpen, onMove, onDragActive, flash, qa, signoff }: Props) {
  const columns = useMemo(() => boardColumns(items, { qa, signoff }), [qa, signoff, items]);
  const colOf = (status: ItemStatus) => columns.findIndex((c) => c.statuses.includes(status));
  const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER);
  const [pending, setPending] = useState<Record<string, ItemStatus>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const enterCount = useRef<Record<number, number>>({});

  // A drag that ends outside any column (or on a card that re-rendered) still resets.
  useEffect(() => {
    if (!dragId) return;
    const reset = () => {
      setDragId(null);
      setOver(null);
      enterCount.current = {};
      onDragActive(false);
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, [dragId, onDragActive]);

  const shownItems = useMemo(() => items.map((i) => (pending[i.id] ? { ...i, status: pending[i.id] } : i)), [items, pending]);
  const filtered = useMemo(() => filterItems(shownItems, filter, projectKey), [shownItems, filter, projectKey]);
  const people = useMemo(() => agents.filter((a) => items.some((i) => i.assignee === a.id)), [agents, items]);
  const filtering = isFiltered(filter);

  const move = async (item: WorkItem, status: ItemStatus, viaKeyboard: boolean) => {
    if (colOf(item.status) === colOf(status)) return;
    setPending((p) => ({ ...p, [item.id]: status }));
    if (viaKeyboard) {
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-card="${item.id}"] .bcard-title`)?.focus());
      const col = columns[colOf(status)];
      flash(`${ticketKey(item, projectKey)} moved to ${col?.label ?? status}`);
    }
    await onMove(item.id, status);
    setPending((p) => {
      const next = { ...p };
      delete next[item.id];
      return next;
    });
  };

  const startDrag = (e: DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(id);
    onDragActive(true);
  };

  const endDrag = () => {
    setDragId(null);
    setOver(null);
    enterCount.current = {};
    onDragActive(false);
  };

  const dragItem = dragId ? shownItems.find((i) => i.id === dragId) : undefined;

  return (
    <div className="board-view">
      <BoardToolbar filter={filter} onChange={setFilter} people={people} />
      <div className="board">
        {columns.map((col, idx) => {
          const all = shownItems.filter((i) => col.statuses.includes(i.status));
          const cards = filtered.filter((i) => col.statuses.includes(i.status));
          const prev = columns[idx - 1];
          const next = columns[idx + 1];
          const validTarget = dragItem !== undefined && colOf(dragItem.status) !== idx;
          return (
            <section
              key={col.label}
              className={`column${over === idx && validTarget ? ' drop' : ''}`}
              aria-label={`${col.label}, ${cards.length} ticket${cards.length === 1 ? '' : 's'}`}
              onDragEnter={() => {
                enterCount.current[idx] = (enterCount.current[idx] ?? 0) + 1;
                setOver(idx);
              }}
              onDragLeave={() => {
                enterCount.current[idx] = (enterCount.current[idx] ?? 1) - 1;
                if (enterCount.current[idx] <= 0) setOver((o) => (o === idx ? null : o));
              }}
              onDragOver={(e) => {
                if (!validTarget) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain') || dragId;
                const item = shownItems.find((i) => i.id === id);
                endDrag();
                if (item) void move(item, col.statuses[0], false);
              }}
            >
              <header className="column-head">
                <span className="column-name">{col.label}</span>
                <span className="column-count">{filtering ? `${cards.length} of ${all.length}` : all.length}</span>
              </header>
              <div className="column-body">
                {cards.map((i) => (
                  <BoardCard
                    key={i.id}
                    item={i}
                    projectKey={projectKey}
                    owner={agentById(agents, i.assignee)}
                    selected={i.id === selectedId}
                    dragging={i.id === dragId}
                    onOpen={onOpen}
                    onDragStart={startDrag}
                    onDragEnd={endDrag}
                    left={prev ? { label: `Move ${ticketKey(i, projectKey)} to ${prev.label}`, onClick: () => void move(i, prev.statuses[0], true) } : undefined}
                    right={next ? { label: `Move ${ticketKey(i, projectKey)} to ${next.label}`, onClick: () => void move(i, next.statuses[0], true) } : undefined}
                  />
                ))}
                {cards.length === 0 && <p className="column-empty">{dragItem && validTarget ? 'Drop here' : filtering && all.length ? 'Nothing matches the filter' : 'No tickets'}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
