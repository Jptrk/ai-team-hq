import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { checkLimit, LIMIT_GROUPS, LIMIT_KEYS, LIMITS, type LimitGroup, type LimitKey, type LimitsPatch, type LimitsResponse, type LimitSpec, type LimitValue } from '../../shared/limits';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';
import { refocus } from '../ui/ConfirmInline';

const MINUTE = 60_000;

const GROUPS: Record<LimitGroup, { title: string; hint?: string }> = {
  chat: { title: 'Desk chat', hint: 'Threads keep pausing for you to resume? Raise these.' },
  team: { title: 'Team' },
  claude: { title: 'Claude desk runs', hint: 'A run that reaches one of these stops.' },
  gpt: { title: 'GPT desk runs', hint: 'A run that reaches its tool calls stops.' },
  time: { title: 'When a run stops', hint: 'Every desk run, Claude or GPT. A run stops for going quiet, not for being busy.' },
};

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The number you type: minutes for a time, dollars or a count otherwise. */
function toText(key: LimitKey, value: number): string {
  return String(LIMITS[key].unit === 'ms' ? Math.round((value / MINUTE) * 100) / 100 : value);
}

/** What you typed, as the limit keeps it, or null when it is not a value in range. */
function fromText(key: LimitKey, text: string): number | null {
  if (!text.trim()) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const unit = LIMITS[key].unit;
  if (unit === 'count' && !Number.isInteger(n)) return null;
  return checkLimit(key, unit === 'ms' ? Math.round(n * MINUTE) : n);
}

/** A value in words: "6", "$1.5", "20 min". */
function shown(key: LimitKey, value: number): string {
  const unit = LIMITS[key].unit;
  if (unit === 'usd') return `$${value}`;
  if (unit === 'ms') return `${toText(key, value)} min`;
  return String(value);
}

function rangeText(key: LimitKey): string {
  const spec: LimitSpec = LIMITS[key];
  if (spec.unit === 'ms') return `from ${toText(key, spec.min)} to ${toText(key, spec.max)} minutes`;
  if (spec.unit === 'usd') return `from $${spec.min} to $${spec.max}`;
  return `a whole number from ${spec.min} to ${spec.max}`;
}

/**
 * HQ's limits, for every project: how far desks go on their own before a thread pauses, a run stops or a ticket
 * comes to you. Yours here win over .env; Reset goes back to .env or HQ's default. A change counts from the next
 * check, with no restart.
 */
export function LimitsSettings({ notify }: { notify: Notify }) {
  const [data, setData] = useState<LimitsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Only what you changed and haven't saved. Everything else shows the saved value.
  const [drafts, setDrafts] = useState<Partial<Record<LimitKey, string>>>({});
  const [busy, setBusy] = useState(false);
  // Save, Discard and Reset take away the button that had focus: it goes to a field instead (see the effect below).
  const inputs = useRef<Partial<Record<LimitKey, HTMLInputElement | null>>>({});
  const [focusTo, setFocusTo] = useState<{ key: LimitKey } | null>(null);

  useEffect(() => {
    // After the render that took the button away. refocus leaves focus alone if you already moved it.
    if (focusTo) refocus(inputs.current[focusTo.key] ?? null);
  }, [focusTo]);

  const load = useCallback(async () => {
    try {
      setData(await api.limits());
      setLoadError(null);
    } catch (e) {
      setLoadError(msg(e, 'Could not load the limits'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return (
      <>
        <h2 className="account-heading">Limits</h2>
        {loadError ? (
          <p className="banner danger" role="alert">
            {loadError}
          </p>
        ) : (
          <p className="muted">Loading the limits...</p>
        )}
      </>
    );
  }

  // A draft that says the same as the saved value is no change.
  const changed = LIMIT_KEYS.filter((k) => drafts[k] !== undefined && fromText(k, drafts[k]!) !== data[k].value);
  const bad = changed.filter((k) => fromText(k, drafts[k]!) === null);
  /** A limit as it would be once saved: a good draft, or the saved value. */
  const pending = (k: LimitKey) => (drafts[k] !== undefined ? (fromText(k, drafts[k]!) ?? data[k].value) : data[k].value);
  const capUnderTool = pending('runTimeoutMs') < pending('toolIdleMs');

  /**
   * Saves the patch. sent: the drafts as they were when you pressed the button. Only those go once it saved: what
   * you typed meanwhile stays. focus: the field that gets focus once the button that had it is gone.
   */
  const send = async (patch: LimitsPatch, done: string, sent: Partial<Record<LimitKey, string>>, focus: LimitKey) => {
    setBusy(true);
    setActionError(null);
    try {
      setData(await api.setLimits(patch));
      setDrafts((d) => {
        const next = { ...d };
        for (const k of Object.keys(patch) as LimitKey[]) if (next[k] === sent[k]) delete next[k];
        return next;
      });
      setFocusTo({ key: focus });
      notify(done, { tone: 'success' });
    } catch (e) {
      const text = msg(e, 'Could not save the limits');
      setActionError(text);
      // The banner is at the top of a long page; Save is at the bottom. Say it where you are too.
      notify(text, { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (busy || bad.length || !changed.length) return;
    const patch: LimitsPatch = {};
    for (const k of changed) patch[k] = fromText(k, drafts[k]!);
    const sent = Object.fromEntries(changed.map((k) => [k, drafts[k]]));
    void send(patch, changed.length === 1 ? `${LIMITS[changed[0]].label}: ${shown(changed[0], patch[changed[0]]!)}` : `${changed.length} limits saved`, sent, changed[0]);
  };

  // A draft in that row goes too, unless you change it while Reset saves.
  const reset = (k: LimitKey) => void send({ [k]: null }, `${LIMITS[k].label}: back to ${shown(k, data[k].fallback)}`, { [k]: drafts[k] }, k);

  const discard = () => {
    setDrafts({});
    if (changed.length) setFocusTo({ key: changed[0] });
  };

  return (
    <>
      <h2 className="account-heading">Limits</h2>
      <p className="field-hint limits-intro">
        For every project, from the next check: no restart. What you set here wins over .env. Reset goes back to .env, or to HQ's default.
      </p>
      {actionError && (
        <p className="banner danger account-error" role="alert">
          {actionError}
        </p>
      )}
      <form
        className="limits"
        // The checks below say what is wrong in words; the browser's own popups would block Save for a valid 7.5 minutes.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {LIMIT_GROUPS.map((g) => (
          <section key={g} className="limits-group" aria-labelledby={`limits-${g}`}>
            <h3 id={`limits-${g}`} className="account-subheading">
              {GROUPS[g].title}
            </h3>
            <div className="card-box account-card">
              {GROUPS[g].hint && <p className="field-hint">{GROUPS[g].hint}</p>}
              {LIMIT_KEYS.filter((k) => LIMITS[k].group === g).map((k) => (
                <LimitRow
                  key={k}
                  k={k}
                  current={data[k]}
                  draft={drafts[k]}
                  busy={busy}
                  onDraft={(text) => setDrafts((d) => ({ ...d, [k]: text }))}
                  onReset={() => reset(k)}
                  inputRef={(el) => {
                    inputs.current[k] = el;
                  }}
                />
              ))}
              {g === 'time' && capUnderTool && (
                <p className="field-hint">
                  <span className="warn">Whole run is shorter than Tool call limit:</span> a slow tool call is cut off by the whole-run limit first.
                </p>
              )}
            </div>
          </section>
        ))}
        {changed.length > 0 && (
          <div className="form-actions limits-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || bad.length > 0}>
              {busy ? 'Saving...' : changed.length === 1 ? 'Save change' : `Save ${changed.length} changes`}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={discard}>
              Discard
            </button>
            {bad.length > 0 && <span className="field-hint bad">Fix the values marked in red first.</span>}
          </div>
        )}
      </form>
    </>
  );
}

function LimitRow({
  k,
  current,
  draft,
  busy,
  onDraft,
  onReset,
  inputRef,
}: {
  k: LimitKey;
  current: LimitValue;
  draft: string | undefined;
  busy: boolean;
  onDraft: (text: string) => void;
  onReset: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
}) {
  const id = useId();
  const spec: LimitSpec = LIMITS[k];
  const text = draft ?? toText(k, current.value);
  const invalid = draft !== undefined && fromText(k, draft) === null;
  const from = current.fallbackSource === 'env' ? `${shown(k, current.fallback)} from .env` : `HQ's default, ${shown(k, current.fallback)}`;
  return (
    <div className="limit-row">
      <div className="limit-text">
        <label htmlFor={id} className="limit-label">
          {spec.label}
          {/* The $ and min beside the field are for the eye; a screen reader hears the unit with the name. */}
          {spec.unit !== 'count' && <span className="sr-only">{spec.unit === 'usd' ? ', in dollars' : ', in minutes'}</span>}
        </label>
        <p id={`${id}-hint`} className="field-hint">
          {spec.hint}
        </p>
        <p className="field-hint limit-source">
          {current.source === 'you' ? (
            <>
              Set here.{' '}
              <button type="button" className="link-btn" disabled={busy} onClick={onReset} aria-label={`Reset ${spec.label}`}>
                Reset
              </button>{' '}
              to {from}.
            </>
          ) : current.source === 'env' ? (
            <>
              From .env (<span className="mono">{spec.env}</span>). HQ's default is {shown(k, spec.default)}.
            </>
          ) : (
            <>
              HQ's default. In .env: <span className="mono">{spec.env}</span>.
            </>
          )}
        </p>
        {invalid && (
          <p id={`${id}-error`} className="field-hint bad">
            {spec.label}: {rangeText(k)}.
          </p>
        )}
      </div>
      {/* A slot each side for the unit, empty or not, so every field lines up. */}
      <div className="limit-input">
        <span className="limit-unit" aria-hidden>
          {spec.unit === 'usd' ? '$' : ''}
        </span>
        <input
          ref={inputRef}
          id={id}
          className="input"
          type="number"
          inputMode={spec.unit === 'count' ? 'numeric' : 'decimal'}
          min={spec.unit === 'ms' ? spec.min / MINUTE : spec.min}
          max={spec.unit === 'ms' ? spec.max / MINUTE : spec.max}
          step={spec.unit === 'usd' ? 0.1 : 1}
          value={text}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={(e) => onDraft(e.target.value)}
        />
        <span className="limit-unit" aria-hidden>
          {spec.unit === 'ms' ? 'min' : ''}
        </span>
      </div>
    </div>
  );
}
