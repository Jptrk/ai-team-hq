import { Check, Copy, ExternalLink, LogOut, RefreshCw, RotateCcw, UserRound } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { planLabel, safeClaudeUrl } from '../../shared/account';
import type { AccountLogin, AccountResponse, Meta } from '../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';
import { PageHeader } from '../shell/PageHeader';
import { ConfirmInline, refocus } from '../ui/ConfirmInline';
import { ChatGptAccount } from './ChatGptAccount';
import { hostOf, timeLeft } from './connections/addForm';

interface Props {
  notify: Notify;
  /** The meta changed (opt-in, sign-in or sign-out): the header and banners follow. */
  onChanged: () => void;
  meta: Meta | null;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** How Claude Code is signed in (`claude auth status`): a label for the account line, and the same in a sentence. */
const METHODS: Record<string, { label: string; phrase: string }> = {
  'claude.ai': { label: 'Claude subscription', phrase: 'a Claude subscription' },
  oauth_token: { label: 'Login token', phrase: 'a login token' },
  api_key_helper: { label: 'API key helper', phrase: 'an API key helper' },
  api_key: { label: 'API key', phrase: 'an API key' },
  third_party: { label: 'Bedrock or Vertex', phrase: 'Bedrock or Vertex' },
};

function methodLabel(method: string | undefined, noPlan: boolean): string | null {
  if (!method) return null;
  if (noPlan) return 'Claude account';
  return METHODS[method]?.label ?? method;
}

// Claude Code reports an Anthropic Console sign-in as claude.ai too, but with no plan: that is the only sign of it.
const NO_PLAN_NOTE =
  "Claude Code didn't report a subscription plan for this login. If it is an Anthropic Console account, desks spend API credits, not a subscription: Switch account to sign in with your Claude subscription.";

/** What desk runs on this login spend. Only a subscription has a usage window. */
function spendHint(method: string | undefined, noPlan: boolean): string {
  if (noPlan) return 'Desk runs use this login, the way Claude Code does.';
  if (method && method !== 'claude.ai') return 'Desk runs use this login, the way Claude Code does.';
  return 'Desk runs spend this subscription’s usage, the same limits Claude Code has. When a limit is hit, HQ holds automatic work until it resets.';
}

/** An action's error, and where it shows: at the top, or under the code field. */
interface ActionError {
  text: string;
  at: 'page' | 'code';
}

/**
 * Your accounts. Claude: sign in with your Claude subscription (not an API key), see who is signed in,
 * say whether desks may run on it, and sign out. Claude Code does the sign-in; HQ only shows its page.
 * ChatGPT, for GPT desks, is its own section (ChatGptAccount).
 */
export function AccountPage({ notify, onChanged, meta }: Props) {
  const [data, setData] = useState<AccountResponse | null>(null);
  // Two kinds of error: a load that failed (the next good load clears it), and an action that failed
  // (it stays until you start another, so a poll can't wipe it).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const signInButton = useRef<HTMLButtonElement>(null);
  // An answer from before a change you made may land after it: only the newest counts.
  const version = useRef(0);

  const load = useCallback(async (check = false) => {
    const v = ++version.current;
    try {
      const res = await api.account(check);
      if (v !== version.current) return;
      setData(res);
      setLoadError(null);
    } catch (e) {
      if (v === version.current) setLoadError(msg(e, 'Could not reach HQ'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a sign-in runs, follow it; and ask Claude Code again whenever you come back (from the browser
  // or a terminal). The server runs one check for many asks.
  const signingIn = Boolean(data?.login && data.login.state !== 'failed');
  useEffect(() => {
    if (!signingIn) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [signingIn, load]);
  useEffect(() => {
    const onFocus = () => void load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Say so once a sign-in from HQ works: a new signedInAt, not the one there when the page opened. A login
  // that merely went away (Cancel on Switch account) says nothing.
  const seenSignIn = useRef<{ at?: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    if (!seenSignIn.current) {
      seenSignIn.current = { at: data.signedInAt };
      return;
    }
    if (!data.signedInAt || data.signedInAt === seenSignIn.current.at) return;
    seenSignIn.current = { at: data.signedInAt };
    const who = data.account?.email ? `Signed in as ${data.account.email}` : 'Signed in to Claude';
    notify(meta?.paused?.by === 'account' ? `${who}. Press Resume to start held work.` : who, { tone: 'success' });
    onChanged();
  }, [data, meta, notify, onChanged]);

  // A sign-in that ends (done, failed or cancelled) takes its buttons with it: focus goes back to Sign in.
  const wasSigningIn = useRef(false);
  useEffect(() => {
    if (wasSigningIn.current && !signingIn) refocus(signInButton.current);
    wasSigningIn.current = signingIn;
  }, [signingIn]);

  /** One of your actions. Its error stays until you start another. True when it worked. */
  const act = async (fn: () => Promise<AccountResponse>, fallback: string, done?: (res: AccountResponse) => void, at: ActionError['at'] = 'page'): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    version.current++;
    try {
      const res = await fn();
      version.current++;
      setData(res);
      setLoadError(null);
      done?.(res);
      return true;
    } catch (e) {
      setActionError({ text: msg(e, fallback), at });
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const signIn = () => {
    setConfirmOut(false);
    void act(api.startAccountLogin, 'Could not start signing in');
  };
  const cancel = () => void act(api.cancelAccountLogin, 'Could not cancel');
  // A failed sign-in the server already dropped (after a minute) is gone too: just look again.
  const dismiss = () => void act(() => api.cancelAccountLogin().catch(() => api.account()), 'Could not dismiss');

  if (!data) {
    return (
      <section className="page narrow-page account">
        <PageHeader title="Accounts" />
        {loadError ? (
          <p className="banner danger" role="alert">
            {loadError}
          </p>
        ) : (
          <p className="muted">Asking Claude Code who is signed in...</p>
        )}
      </section>
    );
  }

  const account = data.account;
  const signedIn = Boolean(account?.loggedIn);
  const plan = planLabel(account?.plan);
  const noPlan = signedIn && account?.method === 'claude.ai' && !account.plan && !data.envToken;
  const method = methodLabel(account?.method, noPlan);
  const live = data.runner === 'live';
  // The header's meta follows a change on either account; this page's own data only the Claude one.
  const restart = meta?.restartToGoLive ?? data.restartToGoLive;
  const login = data.login;
  // Signed in, but not with a Claude subscription. A CLAUDE_CODE_OAUTH_TOKEN reads as a token: the note below covers it.
  const otherMethod = signedIn && account?.method && account.method !== 'claude.ai' && !(data.envToken && account.method === 'oauth_token') ? account.method : null;
  // Live on the login, and it went away: work in Claude projects waits while GPT ones can run, and fails otherwise.
  const liveNoLogin = live && data.optedIn && !data.apiKey && account?.loggedIn === false;
  // Switched off while live: desks stay on the login until a restart, but only when HQ started with the yes (claudeAtStart).
  const backToSim = signedIn && !data.optedIn && live && !data.apiKey && !data.optInByEnv && data.claudeAtStart;
  // A code error shows under the field while it is there; anything else at the top.
  const codeError = actionError?.at === 'code' && login?.state === 'waiting' ? actionError.text : null;
  const pageError = actionError && (actionError.at === 'page' || !login) ? actionError.text : null;

  return (
    <section className="page narrow-page account">
      <PageHeader
        title="Accounts"
        subtitle="Desks run on your own logins, no API key needed: Claude projects on your Claude subscription, GPT projects on your ChatGPT plan."
      />
      {loadError && (
        <p className="banner danger account-error" role="alert">
          {loadError}
        </p>
      )}
      {pageError && (
        <p className="banner danger account-error" role="alert">
          {pageError}
        </p>
      )}
      {liveNoLogin && (
        <p className="banner danger account-error" role="status">
          HQ is live but has no Claude login:{' '}
          {meta?.claudeReady === false ? 'work in Claude projects waits until you sign in again.' : 'runs in Claude projects fail. Sign in again.'}
        </p>
      )}
      {data.idle && !restart && (
        <p className="banner danger account-error" role="status">
          HQ has no login to run desks on, so they are idle, and there is no sim in your projects. Sign in to Claude or ChatGPT below, turn on running desks on it, then restart HQ.
        </p>
      )}

      {restart && (
        <p className="banner accent account-error" role="status">
          <RotateCcw size={15} aria-hidden /> Restart HQ to go live: stop it in its terminal (Ctrl+C) and start it again (npm start or npm run dev).
        </p>
      )}

      <h2 className="account-heading">Claude</h2>
      <div className="card-box account-card">
        <div className="account-who">
          <span className={`account-icon${signedIn ? ' on' : ''}`} aria-hidden>
            <UserRound size={20} />
          </span>
          <div className="account-who-text">
            {account === null ? (
              <>
                <p className="account-name">Claude Code did not answer</p>
                <p className="muted small">HQ asks the Claude Code that ships with it. Check again in a moment.</p>
              </>
            ) : signedIn ? (
              <>
                <p className="account-name">{account.email ?? 'Signed in'}</p>
                <p className="muted small">{[method, plan && `${plan} plan`, account.org].filter(Boolean).join(' · ') || 'Signed in to Claude'}</p>
              </>
            ) : (
              <>
                <p className="account-name">Not signed in</p>
                <p className="muted small">Sign in with your Claude account. You sign in on Claude's own page, in your browser; HQ never sees your password or token.</p>
              </>
            )}
          </div>
        </div>

        {noPlan && <p className="banner warning">{NO_PLAN_NOTE}</p>}
        {otherMethod && <p className="banner warning">Claude Code on this PC is signed in with {METHODS[otherMethod]?.phrase ?? otherMethod}, not a Claude subscription.</p>}
        {data.envToken && <p className="field-hint">CLAUDE_CODE_OAUTH_TOKEN is set, so Claude Code uses that token; signing out here can't remove it.</p>}

        {login && login.state !== 'failed' && (
          <LoginBox
            login={login}
            busy={busy}
            codeError={codeError}
            onCancel={cancel}
            onCode={(code) => act(() => api.sendAccountCode(code), 'Could not finish signing in', undefined, 'code')}
          />
        )}
        {login?.state === 'failed' && <LoginFailed login={login} busy={busy} onDismiss={dismiss} />}
        {!signingIn && (
          <>
            <div className="account-actions">
              <button ref={signInButton} type="button" className={`btn btn-sm ${signedIn ? 'btn-outline' : 'btn-primary'}`} disabled={busy} onClick={signIn}>
                {signedIn ? 'Switch account' : 'Sign in with Claude'}
              </button>
              {/* Stays while the question is open, so focus can come back to it. */}
              {signedIn && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy || confirmOut} onClick={() => setConfirmOut(true)}>
                  <LogOut size={14} aria-hidden /> Sign out
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void act(() => api.account(true), 'Could not check')}>
                <RefreshCw size={14} aria-hidden /> Check again
              </button>
            </div>
            {!signedIn && <p className="field-hint">Signing in also turns on Run desks on my Claude login.</p>}
          </>
        )}
        {confirmOut && (
          <ConfirmInline
            title="Sign out of Claude on this PC?"
            confirmLabel="Sign out"
            busy={busy}
            onCancel={() => setConfirmOut(false)}
            onConfirm={() =>
              void act(api.signOutAccount, 'Could not sign out', () => {
                setConfirmOut(false);
                // The Sign out button goes with the login: focus Sign in instead.
                refocus(signInButton.current);
                notify('Signed out of Claude');
                onChanged();
              })
            }
          >
            Every Claude Code on this PC shares this login: terminals, editors and HQ are all signed out. Desks can't run on it until you sign in again.
            {live && !data.apiKey && ' Desk runs going now will fail.'}
          </ConfirmInline>
        )}
        {signedIn && !signingIn && <p className="field-hint">Signing in again or switching account replaces the login every Claude Code on this PC uses.</p>}
      </div>

      <h3 className="account-subheading">Claude desks on this login</h3>
      <div className="card-box account-card">
        <label className="account-use">
          <span className="switch">
            <input
              type="checkbox"
              checked={data.optedIn}
              // Only a known "not signed in" stops a yes: when Claude Code didn't answer, the server checks.
              disabled={busy || data.optInByEnv || (!data.optedIn && account?.loggedIn === false)}
              onChange={(e) => {
                const on = e.target.checked;
                void act(() => api.useClaudeLogin(on), 'Could not save the setting', () => onChanged());
              }}
            />
            <span className="switch-track" aria-hidden />
          </span>
          <span>
            <span className="account-use-label">Run desks on my Claude login</span>
            <span className="muted small account-use-hint">
              {data.optInByEnv
                ? 'On because HQ_RUNNER=claude is set in .env. Remove it there to control this here.'
                : !data.optedIn && account?.loggedIn === false
                  ? 'Sign in first.'
                  : spendHint(account?.method, noPlan)}
            </span>
          </span>
        </label>

        {data.apiKey && (
          <p className="banner warning">ANTHROPIC_API_KEY is set in .env, so desks run on that key, not on this login. Remove the key from .env and restart HQ to use your subscription.</p>
        )}
        {data.simByEnv && <p className="banner warning">HQ_RUNNER=sim is set in .env, so HQ stays in sim. Remove it from .env and restart HQ to go live.</p>}
        {backToSim && (
          <p className="banner" role="status">
            Desks keep running on the login until HQ restarts; then they stay idle until you turn it back on.
          </p>
        )}
        {live && signedIn && !data.optedIn && !data.apiKey && !data.claudeAtStart && (
          <p className="muted small">Off: work in Claude projects waits, without touching this login, until you turn it on.</p>
        )}
        {live && data.optedIn && !data.apiKey && signedIn && (
          <p className="muted small">
            Live{meta ? ` on ${meta.model}` : ''}: Claude desks run on {account?.email ?? 'your Claude login'}.
          </p>
        )}
        <p className="field-hint">For your own use on this PC. Anthropic's Agent SDK docs say apps offered to other people may not run on claude.ai logins.</p>
      </div>

      <ChatGptAccount notify={notify} onChanged={onChanged} meta={meta} />
    </section>
  );
}

/** A sign-in that failed: why, and Dismiss. Sign in with Claude under it tries again. */
function LoginFailed({ login, busy, onDismiss }: { login: AccountLogin; busy: boolean; onDismiss: () => void }) {
  return (
    <div className="conn-login failed">
      <p className="conn-note bad" role="status">
        {login.error ?? 'Signing in failed.'}
      </p>
      <div className="conn-actions">
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function LoginBox({
  login,
  busy,
  codeError,
  onCancel,
  onCode,
}: {
  login: AccountLogin;
  busy: boolean;
  codeError: string | null;
  onCancel: () => void;
  onCode: (code: string) => Promise<boolean>;
}) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  // Checked again here: the link signs in to your Claude account.
  const url = safeClaudeUrl(login.authUrl);
  const manual = safeClaudeUrl(login.manualUrl);
  const hasUrl = Boolean(url);

  // Focus the next step: Cancel while the page is coming, then the sign-in page. Never away from something
  // else you moved to.
  useEffect(() => {
    const at = document.activeElement;
    if (at && at !== document.body && at !== cancelButton.current) return;
    (link.current ?? cancelButton.current)?.focus();
  }, [hasUrl]);

  return (
    <div className="conn-login">
      {/* Only the sentence is announced: the countdown changes on every poll. */}
      <p className="conn-note">
        <span role="status">{login.state === 'starting' ? 'Starting sign-in...' : "Sign in on Claude's page in your browser. HQ finishes on its own when you're done."}</span>
        {login.state !== 'starting' && <> {timeLeft(login.expiresAt)} left.</>}
      </p>
      <div className="conn-actions">
        {url && (
          <a ref={link} className="btn btn-sm btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden /> Open Claude sign-in ({hostOf(url)})
          </a>
        )}
        <button ref={cancelButton} type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {manual && (
        // Open from the start when there is no page that comes back by itself.
        <details className="account-manual" open={!url}>
          <summary>Signing in on another device, or the page didn't come back to HQ?</summary>
          <p className="field-hint account-manual-link">
            <span>
              Open{' '}
              <a href={manual} target="_blank" rel="noopener noreferrer">
                this sign-in page <ExternalLink size={12} aria-hidden />
              </a>{' '}
              instead. When you're done it shows a code: paste it here.
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(manual)
                  .then(() => setCopied(true))
                  .catch(() => undefined);
              }}
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy link'}
            </button>
          </p>
          <form
            className="account-code"
            onSubmit={(e) => {
              e.preventDefault();
              const pasted = code.trim();
              // The field keeps what you pasted until Claude Code took it, so a typo can be fixed.
              if (pasted) void onCode(pasted).then((ok) => ok && setCode(''));
            }}
          >
            <input
              className="input mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code"
              aria-label="Sign-in code"
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? errorId : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="btn btn-sm btn-outline" disabled={busy || !code.trim()}>
              Finish signing in
            </button>
          </form>
          {codeError && (
            <p id={errorId} className="field-hint bad" role="alert">
              {codeError}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
