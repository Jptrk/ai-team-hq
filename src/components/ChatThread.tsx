import { ArrowLeft, Play, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message, StateResponse, Thread } from '../../shared/types';
import { api } from '../api';
import { Markdown } from '../markdown/Markdown';
import { Avatar } from '../ui/Avatar';
import { addMention, MentionChips } from '../ui/MentionChips';
import { agentById, ticketKey, timeAgo } from '../util';
import { speakerName } from './Chat';

interface Props {
  pid: string;
  thread: Thread;
  state: StateResponse;
  /** Narrow screens show a back button to the list. */
  onBack?: () => void;
  onOpenTicket: (key: string) => void;
  onChanged: () => Promise<void>;
}

const PAUSE_TEXT: Record<string, string> = {
  'hop-limit': 'Paused: the desks hit the message limit for this thread.',
  'daily-cap': "Paused: the team hit today's limit for desk-to-desk messages.",
  restart: 'Paused: a reply was cut off by a server restart.',
};

export function ChatThread({ pid, thread, state, onBack, onOpenTicket, onChanged }: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hopLimit, setHopLimit] = useState(6);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const agents = state.agents;
  const item = thread.itemId ? state.items.find((i) => i.id === thread.itemId) : undefined;
  const sim = state.meta.runner === 'sim';

  const load = useCallback(async () => {
    try {
      const res = await api.thread(pid, thread.id);
      setMessages(res.messages);
      setHopLimit(res.hopLimit);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the thread');
    }
  }, [pid, thread.id]);

  // Reload when the polled thread shows new messages or a change in who is replying.
  const waitingKey = thread.waiting.join(',');
  useEffect(() => {
    void load();
  }, [load, thread.count, thread.status, waitingKey]);

  // Keep the pane pinned to the newest message, but only if the reader is already near the bottom.
  useLayoutEffect(() => {
    const el = pane.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length, thread.waiting.length]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      nearBottom.current = true;
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through');
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    void act(async () => {
      await api.postMessage(pid, thread.id, value);
      setText('');
    });
  };

  const lastDesk = [...(messages ?? [])].reverse().find((m) => m.from !== 'you' && m.from !== 'hq' && agentById(agents, m.from));
  const replyHint = lastDesk ? `No @mention goes to ${speakerName(agents, lastDesk.from)}.` : 'No @mention: the router picks a desk.';
  const people = thread.participants.filter((id) => id !== 'you').map((id) => agentById(agents, id)).filter(Boolean);

  return (
    <div className="thread-pane">
      <header className="thread-head">
        {onBack && (
          <button type="button" className="icon-btn" onClick={onBack} aria-label="All threads">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="thread-head-main">
          <h2 className="pane-title">{thread.title}</h2>
          <div className="thread-head-meta">
            {item && (
              <button type="button" className="ticket-key key-btn" onClick={() => onOpenTicket(ticketKey(item, state.project.key))} title={item.title}>
                {ticketKey(item, state.project.key)}
              </button>
            )}
            <span className="thread-people">
              {people.map((a) => (
                <span key={a!.id} className="person-chip">
                  <Avatar name={a!.name} color={a!.color} size={18} />
                  {a!.name}
                </span>
              ))}
            </span>
          </div>
        </div>
        <span className={`hop-count${thread.agentHops >= hopLimit ? ' full' : ''}`} title="Desk-to-desk messages since you last posted or resumed">
          {thread.agentHops}/{hopLimit} desk messages
        </span>
      </header>

      {thread.status === 'paused' && (
        <div className="banner warning thread-paused">
          <span className="grow">{PAUSE_TEXT[thread.pausedReason ?? 'hop-limit']} Reply below, or resume to deliver what was held.</span>
          <span className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => api.resumeThread(pid, thread.id))}>
              <Play size={13} aria-hidden /> Resume
            </button>
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act(() => api.closeThread(pid, thread.id))}>
              <X size={13} aria-hidden /> Close
            </button>
          </span>
        </div>
      )}

      <div
        className="msgs"
        ref={pane}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages === null && <p className="muted small">Loading...</p>}
        {messages?.length === 0 && <p className="muted small">No messages yet.</p>}
        {messages?.map((m) => {
          if (m.from === 'hq') {
            return (
              <p key={m.id} className="msg system">
                {m.text}
              </p>
            );
          }
          const agent = agentById(agents, m.from);
          const mine = m.from === 'you';
          const to = m.to.map((id) => speakerName(agents, id));
          return (
            <div key={m.id} className={`msg${mine ? ' you' : ''}`}>
              {!mine && <Avatar name={speakerName(agents, m.from)} color={agent?.color} size={28} square />}
              <div className="msg-bubble">
                <div className="msg-head">
                  <strong>{speakerName(agents, m.from)}</strong>
                  {to.length > 0 && <span className="muted"> → {to.join(', ')}</span>}
                  <span className="muted"> · {timeAgo(m.ts)}</span>
                </div>
                <Markdown source={m.text} variant="compact" breaks />
                {m.undelivered?.length ? <div className="msg-held">Not delivered to {m.undelivered.map((id) => speakerName(agents, id)).join(', ')} yet: thread paused</div> : null}
              </div>
            </div>
          );
        })}
        {thread.waiting.map((id) => {
          const agent = agentById(agents, id);
          const running = state.runs.some((r) => r.threadId === thread.id && r.agentId === id && r.status === 'running');
          return (
            <div key={`w-${id}`} className="msg typing-row">
              <Avatar name={speakerName(agents, id)} color={agent?.color} size={28} square />
              <span className="typing">
                {speakerName(agents, id)} {running || sim ? 'is typing' : 'is queued'}
                <span className="typing-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="composer">
        {thread.status === 'closed' && <p className="muted small">Closed. Posting here reopens it.</p>}
        <textarea
          rows={2}
          value={text}
          aria-label="Reply"
          placeholder="Reply, or @Name to pull a desk in..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <div className="composer-row">
          <MentionChips agents={agents} onPick={(name) => setText((t) => addMention(t, name))} />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={send}>
            {busy ? 'Sending...' : 'Send'}
          </button>
        </div>
        <p className="field-hint">{error ?? `${replyHint} Your messages never count toward the limit. Ctrl+Enter to send.`}</p>
      </div>
    </div>
  );
}
