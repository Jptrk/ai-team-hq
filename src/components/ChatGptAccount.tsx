import { Check, Copy, ExternalLink, LogOut, MessageSquare, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatGptPlanLabel, safeOpenAiUrl } from '../../shared/account';
import type { ChatGptLogin, ChatGptResponse, ChatGptWindow, Meta } from '../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useFlags';
import { ConfirmInline, refocus } from '../ui/ConfirmInline';
import { accountHeld, clockTime } from '../util';
import { hostOf, timeLeft } from './connections/addForm';

interface Props {
  notify: Notify;
  /** The meta changed (opt-in, sign-in or sign-out): the header and banners follow. */
  onChanged: () => void;
  meta: Meta | null;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * Your ChatGPT account, for GPT desks: sign in with your ChatGPT plan (not an API key), see who is signed in and how
 * much of the plan's usage is left, say whether GPT desks may run on it, pick their model, and sign out. HQ's own
 * Codex does the sign-in, separate from any Codex CLI you use; HQ only shows OpenAI's page or the device code.
 */
export function ChatGptAccount({ notify, onChanged, meta }: Props) {
  const [data, setData] = useState<ChatGptResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const signInButton = useRef<HTMLButtonElement>(null);
  // An answer from before a change you made may land after it: only the newest counts.
  const version = useRef(0);

  const load = useCallback(async (check = false) => {
    const v = ++version.current;
    try {
      const res = await api.chatGpt(check);
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

  // While a sign-in runs, follow it. Coming back to the page uses the server's recent answer: each fresh one starts Codex.
  const signingIn = Boolean(data?.login && data.login.state !== 'failed');
  useEffect(() => {
    if (!signingIn) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [signingIn, load]);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Say so once a sign-in from HQ works: a new signedInAt, not the one there when the page opened.
  const seenSignIn = useRef<{ at?: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    if (!seenSignIn.current) {
      seenSignIn.current = { at: data.signedInAt };
      return;
    }
    if (!data.signedInAt || data.signedInAt === seenSignIn.current.at) return;
    seenSignIn.current = { at: data.signedInAt };
    const who = data.account?.email ? `Signed in to ChatGPT as ${data.account.email}` : 'Signed in to ChatGPT';
    // Only when ChatGPT's account problem (its login failed) holds work: a Claude one waits for a Claude sign-in.
    notify(accountHeld(meta?.paused, 'gpt') ? `${who}. Press Resume to start held work.` : who, { tone: 'success' });
    onChanged();
  }, [data, meta, notify, onChanged]);

  // A sign-in that ends (done, failed or cancelled) takes its buttons with it: focus goes back to Sign in.
  const wasSigningIn = useRef(false);
  useEffect(() => {
    if (wasSigningIn.current && !signingIn) refocus(signInButton.current);
    wasSigningIn.current = signingIn;
  }, [signingIn]);

  /** One of your actions. Its error stays until you start another. */
  const act = async (fn: () => Promise<ChatGptResponse>, fallback: string, done?: (res: ChatGptResponse) => void): Promise<void> => {
    setBusy(true);
    setActionError(null);
    version.current++;
    try {
      const res = await fn();
      version.current++;
      setData(res);
      setLoadError(null);
      done?.(res);
    } catch (e) {
      setActionError(msg(e, fallback));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const signIn = (method: 'browser' | 'device') => {
    setConfirmOut(false);
    void act(() => api.startChatGptLogin(method), 'Could not start signing in');
  };
  const cancel = () => void act(api.cancelChatGptLogin, 'Could not cancel');
  const dismiss = () => void act(() => api.cancelChatGptLogin().catch(() => api.chatGpt()), 'Could not dismiss');

  if (!data) {
    return (
      <>
        <h2 className="account-heading">ChatGPT</h2>
        {loadError ? (
          <p className="banner danger" role="alert">
            {loadError}
          </p>
        ) : (
          <p className="muted">Asking HQ's Codex who is signed in...</p>
        )}
      </>
    );
  }

  const account = data.account;
  const signedIn = Boolean(account?.loggedIn);
  const plan = chatGptPlanLabel(account?.plan);
  const login = data.login;
  const live = data.runner === 'live';
  const model = data.models.find((m) => (data.model ? m.id === data.model : m.isDefault));
  const defaultModel = data.models.find((m) => m.isDefault);

  const setModel = (id: string) => {
    const next = id || null;
    const target = data.models.find((m) => (next ? m.id === next : m.isDefault));
    // An effort the new model doesn't have goes back to its default.
    const keepEffort = data.effort && target?.efforts.includes(data.effort);
    void act(() => api.setGptModel({ model: next, ...(keepEffort ? {} : { effort: null }) }), 'Could not save the model', () => onChanged());
  };

  return (
    <>
      <h2 className="account-heading">ChatGPT</h2>
      {loadError && (
        <p className="banner danger account-error" role="alert">
          {loadError}
        </p>
      )}
      {actionError && (
        <p className="banner danger account-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="card-box account-card">
        <div className="account-who">
          <span className={`account-icon${signedIn ? ' on' : ''}`} aria-hidden>
            <MessageSquare size={20} />
          </span>
          <div className="account-who-text">
            {account === null ? (
              <>
                <p className="account-name">Codex did not answer</p>
                <p className="muted small">HQ asks the Codex that ships with it. Check again in a moment.</p>
              </>
            ) : signedIn ? (
              <>
                <p className="account-name">{account.email ?? 'Signed in'}</p>
                <p className="muted small">{plan ? `ChatGPT ${plan} plan` : 'Signed in to ChatGPT'}</p>
              </>
            ) : (
              <>
                <p className="account-name">Not signed in</p>
                <p className="muted small">Sign in with your ChatGPT account on OpenAI's own page, in your browser. HQ never sees your password or token.</p>
              </>
            )}
          </div>
        </div>

        {signedIn && data.usage && data.usage.length > 0 && <UsageWindows windows={data.usage} />}

        {login && login.state !== 'failed' && <LoginBox login={login} onCancel={cancel} />}
        {login?.state === 'failed' && (
          <div className="conn-login failed">
            <p className="conn-note bad" role="status">
              {login.error ?? 'Signing in failed.'}
            </p>
            <div className="conn-actions">
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={dismiss}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {!signingIn && (
          <>
            <div className="account-actions">
              <button ref={signInButton} type="button" className={`btn btn-sm ${signedIn ? 'btn-outline' : 'btn-primary'}`} disabled={busy} onClick={() => signIn('browser')}>
                {signedIn ? 'Switch account' : 'Sign in with ChatGPT'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => signIn('device')} title="Sign in from another device with a code">
                Use a code instead
              </button>
              {signedIn && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy || confirmOut} onClick={() => setConfirmOut(true)}>
                  <LogOut size={14} aria-hidden /> Sign out
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void act(() => api.chatGpt(true), 'Could not check')}>
                <RefreshCw size={14} aria-hidden /> Check again
              </button>
            </div>
            {!signedIn && <p className="field-hint">Signing in also turns on Run GPT desks on my ChatGPT login. A code works from any device, once ChatGPT allows device code sign-in (Settings, Security).</p>}
          </>
        )}
        {confirmOut && (
          <ConfirmInline
            title="Sign HQ out of ChatGPT?"
            confirmLabel="Sign out"
            busy={busy}
            onCancel={() => setConfirmOut(false)}
            onConfirm={() =>
              void act(api.signOutChatGpt, 'Could not sign out', () => {
                setConfirmOut(false);
                refocus(signInButton.current);
                notify('Signed out of ChatGPT');
                onChanged();
              })
            }
          >
            Only HQ's own Codex signs out; a Codex CLI you use keeps its login. GPT desks can't run until you sign in again.
          </ConfirmInline>
        )}
      </div>

      <h3 className="account-subheading">GPT desks on this login</h3>
      <div className="card-box account-card">
        <label className="account-use">
          <span className="switch">
            <input
              type="checkbox"
              checked={data.optedIn}
              disabled={busy || (!data.optedIn && account?.loggedIn === false)}
              onChange={(e) => {
                const on = e.target.checked;
                void act(() => api.useChatGptLogin(on), 'Could not save the setting', () => onChanged());
              }}
            />
            <span className="switch-track" aria-hidden />
          </span>
          <span>
            <span className="account-use-label">Run GPT desks on my ChatGPT login</span>
            <span className="muted small account-use-hint">
              {!data.optedIn && account?.loggedIn === false
                ? 'Sign in first.'
                : "GPT desk runs spend this plan's usage, the same limits Codex has. When a limit is hit, HQ holds automatic work until it resets."}
            </span>
          </span>
        </label>

        <div className="field-row gpt-model">
          <label className="field grow">
            <span className="label">Model</span>
            <select value={data.model ?? ''} disabled={busy || !data.models.length} onChange={(e) => setModel(e.target.value)}>
              <option value="">Codex default{defaultModel ? ` (${defaultModel.name})` : ''}</option>
              {data.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {data.model && !data.models.some((m) => m.id === data.model) && <option value={data.model}>{data.model}</option>}
            </select>
          </label>
          <label className="field grow">
            <span className="label">Effort</span>
            <select
              value={data.effort ?? ''}
              disabled={busy || !model?.efforts.length}
              onChange={(e) => void act(() => api.setGptModel({ effort: e.target.value || null }), 'Could not save the effort', () => onChanged())}
            >
              <option value="">Model default{model?.defaultEffort ? ` (${model.defaultEffort})` : ''}</option>
              {(model?.efforts ?? []).map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-hint">
          {data.models.length ? 'For every GPT desk, from its next run. More effort means more thinking and more of your plan.' : 'The model list shows once HQ has asked Codex: Check again.'}
        </p>

        {live && data.optedIn && signedIn && (
          <p className="muted small">
            Live: GPT desks run on {account?.email ?? 'your ChatGPT login'}
            {data.model ? ` with ${model?.name ?? data.model}` : ''}.
          </p>
        )}
        <p className="field-hint">
          GPT desks read and write files, use skills, HQ's tools, connections and (with HQ_WEB=1) web search, like Claude desks. A connection you sign in to in a browser needs its own sign-in for GPT, and claude.ai connectors stay Claude only. For your own use on this PC: OpenAI allows this sign-in
          for local apps, not for hosted or commercial services.
        </p>
      </div>
    </>
  );
}

/** The plan's 5-hour and weekly usage, as Codex last reported them. */
function UsageWindows({ windows }: { windows: ChatGptWindow[] }) {
  return (
    <ul className="gpt-usage">
      {windows.map((w) => (
        <li key={w.label}>
          <span className="gpt-usage-label">
            {w.label[0].toUpperCase() + w.label.slice(1)} limit: {w.usedPercent}% used
            {w.resetsAt && <span className="muted"> · resets {clockTime(w.resetsAt)}</span>}
          </span>
          <span className="gpt-usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent} aria-label={`${w.label} limit used`}>
            <span className={`gpt-usage-fill${w.usedPercent >= 90 ? ' high' : ''}`} style={{ width: `${w.usedPercent}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A sign-in waiting for you: OpenAI's page on this PC, or the device page and its code. */
function LoginBox({ login, onCancel }: { login: ChatGptLogin; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // Checked again here: the link signs in to your ChatGPT account.
  const url = safeOpenAiUrl(login.method === 'device' ? login.verificationUrl : login.authUrl);
  const hasUrl = Boolean(url);

  useEffect(() => {
    const at = document.activeElement;
    if (at && at !== document.body && at !== cancelButton.current) return;
    (link.current ?? cancelButton.current)?.focus();
  }, [hasUrl]);

  const waiting = login.state !== 'starting';
  return (
    <div className="conn-login">
      <p className="conn-note">
        <span role="status">
          {!waiting
            ? 'Starting sign-in...'
            : login.method === 'device'
              ? "Open OpenAI's device page on any device, sign in, and type the code below. HQ finishes on its own."
              : "Sign in on OpenAI's page in a browser on this PC. HQ finishes on its own when you're done."}
        </span>
        {waiting && <> {timeLeft(login.expiresAt)} left.</>}
      </p>
      {login.method === 'device' && login.userCode && (
        <p className="gpt-code">
          <span className="mono">{login.userCode}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(login.userCode!)
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy code'}
          </button>
        </p>
      )}
      <div className="conn-actions">
        {url && (
          <a ref={link} className="btn btn-sm btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden /> {login.method === 'device' ? 'Open device page' : 'Open ChatGPT sign-in'} ({hostOf(url)})
          </a>
        )}
        <button ref={cancelButton} type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
