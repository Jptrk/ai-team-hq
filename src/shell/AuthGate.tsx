import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatus } from '../../shared/types';
import { api, setUnauthorizedHandler } from '../api';
import { App } from '../App';
import { LoginScreen } from './LoginScreen';

const RETRY_MS = 3000;

/**
 * HQ's login, in front of everything (server/auth.ts). App, and its polling, mount only once you are logged in. Any
 * 401 unmounts it: the session ended, so nothing keeps asking the server for data it won't give.
 */
export function AuthGate() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<{ text: string; tries: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // You pressed Log out: the polls still in flight answer 401, which must not read as "your session ended".
  const leaving = useRef(false);

  const load = useCallback(() => {
    api.authStatus().then(
      (s) => {
        setError(null);
        setStatus(s);
      },
      (e: unknown) => setError((prev) => ({ text: e instanceof Error ? e.message : 'HQ did not answer', tries: (prev?.tries ?? 0) + 1 })),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // HQ not answering yet (starting, or restarting after an edit): ask again.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(load, RETRY_MS);
    return () => clearTimeout(t);
  }, [error, load]);

  const signedIn = status?.signedIn === true;
  useEffect(() => {
    if (!signedIn) return;
    leaving.current = false;
    setUnauthorizedHandler(() => {
      if (leaving.current) return;
      setNotice('Your session ended. Log in again.');
      setStatus((s) => s && { hasUser: s.hasUser, canSetup: s.canSetup, signedIn: false });
    });
    return () => setUnauthorizedHandler(null);
  }, [signedIn]);

  const logout = useCallback(async () => {
    leaving.current = true;
    try {
      const next = await api.logOut();
      setNotice(null);
      setStatus(next);
    } catch (e) {
      leaving.current = false;
      throw e;
    }
  }, []);

  if (!status) {
    return (
      <div className="boot">
        <span className="wordmark-mark" aria-hidden>
          HQ
        </span>
        <p className="muted">{error ? `Cannot reach HQ: ${error.text}` : 'Opening HQ...'}</p>
      </div>
    );
  }
  if (status.signedIn) return <App loginName={status.name ?? ''} onLogout={logout} />;
  return (
    <LoginScreen
      status={status}
      notice={notice}
      onDone={(s) => {
        setNotice(null);
        setStatus(s);
      }}
    />
  );
}
