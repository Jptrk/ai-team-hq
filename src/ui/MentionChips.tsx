import type { Agent } from '../../shared/types';

/** Insert "@Name " into a draft once. */
export function addMention(text: string, name: string): string {
  if (text.includes(`@${name}`)) return text;
  return `${text}${text && !text.endsWith(' ') ? ' ' : ''}@${name} `;
}

export function MentionChips({ agents, onPick }: { agents: Agent[]; onPick: (name: string) => void }) {
  const desks = agents.filter((a) => !a.isHuman && a.status !== 'off');
  if (!desks.length) return null;
  return (
    <div className="mention-chips" aria-label="Mention a desk">
      {desks.map((a) => (
        <button key={a.id} type="button" className="mention-chip" onClick={() => onPick(a.name)}>
          <span className="dot" style={{ background: a.color }} />@{a.name}
        </button>
      ))}
    </div>
  );
}
