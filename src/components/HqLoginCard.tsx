import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';

/** HQ's own login on the Accounts page: who you are logged in as, and a new password. A change logs out your other browsers. */
export function HqLoginCard({ name, notify }: { name: string; notify: Notify }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = again.length > 0 && again !== next;
  const ready = current && next && again && !mismatch;

  const close = () => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setAgain('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      notify('Password changed. Your other browsers are logged out.', { tone: 'success' });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="account-heading">HQ login</h2>
      <div className="card-box account-card">
        <div className="account-who">
          <span className="account-icon on" aria-hidden>
            <KeyRound size={20} />
          </span>
          <div className="account-who-text">
            <p className="account-name">{name}</p>
            <p className="muted small">You log in to HQ with this name. Log out from the menu under your picture, top right.</p>
          </div>
        </div>
        {open ? (
          <form className="account-password" onSubmit={(e) => void submit(e)}>
            {/* Tells a password manager whose password this is. */}
            <input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
            <label className="field">
              <span className="label">Current password</span>
              <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
            </label>
            <label className="field">
              <span className="label">New password</span>
              <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="hq-new-password-hint" required />
              <span id="hq-new-password-hint" className="field-hint">
                At least 12 characters.
              </span>
            </label>
            <label className="field">
              <span className="label">New password again</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'hq-again-hint' : undefined}
                required
              />
              {mismatch && (
                <span id="hq-again-hint" className="field-hint bad" role="alert">
                  Not the same as the new password.
                </span>
              )}
            </label>
            {error && (
              <p className="banner danger" role="alert">
                {error}
              </p>
            )}
            <div className="account-actions">
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !ready}>
                {busy ? 'Saving...' : 'Change password'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="account-actions">
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setOpen(true)}>
              Change password
            </button>
          </div>
        )}
      </div>
    </>
  );
}
