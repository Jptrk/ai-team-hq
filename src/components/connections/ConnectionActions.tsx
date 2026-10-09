import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { safeAuthUrl } from '../../../shared/mcpSpec';
import type { ConnectionRow, McpSource } from '../../../shared/types';
import { hostOf, signInButtons, timeLeft } from './addForm';

export { canSignIn } from './addForm';

export interface RowActionHandlers {
  check: (row: ConnectionRow) => void;
  login: (row: ConnectionRow) => void;
  cancelLogin: (row: ConnectionRow) => void;
  logout: (row: ConnectionRow) => void;
  remove: (row: ConnectionRow) => void;
  /** Escape, or focus leaving an armed Remove: the next click starts over. */
  disarmRemove: (row: ConnectionRow) => void;
  terminalLogin: (row: ConnectionRow) => void;
  useNewSetup: (row: ConnectionRow) => void;
  /** GPT projects: sign in to this server for GPT desks, stop that, or sign out of it. */
  gptLogin: (row: ConnectionRow) => void;
  cancelGptLogin: (row: ConnectionRow) => void;
  gptLogout: (row: ConnectionRow) => void;
}

interface Props {
  row: ConnectionRow;
  busy: boolean;
  /** This row's Remove was clicked once: the next click removes. */
  confirming: boolean;
  canTerminal: boolean;
  on: RowActionHandlers;
}

const isWeb = (row: ConnectionRow) => row.transport === 'http' || row.transport === 'sse';

const REMOVE_NOTE: Partial<Record<McpSource, string>> = {
  folder: "Removes it from this project's settings and signs you out of it.",
  user: 'Removes it for every project and signs you out of it.',
  repo: "Removes it from the repo's .mcp.json, which is shared through git.",
};

/** The buttons under a server: Log in, Check, Log out, Remove. claude.ai connectors have none. */
export function RowActions({ row, busy, confirming, canTerminal, on }: Props) {
  if (row.source === 'claude-ai') return null;
  if (!row.present) {
    return (
      <div className="conn-actions">
        <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={() => on.remove(row)}>
          Forget
        </button>
      </div>
    );
  }
  const state = row.check?.state ?? 'unchecked';
  const signingIn = row.login && row.login.state !== 'failed';
  const buttons = signInButtons(row);
  return (
    <>
      {row.login && <LoginBox row={row} canTerminal={canTerminal} on={on} />}
      {row.changed && (
        <p className="conn-note">
          Its setup in Claude Code changed since you turned it on, so desks don't get it.{' '}
          <button type="button" className="link-btn" disabled={busy} onClick={() => on.useNewSetup(row)}>
            Use the new setup
          </button>
        </p>
      )}
      {state === 'needs-login' && isWeb(row) && row.auth === 'token' && <p className="conn-note">The server refused its token. Remove it and add it again with a new one.</p>}
      <div className="conn-actions">
        {buttons.login && (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => on.login(row)}>
            Log in
          </button>
        )}
        <button type="button" className="btn btn-sm btn-outline" disabled={busy || Boolean(signingIn)} onClick={() => on.check(row)}>
          {busy ? 'Working...' : 'Check'}
        </button>
        {buttons.logout && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => on.logout(row)}>
            Log out
          </button>
        )}
        <span className="grow" />
        <button
          type="button"
          className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`}
          disabled={busy || Boolean(signingIn)}
          onClick={() => on.remove(row)}
          onBlur={() => confirming && on.disarmRemove(row)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && confirming) {
              // Only the armed button: Escape here must not also close anything else.
              e.stopPropagation();
              on.disarmRemove(row);
            }
          }}
        >
          {confirming ? 'Click again to remove' : 'Remove'}
        </button>
      </div>
      {confirming && (
        <p className="field-hint conn-remove-note">
          {REMOVE_NOTE[row.source]} Desks already running keep it until they finish.
        </p>
      )}
    </>
  );
}

function LoginBox({ row, canTerminal, on }: { row: ConnectionRow; canTerminal: boolean; on: RowActionHandlers }) {
  const login = row.login!;
  const url = safeAuthUrl(login.authUrl);
  const [copied, setCopied] = useState(false);
  const buttons = signInButtons(row);
  const command = `claude mcp login ${row.name}`;

  if (login.state === 'failed') {
    return (
      <div className="conn-login failed">
        <p className="conn-note bad" role="status">
          {login.error ?? 'Signing in failed.'}
        </p>
        {buttons.command && (
          <div className="conn-actions">
            <code className="mono conn-cmd">{command}</code>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(command)
                  .then(() => setCopied(true))
                  .catch(() => undefined);
              }}
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy'}
            </button>
            {canTerminal && (
              <button type="button" className="btn btn-sm btn-outline" onClick={() => on.terminalLogin(row)}>
                Open terminal and log in
              </button>
            )}
          </div>
        )}
        {login.unsupported && !buttons.command && <p className="conn-note">Open Claude Code in the project folder, run /mcp, and log in to this server. Then check again.</p>}
        {buttons.tryAgain && (
          <div className="conn-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => on.login(row)}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="conn-login">
      {/* Only the sentence is announced: the countdown changes on every poll. */}
      <p className="conn-note">
        <span role="status">{login.state === 'starting' ? 'Starting sign-in...' : `Sign in to ${row.name} in your browser, as you. HQ finishes on its own when you're done.`}</span>
        {login.state !== 'starting' && <> {timeLeft(login.expiresAt)} left.</>}
      </p>
      <div className="conn-actions">
        {url && (
          <a className="btn btn-sm btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden /> Open sign-in page ({hostOf(url)})
          </a>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => on.cancelLogin(row)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const GPT_LABEL: Record<NonNullable<ConnectionRow['gpt']>['state'], string> = {
  ready: 'works',
  'needs-login': 'needs a sign-in for GPT',
  'signed-in': 'signed in for GPT',
  'claude-only': 'Claude only',
  unchecked: 'not checked yet',
};

/** A GPT project's row: how this server works on GPT desks, and its own sign-in for GPT when it needs one. */
export function GptRow({ row, busy, on }: { row: ConnectionRow; busy: boolean; on: RowActionHandlers }) {
  const gpt = row.gpt;
  if (!gpt) return null;
  const login = gpt.login;
  const url = safeAuthUrl(login?.authUrl);
  const signingIn = login && login.state !== 'failed';
  return (
    <div className="conn-gpt">
      <p className="conn-note">
        <strong>On GPT:</strong> {GPT_LABEL[gpt.state]}
        {gpt.why ? ` (${gpt.why})` : ''}
        {gpt.state === 'unchecked' && row.transport === 'http' ? '. Check to see whether it needs a sign-in for GPT.' : ''}
        {gpt.state === 'needs-login' ? '. Claude\'s sign-in can\'t be used by GPT desks.' : ''}
      </p>
      {login?.state === 'failed' && (
        <p className="conn-note bad" role="status">
          {login.error ?? 'Signing in for GPT failed.'}
        </p>
      )}
      {signingIn && (
        <p className="conn-note">
          <span role="status">
            {login.state === 'starting' ? 'Starting the sign-in for GPT...' : `Sign in to ${row.name} in a browser on this PC, as you. HQ finishes on its own when you're done.`}
          </span>
          {login.state !== 'starting' && <> {timeLeft(login.expiresAt)} left.</>}
        </p>
      )}
      <div className="conn-actions">
        {signingIn && url && (
          <a className="btn btn-sm btn-primary" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden /> Open sign-in page ({hostOf(url)})
          </a>
        )}
        {signingIn || login?.state === 'failed' ? (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => on.cancelGptLogin(row)}>
            {signingIn ? 'Cancel' : 'Dismiss'}
          </button>
        ) : gpt.state === 'needs-login' ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => on.gptLogin(row)}>
            Sign in for GPT
          </button>
        ) : gpt.state === 'signed-in' ? (
          <>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => on.gptLogin(row)}>
              Sign in again for GPT
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => on.gptLogout(row)}>
              Sign out for GPT
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
