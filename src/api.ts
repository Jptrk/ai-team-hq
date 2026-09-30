import type {
  Agent,
  ConnectionMode,
  ConnectionsResponse,
  Decision,
  Instruction,
  ItemStatus,
  Meta,
  PathCheck,
  ProjectAccess,
  ProjectSummary,
  Run,
  StateResponse,
  TeamTemplate,
  ThreadResponse,
  WorkItem,
} from '../shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const pp = (pid: string) => `/api/projects/${encodeURIComponent(pid)}`;

export interface ProjectBody {
  name?: string;
  key?: string;
  path?: string;
  access?: ProjectAccess;
  template?: TeamTemplate;
}

export interface AgentBody {
  name?: string;
  role?: string;
  skills?: string;
  lead?: boolean;
}

export const api = {
  meta: () => request<Meta & { owner: string }>('/api/meta'),
  projects: () => request<ProjectSummary[]>('/api/projects'),
  createProject: (body: ProjectBody) => request<ProjectSummary>('/api/projects', json('POST', body)),
  updateProject: (pid: string, body: ProjectBody) => request<ProjectSummary>(pp(pid), json('PATCH', body)),
  archiveProject: (pid: string) => request<{ ok: true; archivedTo: string }>(pp(pid), json('DELETE')),
  checkPath: (path: string, except?: string) =>
    request<PathCheck>(`/api/fs/check?path=${encodeURIComponent(path)}${except ? `&except=${encodeURIComponent(except)}` : ''}`),

  state: (pid: string) => request<StateResponse>(`${pp(pid)}/state`),
  instruct: (pid: string, text: string) =>
    request<{ instruction: Instruction; item: WorkItem; run: Run | null }>(`${pp(pid)}/instructions`, json('POST', { text })),
  decide: (pid: string, id: string, decision: Decision, note?: string) =>
    request<{ item: WorkItem; run: Run | null }>(`${pp(pid)}/items/${id}/decision`, json('POST', { decision, note })),
  move: (pid: string, id: string, status: ItemStatus) => request<WorkItem>(`${pp(pid)}/items/${id}`, json('PATCH', { status })),
  run: (pid: string, id: string) => request<Run>(`${pp(pid)}/items/${id}/run`, json('POST')),
  cancelRun: (pid: string, id: string) => request<{ ok: true }>(`${pp(pid)}/runs/${id}/cancel`, json('POST')),
  addAgent: (pid: string, body: AgentBody) => request<Agent>(`${pp(pid)}/agents`, json('POST', body)),
  updateAgent: (pid: string, id: string, body: AgentBody) => request<Agent>(`${pp(pid)}/agents/${id}`, json('PATCH', body)),
  removeAgent: (pid: string, id: string) => request<{ ok: true }>(`${pp(pid)}/agents/${id}`, json('DELETE')),
  reset: (pid: string) => request<StateResponse>(`${pp(pid)}/reset`, json('POST')),

  connections: (pid: string) => request<ConnectionsResponse>(`${pp(pid)}/connections`),
  checkConnections: (pid: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/check`, json('POST')),
  updateConnection: (pid: string, name: string, body: { enabled?: boolean; desks?: string[]; mode?: ConnectionMode }) =>
    request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}`, json('PUT', body)),

  thread: (pid: string, tid: string) => request<ThreadResponse>(`${pp(pid)}/threads/${tid}`),
  startThread: (pid: string, body: { text: string; title?: string; itemId?: string }) =>
    request<ThreadResponse & { woke: string[] }>(`${pp(pid)}/threads`, json('POST', body)),
  postMessage: (pid: string, tid: string, text: string) =>
    request<ThreadResponse & { woke: string[] }>(`${pp(pid)}/threads/${tid}/messages`, json('POST', { text })),
  resumeThread: (pid: string, tid: string) => request<ThreadResponse & { woke: string[] }>(`${pp(pid)}/threads/${tid}/resume`, json('POST')),
  closeThread: (pid: string, tid: string) => request<ThreadResponse>(`${pp(pid)}/threads/${tid}/close`, json('POST')),

  report: async (url: string): Promise<string> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Report not found');
    return res.text();
  },
};
