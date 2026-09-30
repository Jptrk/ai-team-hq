import { useCallback, useState } from 'react';

export type FlagTone = 'info' | 'success' | 'warning' | 'danger';

export interface Flag {
  id: number;
  text: string;
  tone: FlagTone;
  action?: { label: string; onClick: () => void };
}

export type Notify = (text: string, opts?: { tone?: FlagTone; action?: Flag['action'] }) => void;

let nextId = 1;

/** Bottom-left notices, like Jira's flags. At most 3 at once; each hides itself after a few seconds. */
export function useFlags() {
  const [flags, setFlags] = useState<Flag[]>([]);

  const dismiss = useCallback((id: number) => setFlags((f) => f.filter((x) => x.id !== id)), []);

  const notify = useCallback<Notify>((text, opts = {}) => {
    const flag: Flag = { id: nextId++, text, tone: opts.tone ?? 'info', action: opts.action };
    setFlags((f) => [...f, flag].slice(-3));
  }, []);

  return { flags, notify, dismiss };
}
