import { Plus, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { presetById } from '../../../shared/mcpPresets';
import { buildSpec, secretArgs, type AddTransport, type KeyValue } from '../../../shared/mcpSpec';
import type { AddPreview, ConnectionRow, ConnectionsResponse } from '../../../shared/types';
import { api } from '../../api';
import { Modal } from '../../shell/Modal';
import { alreadySetUp, blankRow, CUSTOM, initialForm, presetCards, splitArgs, toRequest, type AddForm } from './addForm';

interface Props {
  open: boolean;
  onClose: () => void;
  pid: string;
  rows: ConnectionRow[];
  hasFolder: boolean;
  onAdded: (res: ConnectionsResponse) => void;
}

type Step = 'pick' | 'details' | 'review';

const TRANSPORTS: { value: AddTransport; label: string }[] = [
  { value: 'http', label: 'URL (HTTP)' },
  { value: 'sse', label: 'URL (SSE)' },
  { value: 'stdio', label: 'Local command' },
];

/**
 * Add an MCP server: pick a preset or Custom, fill in the details, review exactly what gets saved,
 * then save it through Claude Code. Remounted after every close, so typed secrets never linger.
 */
export function AddConnectionModal({ open, onClose, pid, rows, hasFolder, onAdded }: Props) {
  const [step, setStep] = useState<Step>('pick');
  const [pick, setPick] = useState<string>('playwright');
  const [form, setForm] = useState<AddForm>(() => initialForm('playwright', hasFolder));
  const [preview, setPreview] = useState<AddPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Problems show once you try to go on, not while you are still typing the first field.
  const [tried, setTried] = useState(false);
  const sending = useRef(false);

  const cards = useMemo(() => presetCards(rows), [rows]);
  const preset = presetById(form.pick);
  const built = useMemo(() => buildSpec(toRequest(form)), [form]);
  const problem = 'error' in built ? built.error : null;
  const isCustomCommand = form.pick === CUSTOM && form.transport === 'stdio';
  const taken = alreadySetUp(rows, form.name.trim());

  const set = (patch: Partial<AddForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPreview(null);
    setError(null);
  };

  const next = () => {
    if (form.pick !== pick) {
      setForm(initialForm(pick, hasFolder));
      // A new pick starts clean: its problems show once you try to go on.
      setTried(false);
    }
    setError(null);
    setStep('details');
  };

  const review = async () => {
    if (problem) {
      setTried(true);
      return;
    }
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.previewConnection(pid, toRequest(form)));
      setStep('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check those details');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const add = async () => {
    if (sending.current || !preview) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.addConnection(pid, toRequest(form), preview.preview));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add it');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const footer = (
    <>
      {step !== 'pick' && (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStep(step === 'review' ? 'details' : 'pick')}>
          Back
        </button>
      )}
      <span className="grow" />
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
      {step === 'pick' && (
        <button type="button" className="btn btn-primary" onClick={next}>
          Next
        </button>
      )}
      {step === 'details' && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void review()}>
          {busy ? 'Checking...' : 'Review'}
        </button>
      )}
      {step === 'review' && (
        <button type="button" className="btn btn-primary" disabled={busy || !preview || (isCustomCommand && !form.trust)} onClick={() => void add()}>
          {busy ? 'Adding...' : 'Add connection'}
        </button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="Add connection" size="wide" footer={footer}>
      <div className="create-form add-conn">
        {step === 'pick' && (
          <fieldset className="field">
            <legend className="label">What to connect</legend>
            <div className="choices">
              {cards.map((c) => (
                <label key={c.id} className={`choice${pick === c.id ? ' on' : ''}`}>
                  <input type="radio" name="add-pick" value={c.id} checked={pick === c.id} onChange={() => setPick(c.id)} />
                  <span className="choice-title">{c.title}</span>
                  <span className="choice-sub">{c.blurb}</span>
                  {c.already && <span className="choice-sub conn-already">{c.already}</span>}
                </label>
              ))}
              <label className={`choice${pick === CUSTOM ? ' on' : ''}`}>
                <input type="radio" name="add-pick" value={CUSTOM} checked={pick === CUSTOM} onChange={() => setPick(CUSTOM)} />
                <span className="choice-title">Custom</span>
                <span className="choice-sub">Any other MCP server: a URL (GitHub, Sentry, Atlassian...) or a program to run on this PC.</span>
              </label>
            </div>
          </fieldset>
        )}

        {step === 'details' && (
          <>
            <label className="field">
              <span className="label">Name</span>
              <input className="mono" value={form.name} maxLength={40} spellCheck={false} placeholder="my-server" onChange={(e) => set({ name: e.target.value })} />
              <span className={`field-hint${taken ? ' bad' : ''}`}>
                {taken ? `${taken}. Pick another name, or save it in the other place.` : 'Desks see its tools as mcp__name__tool. Letters, numbers, - and _.'}
              </span>
            </label>

            <fieldset className="field">
              <legend className="label">Save it for</legend>
              <div className="choices two">
                <label className={`choice${form.scope === 'project' ? ' on' : ''}${hasFolder ? '' : ' off'}`}>
                  <input type="radio" name="add-scope" value="project" disabled={!hasFolder} checked={form.scope === 'project'} onChange={() => set({ scope: 'project' })} />
                  <span className="choice-title">This project only</span>
                  <span className="choice-sub">
                    {hasFolder ? "Your Claude Code settings for this project's folder. Only this project sees it." : 'Needs a project folder. Set one in Project settings.'}
                  </span>
                </label>
                <label className={`choice${form.scope === 'all' ? ' on' : ''}`}>
                  <input type="radio" name="add-scope" value="all" checked={form.scope === 'all'} onChange={() => set({ scope: 'all' })} />
                  <span className="choice-title">All my projects</span>
                  <span className="choice-sub">Your global Claude Code settings. Every project and Claude Code session on this PC sees it.</span>
                </label>
              </div>
              <span className="field-hint">Either way it stays on this PC, not in git, and starts off in HQ until you turn it on.</span>
            </fieldset>

            {preset && (
              <fieldset className="field">
                <legend className="label">{preset.title} options</legend>
                <div className="add-conn-options">
                  {preset.options.map((o) =>
                    o.kind === 'flag' ? (
                      <label key={o.id} className="check add-conn-flag">
                        <input type="checkbox" checked={form.values[o.id] === true} onChange={(e) => set({ values: { ...form.values, [o.id]: e.target.checked } })} />
                        <span>
                          {o.label}
                          {o.hint && <span className="add-conn-hint">{o.hint}</span>}
                        </span>
                      </label>
                    ) : (
                      <div key={o.id} className="add-conn-choice">
                        <span className="label">{o.label}</span>
                        <div className="conn-modes" role="group" aria-label={o.label}>
                          {o.choices?.map((c) => (
                            <button
                              key={c.value}
                              type="button"
                              className={`seg${form.values[o.id] === c.value ? ' on' : ''}`}
                              aria-pressed={form.values[o.id] === c.value}
                              onClick={() => set({ values: { ...form.values, [o.id]: c.value } })}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ),
                  )}
                </div>
                {!('error' in built) && built.runs && (
                  <span className="field-hint">
                    Runs <code className="mono">{built.runs}</code>.{' '}
                    <a href={preset.docsUrl} target="_blank" rel="noopener noreferrer">
                      About {preset.title}
                    </a>
                  </span>
                )}
              </fieldset>
            )}

            {form.pick === CUSTOM && (
              <>
                <div className="field">
                  <span className="label" id="add-conn-how">
                    How HQ reaches it
                  </span>
                  <div className="conn-modes" role="group" aria-labelledby="add-conn-how">
                    {TRANSPORTS.map((t) => (
                      <button key={t.value} type="button" className={`seg${form.transport === t.value ? ' on' : ''}`} aria-pressed={form.transport === t.value} onClick={() => set({ transport: t.value })}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {form.transport !== 'stdio' ? (
                  <>
                    <label className="field">
                      <span className="label">Server URL</span>
                      <input className="mono" value={form.url} spellCheck={false} placeholder="https://mcp.example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
                      <span className="field-hint">If it uses a browser sign-in, you log in from the Connections page after adding it.</span>
                    </label>
                    <KeyValueRows label="Headers" addLabel="Add header" namePlaceholder="Authorization" valuePlaceholder="Bearer ..." rows={form.headers} onChange={(headers) => set({ headers })} />
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span className="label">Program</span>
                      <input className="mono" value={form.command} spellCheck={false} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
                      <span className="field-hint">One program name, like npx or uvx, or the full path to one. No shells.</span>
                    </label>
                    <label className="field">
                      <span className="label">Arguments, one per line</span>
                      <textarea className="mono" rows={4} value={form.argsText} spellCheck={false} placeholder={'-y\nsome-mcp-server'} onChange={(e) => set({ argsText: e.target.value })} />
                      {secretArgs(splitArgs(form.argsText)).length > 0 && (
                        <span className="field-hint bad">An argument looks like a token. Other programs on this PC can read arguments while the server runs. Put tokens under Environment instead.</span>
                      )}
                    </label>
                    <KeyValueRows label="Environment" addLabel="Add variable" namePlaceholder="API_TOKEN" valuePlaceholder="value" rows={form.env} onChange={(env) => set({ env })} />
                  </>
                )}
              </>
            )}

            {problem && tried && (
              <p className="field-hint bad" role="alert">
                {problem}
              </p>
            )}
          </>
        )}

        {step === 'review' && preview && (
          <>
            <div className="field">
              <span className="label">Saved in</span>
              <span className="mono add-conn-where">{preview.location}</span>
            </div>
            <div className="field">
              <span className="label">What gets saved</span>
              <pre className="conn-review">{preview.preview}</pre>
              <span className="field-hint">
                Secrets show as •••. They go to Claude Code's settings only, never into HQ's data or logs. Names like Authorization or API_TOKEN count as secret even unticked.
              </span>
            </div>
            {preview.runs && (
              <p className="banner warning">
                {isCustomCommand
                  ? 'This runs a program on your PC each time a desk or a check uses it. Only add commands you trust.'
                  : 'This runs on your PC each time a desk or a check uses it. The first time, npx downloads the package from npm.'}
              </p>
            )}
            {preview.warnings.map((w) => (
              <p key={w} className="banner warning">
                {w}
              </p>
            ))}
            <p className="field-hint">After adding, HQ checks it once: it connects and lists the tools, and calls none.</p>
            {isCustomCommand && (
              <label className="check">
                <input type="checkbox" checked={form.trust} onChange={(e) => setForm((f) => ({ ...f, trust: e.target.checked }))} /> I trust this command
              </label>
            )}
          </>
        )}

        {error && <p className="banner danger">{error}</p>}
      </div>
    </Modal>
  );
}

interface RowsProps {
  label: string;
  addLabel: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
}

/** Name and value pairs; a value marked secret is typed into a password box. */
function KeyValueRows({ label, addLabel, namePlaceholder, valuePlaceholder, rows, onChange }: RowsProps) {
  const edit = (i: number, patch: Partial<KeyValue>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="field">
      <span className="label">{label}</span>
      {rows.length > 0 && (
        <ul className="kv-rows">
          {rows.map((r, i) => (
            <li key={i} className="kv-row">
              <input className="mono" aria-label={`${label} ${i + 1} name`} value={r.name} spellCheck={false} placeholder={namePlaceholder} onChange={(e) => edit(i, { name: e.target.value })} />
              <input
                className="mono"
                aria-label={`${label} ${i + 1} value`}
                type={r.secret ? 'password' : 'text'}
                autoComplete={r.secret ? 'new-password' : 'off'}
                value={r.value}
                spellCheck={false}
                placeholder={valuePlaceholder}
                onChange={(e) => edit(i, { value: e.target.value })}
              />
              <label className="check" title="Hide it on screen and keep it out of every log">
                <input type="checkbox" aria-label={`${label} ${i + 1} is secret`} checked={Boolean(r.secret)} onChange={(e) => edit(i, { secret: e.target.checked })} /> Secret
              </label>
              <button type="button" className="icon-btn sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="link-btn kv-add" disabled={rows.length >= 20} onClick={() => onChange([...rows, blankRow()])}>
        <Plus size={14} aria-hidden /> {addLabel}
      </button>
    </div>
  );
}
