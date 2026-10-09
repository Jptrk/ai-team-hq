import { useEffect, useState, type FormEvent } from 'react';
import type { AuthStatus } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  status: AuthStatus;
  /** The server's answer to a setup or a login. */
  onDone: (status: AuthStatus) => void;
  /** Why you are here again, e.g. the session ended. */
  notice?: string | null;
}

function Head({ title }: { title: string }) {
  return (
    <div className="auth-head">
      <span className="wordmark-mark" aria-hidden>
        HQ
      </span>
      <h1 id="auth-title" className="auth-title">
        {title}
      </h1>
    </div>
  );
}

/** HQ's login screen. With no account yet, the setup screen, which only works on the PC HQ runs on. */
export function LoginScreen({ status, onDone, notice }: Props) {
  const setup = !status.hasUser;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The app's title (e.g. the page you were on) would otherwise stay after a logout.
  useEffect(() => {
    document.title = `${setup ? 'Set up' : 'Log in'} · AI Team HQ`;
  }, [setup]);

  if (setup && !status.canSetup) {
    return (
      <main className="auth-page">
        <section className="form auth-card" aria-labelledby="auth-title">
          <Head title="Set up HQ" />
          <p className="muted">HQ has no account yet. Open it on the PC it runs on to make one.</p>
        </section>
      </main>
    );
  }

  const mismatch = setup && again.length > 0 && again !== password;
  const ready = name.trim() && password && (!setup || (again && !mismatch));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await (setup ? api.setupAccount(name, password) : api.logIn(name, password)));
    } catch (err) {
      setError(err instanceof Error ? err.message : setup ? 'Could not set up HQ' : 'Could not log in');
      setBusy(false);
      // Another setup got there first (another tab or browser): this one never can. Ask again, so the screen turns
      // into the login form (or HQ, when that setup was in this browser), with the server's message still showing.
      if (setup && err instanceof ApiError && err.status === 409) {
        api.authStatus().then(onDone, () => undefined);
      }
    }
  };

  return (
    <main className="auth-page">
      <form className="form auth-card" aria-labelledby="auth-title" onSubmit={(e) => void submit(e)}>
        <Head title={setup ? 'Set up HQ' : 'Log in to HQ'} />
        {setup && <p className="muted small">Make the account you log in with. HQ asks for it in every browser, on this PC too.</p>}
        {notice && !setup && (
          <p className="banner accent" role="status">
            {notice}
          </p>
        )}
        <label className="field">
          <span className="label">Name</span>
          <input className="input" name="username" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus required />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            name="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={setup ? 'auth-password-hint' : undefined}
            required
          />
          {setup && (
            <span id="auth-password-hint" className="field-hint">
              At least 12 characters. A few words in a row is long and easy to remember.
            </span>
          )}
        </label>
        {setup && (
          <label className="field">
            <span className="label">Password again</span>
            <input
              className="input"
              type="password"
              name="password-again"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? 'auth-again-hint' : undefined}
              required
            />
            {mismatch && (
              <span id="auth-again-hint" className="field-hint bad" role="alert">
                Not the same as the password above.
              </span>
            )}
          </label>
        )}
        {error && (
          <p className="banner danger" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy ? (setup ? 'Setting up...' : 'Logging in...') : setup ? 'Set up HQ' : 'Log in'}
        </button>
        {!setup && <p className="muted small">Forgot the password? See "Lost password" in HQ's README.</p>}
      </form>
    </main>
  );
}
