import { useEffect, useRef, useState } from 'react';
import { MAX_TEAM_NOTES, roughTokens } from '../../shared/huddle';
import { TextEditor } from '../editor/TextEditor';
import { Markdown } from '../markdown/Markdown';

type NotesBody = { teamNotes?: string; notesEveryRun?: boolean; base?: string };

interface Props {
  teamNotes: string;
  notesEveryRun: boolean;
  /** Throw so the editor keeps the draft. */
  onSave: (body: NotesBody) => Promise<void>;
}

/** What the team has learned, in markdown. Desks read it only when you include it, so it costs nothing until then. */
export function TeamNotes({ teamNotes, notesEveryRun, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(teamNotes);
  // The notes as they were when you pressed Edit. The server refuses the save if they changed since.
  const [base, setBase] = useState(teamNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  // Notes approved from a huddle arrive with the poll; the draft follows them until you start editing.
  useEffect(() => {
    if (!editing) setDraft(teamNotes);
  }, [teamNotes, editing]);

  const tooLong = draft.length > MAX_TEAM_NOTES;
  const tokens = roughTokens(editing ? draft : teamNotes);
  const changedMeanwhile = editing && teamNotes.trimEnd() !== base.trimEnd();

  const save = async (body: NotesBody) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(body);
      if ('teamNotes' in body) setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="team-notes">
      <p className="field-hint">
        Desks read these only when you tick <strong>Include team notes</strong> on a task, a comment, a note or a huddle. About {tokens.toLocaleString()} tokens each time.
        Lessons approved in a huddle land here.
      </p>

      <label className="check team-notes-every">
        <input type="checkbox" checked={notesEveryRun} disabled={busy} onChange={(e) => void save({ notesEveryRun: e.target.checked })} /> Include in every desk run{' '}
        <span className="muted">(costs about {tokens.toLocaleString()} tokens on every run, including chat replies)</span>
      </label>

      {editing ? (
        <div className="team-notes-edit">
          <TextEditor toolbar autoFocus minHeight={220} value={draft} label="Team notes" placeholder="- Put the decision in the first line of a comment" onChange={setDraft} onSubmit={() => !tooLong && void save({ teamNotes: draft, base })} />
          {changedMeanwhile && (
            <p className="banner warning" role="status">
              The team notes changed while you were editing (a huddle note was approved). Saving would drop that change, so it will be refused. Copy your text, press Cancel, and edit again.
            </p>
          )}
          <div className="form-actions">
            <span className={`field-hint${tooLong ? ' bad' : ''}`}>
              {draft.length.toLocaleString()} of {MAX_TEAM_NOTES.toLocaleString()} characters
            </span>
            <span className="grow" />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setDraft(teamNotes);
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || tooLong} onClick={() => void save({ teamNotes: draft, base })}>
              {busy ? 'Saving...' : 'Save notes'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card-box team-notes-view">
          {teamNotes.trim() ? <Markdown source={teamNotes} breaks /> : <p className="muted">No notes yet. Add some, or approve lessons from a retro.</p>}
          <div className="form-actions">
            <span className="grow" />
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setBase(teamNotes);
                setDraft(teamNotes);
                setEditing(true);
              }}
            >
              Edit notes
            </button>
          </div>
        </div>
      )}
      {error && <p className="banner danger">{error}</p>}
    </div>
  );
}
