import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity, AgentActivity } from '../../shared/activity';
import { deskSlotsFor, withDeskNumbers } from '../../shared/desks';
import type { Agent } from '../../shared/types';
import type { Box } from '../office/geometry';
import { layoutFor, MAX_DESKS } from '../office/layout';
import { OfficeScene, type PersonPoint } from '../office/OfficeScene';
import { ACTIVITY_GLYPH, ACTIVITY_LABEL, durationSince, placePeople, returnTime } from '../office/placement';

interface Props {
  agents: Agent[];
  /** What each desk is doing right now (from the server). */
  office: Record<string, AgentActivity>;
  ownerName: string;
  onSelect: (id: string) => void;
}

const ORDER: Activity[] = ['coding', 'working', 'chatting', 'idle', 'waiting', 'off'];
/** Spec §4: open after 120 ms, move between people at once, close after 80 ms. */
const OPEN_MS = 120;
const CLOSE_MS = 80;
const LONG_WAIT_MS = 2 * 60 * 60_000;

function where(a: AgentActivity, agents: Agent[]): string {
  if (a.activity === 'chatting') {
    if (a.huddleId) return 'In a huddle';
    const names = (a.with ?? []).map((id) => agents.find((x) => x.id === id)?.name ?? id);
    return names.length ? `With ${names.join(', ')}` : 'With you';
  }
  return '';
}

/** Spec §4: off shift shows no duration, only when they're back. */
const showsTime = (a: AgentActivity) => Boolean(a.since) && a.activity !== 'off';

function samePoints(a: Map<string, PersonPoint>, b: Map<string, PersonPoint>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, p] of a) {
    const q = b.get(id);
    if (!q || q.x !== p.x || q.y !== p.y || q.feet !== p.feet) return false;
  }
  return true;
}

export function Office({ agents, office, ownerName, onSelect }: Props) {
  // Every desk gets a number, even in data from before desk numbers, so nobody is left without a desk.
  const team = useMemo(() => withDeskNumbers(agents, MAX_DESKS), [agents]);
  const desks = deskSlotsFor(team);
  const layout = useMemo(() => layoutFor(desks), [desks]);
  const sticky = useRef(new Map<string, string>());
  const plan = useMemo(() => placePeople(layout, team, office, sticky.current), [layout, team, office]);
  useEffect(() => {
    sticky.current = plan.sticky;
  }, [plan]);

  const bots = agents.filter((a) => !a.isHuman);
  const act = (a: Agent): AgentActivity => office[a.id] ?? { activity: 'idle', since: '' };
  const counts = Object.fromEntries(ORDER.map((k) => [k, bots.filter((a) => act(a).activity === k).length])) as Record<Activity, number>;
  const waiting = bots.filter((a) => act(a).activity === 'waiting');
  const longWait = waiting.some((a) => Date.now() - Date.parse(act(a).since) > LONG_WAIT_MS);

  // Whole-number scale only. A narrow screen gets 1× and scrolls sideways instead of blurring.
  const stage = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Box | null>(null);
  const [width, setWidth] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const natural = frame ? frame.x1 - frame.x0 : 0;
  const scale = natural && width ? Math.max(1, Math.min(3, Math.floor(width / natural))) : 1;
  const onFrame = useCallback((b: Box) => setFrame((f) => (f && f.x0 === b.x0 && f.y0 === b.y0 && f.x1 === b.x1 && f.y1 === b.y1 ? f : b)), []);
  // Where everyone is right now, so a card follows its person when they move.
  const [points, setPoints] = useState<Map<string, PersonPoint>>(() => new Map());
  const onPoints = useCallback((p: Map<string, PersonPoint>) => setPoints((cur) => (samePoints(cur, p) ? cur : p)), []);

  // The hover card: one at a time, pinned by a tap on touch screens.
  const [card, setCard] = useState<{ id: string; pinned: boolean } | null>(null);
  const cardRef = useRef(card);
  useEffect(() => {
    cardRef.current = card;
  }, [card]);
  const cardId = useId();
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  // Set while focus goes back to a person after their card closed, so the card doesn't open again at once.
  const hushed = useRef<string | null>(null);
  const onHover = useCallback((id: string | null) => {
    if (id && hushed.current === id) return;
    window.clearTimeout(timer.current);
    const open = cardRef.current;
    if (open?.pinned) return;
    if (!id) timer.current = window.setTimeout(() => setCard((cur) => (cur?.pinned ? cur : null)), CLOSE_MS);
    // Already showing someone: move straight to the next person.
    else if (open) setCard({ id, pinned: false });
    else timer.current = window.setTimeout(() => setCard({ id, pinned: false }), OPEN_MS);
  }, []);
  const onActivate = useCallback(
    (id: string, pointerType: string | undefined) => {
      clear();
      if (pointerType === 'touch' || pointerType === 'pen') setCard((c) => (c?.pinned && c.id === id ? null : { id, pinned: true }));
      else onSelect(id);
    },
    [onSelect],
  );
  useEffect(() => () => clear(), []);
  /** Focus a person's target without opening their card again. */
  const focusPerson = (id: string) => {
    hushed.current = id;
    stage.current?.querySelector<SVGGElement>(`.o-target[data-agent="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    hushed.current = null;
  };
  const closeCard = () => {
    clear();
    setCard(null);
  };

  // Escape closes any card, hovered or pinned (WCAG 1.4.13). A press outside a pinned card and outside everyone dismisses it (spec §4).
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      window.clearTimeout(timer.current);
      setCard(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!card.pinned) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.office-card, .o-person')) return;
      setCard(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [card]);

  const at = card ? points.get(card.id) : undefined;
  // Their person left the floor (waiting beyond the queue, or gone): nothing to point at.
  useEffect(() => {
    if (card && points.size && !points.has(card.id)) setCard(null);
  }, [card, points]);
  const shown = card && at ? agents.find((a) => a.id === card.id) : undefined;
  const cardAct = shown && !shown.isHuman ? act(shown) : null;
  // Above the name, kept inside the stage; near the top edge it goes below the person instead.
  const stageW = stage.current?.clientWidth ?? 0;
  const offset = stage.current ? Math.max(0, (stageW - (frame ? (frame.x1 - frame.x0) * scale : 0)) / 2) : 0;
  const rawLeft = at && frame ? offset + (at.x - frame.x0) * scale - scrollX : 0;
  const left = Math.min(Math.max(rawLeft, 134), Math.max(134, stageW - 134));
  const above = at && frame ? (at.y - frame.y0) * scale : 0;
  const below = above < 150;
  const top = at && frame ? (below ? (at.feet - frame.y0) * scale : above) : 0;

  return (
    <div className="office">
      <p className="muted small office-hint">Hover or tap someone to see what they're on. Click to open their panel.</p>
      <div className="office-wrap">
        <div
          className="office-stage"
          ref={stage}
          onScroll={(e) => {
            setScrollX(e.currentTarget.scrollLeft);
            if (card && !card.pinned) setCard(null);
          }}
        >
          <OfficeScene
            layout={layout}
            plan={plan}
            ownerName={ownerName}
            waitingCount={waiting.length}
            longWait={longWait}
            onActivate={onActivate}
            onHover={onHover}
            onPoints={onPoints}
            described={card && !card.pinned && shown ? { id: cardId, agentId: card.id } : null}
            scale={scale}
            onFrame={onFrame}
          />
        </div>
        {card && shown && (
          <div
            id={cardId}
            className={`office-card${cardAct ? ` st-${cardAct.activity}` : ''}${below ? ' below' : ''}`}
            style={{ left: Math.round(left) || 0, top: Math.round(top) || 0 }}
            role={card.pinned ? 'dialog' : 'tooltip'}
            aria-label={card.pinned ? shown.name : undefined}
            onPointerEnter={clear}
            onPointerLeave={() => onHover(null)}
          >
            <div className="office-card-head">
              <span className="office-card-name">{shown.name}</span>
              {card.pinned && (
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label="Close"
                  onClick={() => {
                    closeCard();
                    focusPerson(shown.id);
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </div>
            <div className="office-card-role">{shown.isHuman ? 'Founder' : shown.role}</div>
            {cardAct && (
              <>
                <div className="office-card-state">
                  <span className="office-card-glyph" aria-hidden>
                    {ACTIVITY_GLYPH[cardAct.activity]}
                  </span>
                  {ACTIVITY_LABEL[cardAct.activity]}
                  {showsTime(cardAct) && <span className="office-card-time"> · {durationSince(cardAct.since)}</span>}
                </div>
                {where(cardAct, agents) && <div className="office-card-line">{where(cardAct, agents)}</div>}
                {cardAct.activity === 'off' && returnTime(shown.currentTask) && <div className="office-card-line">Back {returnTime(shown.currentTask)}</div>}
                {/* Idle and off shift have no task row (spec §4): the last task would be stale. */}
                {cardAct.activity !== 'off' && cardAct.activity !== 'idle' && shown.currentTask && <div className="office-card-task">{shown.currentTask}</div>}
              </>
            )}
            {card.pinned && (
              <button
                type="button"
                className="btn btn-sm btn-outline office-card-open"
                onClick={() => {
                  // Focus goes to the person first, so the panel gives it back to them when it closes.
                  closeCard();
                  focusPerson(shown.id);
                  onSelect(shown.id);
                }}
              >
                Open {shown.isHuman ? 'profile' : 'panel'}
              </button>
            )}
          </div>
        )}
      </div>

      <ul className="sr-only" aria-label="Who is where">
        {bots.map((a) => {
          const x = act(a);
          const back = x.activity === 'off' ? returnTime(a.currentTask) : null;
          return (
            <li key={a.id}>
              {a.name}, {a.role}: {ACTIVITY_LABEL[x.activity]}
              {showsTime(x) ? ` for ${durationSince(x.since)}` : ''}
              {back ? `, back ${back}` : ''}
              {where(x, agents) ? `, ${where(x, agents).toLowerCase()}` : ''}
            </li>
          );
        })}
      </ul>

      <div className="stats office-stats">
        {ORDER.map((k) => (
          <div key={k} className={`stat st-${k}`}>
            <span className="stat-n">{counts[k]}</span>
            <span className="stat-l">
              <span className="office-dot" aria-hidden>
                {ACTIVITY_GLYPH[k]}
              </span>
              {ACTIVITY_LABEL[k]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
