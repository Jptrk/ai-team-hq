import { useTeamNotes } from '../lib/projectContext';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * "Include team notes" for the run this starts. Off by default: the notes cost tokens on every run that carries them.
 * Hidden when there are no notes, or when the project already sends them with every run.
 */
export function NotesToggle({ checked, onChange }: Props) {
  const notes = useTeamNotes();
  if (!notes || notes.always) return null;
  return (
    <label className="check notes-toggle" title="Desks only read the team notes when you include them">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Include team notes{' '}
      <span className="muted">(about {notes.tokens.toLocaleString()} tokens)</span>
    </label>
  );
}
