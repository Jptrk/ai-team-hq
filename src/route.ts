import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Hash routes. The view and the side panel's subject live in the URL, so reload,
 * Back and shared links all land in the same place.
 *
 *   #/projects                    all projects
 *   #/projects/new                create a project
 *   #/p/<pid>                     Needs you
 *   #/p/<pid>/<view>              chat | board | team | office
 *   #/p/<pid>/chat/<threadId>     one thread
 *   #/p/<pid>/settings            project settings
 *   #/p/<pid>/connections         MCP connections
 *   ...?ticket=GA-12 | ?agent=leo side panel
 */

export type ViewId = 'needs-you' | 'chat' | 'board' | 'team' | 'office';
export const VIEWS: ViewId[] = ['needs-you', 'chat', 'board', 'team', 'office'];

export interface PanelRef {
  ticket?: string;
  agent?: string;
}

export type Route =
  | { kind: 'home' }
  | { kind: 'projects' }
  | { kind: 'new' }
  | ({ kind: 'project'; pid: string; view: ViewId; threadId?: string } & PanelRef)
  | { kind: 'settings'; pid: string }
  | { kind: 'connections'; pid: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
  const parts = pathPart
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (parts[0] === 'projects') return parts[1] === 'new' ? { kind: 'new' } : { kind: 'projects' };
  if (parts[0] === 'p' && parts[1]) {
    const pid = parts[1];
    const sub = parts[2];
    if (sub === 'settings') return { kind: 'settings', pid };
    if (sub === 'connections') return { kind: 'connections', pid };
    const view: ViewId = VIEWS.includes(sub as ViewId) ? (sub as ViewId) : 'needs-you';
    const threadId = view === 'chat' && parts[3] ? parts[3] : undefined;
    const ticket = query.get('ticket') || undefined;
    const agent = ticket ? undefined : query.get('agent') || undefined;
    return { kind: 'project', pid, view, threadId, ticket, agent };
  }
  return { kind: 'home' };
}

/** Path (without '#') for a project view, optionally with a thread and a side-panel subject. */
export function projectPath(pid: string, view: ViewId = 'needs-you', o: { threadId?: string } & PanelRef = {}): string {
  let path = `/p/${encodeURIComponent(pid)}`;
  if (view !== 'needs-you') path += `/${view}`;
  if (view === 'chat' && o.threadId) path += `/${encodeURIComponent(o.threadId)}`;
  const q = new URLSearchParams();
  if (o.ticket) q.set('ticket', o.ticket);
  else if (o.agent) q.set('agent', o.agent);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

export function useHashRoute(): [Route, (to: string, replace?: boolean) => void] {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((to: string, replace = false) => {
    const next = `#${to}`;
    if (replace) {
      window.history.replaceState(null, '', next);
      setHash(next);
    } else if (window.location.hash !== next) {
      window.location.hash = next;
    }
  }, []);

  const route = useMemo(() => parseRoute(hash), [hash]);
  return [route, navigate];
}
