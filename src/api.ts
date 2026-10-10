import type { LimitsPatch, LimitsResponse } from '../shared/limits';
import type { AddRequest } from '../shared/mcpSpec';
import type {
  AccountResponse,
  AddPreview,
  ChatGptResponse,
  AutoStatus,
  Agent,
  Attachment,
  AuthStatus,
  Comment,
  ConnectionMode,
  ConnectionsResponse,
  McpSource,
  Decision,
  EffortLevel,
  Huddle,
  HuddleKind,
  HuddleProposal,
  Instruction,
  ItemStatus,
  Meta,
  PathCheck,
  ProjectAccess,
  Provider,
  ProjectSkillsResponse,
  ProjectSummary,
  RemovedProject,
  ReportInfo,
  Run,
  SkillMeta,
  SkillPick,
  SkillPreview,
  StateResponse,
  TeamTemplate,
  ThreadResponse,
  WorkItem,
} from '../shared/types';

/** A failed API call, with its HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;

/**
 * The login gate (src/shell/AuthGate.tsx) sets this while you are logged in. Only the session check answers 401,
 * so a 401 then means the session ended: logged out elsewhere, password changed, or 30 days unused.
 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function failure(res: Response, fallback: string): Promise<ApiError> {
  if (res.status === 401) onUnauthorized?.();
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(body.error ?? fallback, res.status);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await failure(res, res.statusText);
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
  /** Finished tickets wait for your sign-off before Done. */
  signoff?: boolean;
  /** Free desks start their next To do ticket on their own. */
  autopilot?: boolean;
  /** The lead plans tickets toward the goal. Needs goal and autopilot. */
  goalMode?: boolean;
  goal?: string;
  /** Most the team may start on its own per day. */
  autoLimits?: { runs: number; usd: number };
  /** The model every desk here runs on. Changing it starts every desk on a new conversation. */
  provider?: Provider;
}

export interface HuddleBody {
  kind: HuddleKind;
  topic: string;
  participants: string[];
  rounds: number;
  includeNotes: boolean;
}

export interface AgentBody {
  name?: string;
  role?: string;
  skills?: string;
  lead?: boolean;
  qa?: boolean;
}

export const api = {
  /** HQ's own login: is there an account, and is this browser logged in. */
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  /** The first account. Only works from the PC HQ runs on, and only once. */
  setupAccount: (name: string, password: string) => request<AuthStatus>('/api/auth/setup', json('POST', { name, password })),
  logIn: (name: string, password: string) => request<AuthStatus>('/api/auth/login', json('POST', { name, password })),
  logOut: () => request<AuthStatus>('/api/auth/logout', json('POST', {})),
  /** Your other sessions end; this browser stays logged in. */
  changePassword: (current: string, next: string) => request<{ ok: true }>('/api/auth/password', json('POST', { current, next })),
  meta: () => request<Meta & { owner: string }>('/api/meta'),
  /** Settings for all of HQ. Answers with the new meta. */
  setSettings: (body: { effort?: EffortLevel | null; paused?: boolean }) => request<Meta & { owner: string }>('/api/settings', json('PATCH', body)),
  /** HQ's limits for every project, and where each value comes from. */
  limits: () => request<LimitsResponse>('/api/limits'),
  /** A value, or null to go back to .env or the default. Answers with every limit. */
  setLimits: (patch: LimitsPatch) => request<LimitsResponse>('/api/limits', json('PATCH', patch)),
  /** Your Claude account: who is signed in on this PC, and any sign-in running. `check` asks Claude Code again. */
  account: (check = false) => request<AccountResponse>(`/api/account${check ? '?check=1' : ''}`),
  /** Starts signing in to your Claude account. The answer carries the sign-in page once Claude Code has it. */
  startAccountLogin: () => request<AccountResponse>('/api/account/login', json('POST', {})),
  /** The code the sign-in page showed, for when the browser could not come back to this PC. */
  sendAccountCode: (code: string) => request<AccountResponse>('/api/account/login/code', json('POST', { code })),
  cancelAccountLogin: () => request<AccountResponse>('/api/account/login', json('DELETE')),
  /** May desks run on the Claude login on this PC? From HQ's next start. */
  useClaudeLogin: (on: boolean) => request<AccountResponse>('/api/account/use', json('PUT', { on })),
  /** Signs out of Claude for every Claude Code on this PC. */
  signOutAccount: () => request<AccountResponse>('/api/account/logout', json('POST', {})),
  /** Your ChatGPT account in HQ's Codex, for GPT desks. `check` asks Codex again. */
  chatGpt: (check = false) => request<ChatGptResponse>(`/api/account/chatgpt${check ? '?check=1' : ''}`),
  /** Starts signing in to ChatGPT: on this PC (a sign-in page) or from another device (a code). */
  startChatGptLogin: (method: 'browser' | 'device') => request<ChatGptResponse>('/api/account/chatgpt/login', json('POST', { method })),
  cancelChatGptLogin: () => request<ChatGptResponse>('/api/account/chatgpt/login', json('DELETE')),
  /** May GPT desks run on HQ's ChatGPT login? */
  useChatGptLogin: (on: boolean) => request<ChatGptResponse>('/api/account/chatgpt/use', json('PUT', { on })),
  /** Signs HQ's Codex out of ChatGPT. Your own Codex CLI keeps its login. */
  signOutChatGpt: () => request<ChatGptResponse>('/api/account/chatgpt/logout', json('POST', {})),
  /** GPT desks' model and effort; null is the default. */
  setGptModel: (body: { model?: string | null; effort?: string | null }) => request<ChatGptResponse>('/api/account/chatgpt/model', json('PUT', body)),
  projects: () => request<ProjectSummary[]>('/api/projects'),
  createProject: (body: ProjectBody) => request<ProjectSummary>('/api/projects', json('POST', body)),
  updateProject: (pid: string, body: ProjectBody) => request<ProjectSummary>(pp(pid), json('PATCH', body)),
  /** Autopilot stopped itself after 3 failed runs: start it again. */
  resumeAuto: (pid: string) => request<AutoStatus>(`${pp(pid)}/auto/resume`, json('POST')),
  archiveProject: (pid: string) => request<{ ok: true; archivedTo: string }>(pp(pid), json('DELETE')),
  /** Removes the project and deletes its data and workspaces for good. `left`: what another program held open. */
  deleteProject: (pid: string) => request<{ ok: true; deleted: true; left: string[] }>(`${pp(pid)}?forGood=1`, json('DELETE')),
  /** Removed projects waiting in data/archive, newest first. */
  removedProjects: () => request<RemovedProject[]>('/api/archive'),
  deleteRemoved: (folder: string) => request<{ ok: true }>(`/api/archive/${encodeURIComponent(folder)}`, json('DELETE')),
  checkPath: (path: string, except?: string) =>
    request<PathCheck>(`/api/fs/check?path=${encodeURIComponent(path)}${except ? `&except=${encodeURIComponent(except)}` : ''}`),

  state: (pid: string) => request<StateResponse>(`${pp(pid)}/state`),
  instruct: (pid: string, text: string, attachments: string[] = [], includeNotes = false) =>
    request<{ instruction: Instruction; item: WorkItem; run: Run | null }>(`${pp(pid)}/instructions`, json('POST', { text, attachments, includeNotes })),
  decide: (pid: string, id: string, decision: Decision, note?: string, attachments: string[] = [], includeNotes = false) =>
    request<{ item: WorkItem; run: Run | null }>(`${pp(pid)}/items/${id}/decision`, json('POST', { decision, note, attachments, includeNotes })),
  comment: (pid: string, id: string, text: string, attachments: string[] = [], includeNotes = false) =>
    request<{ item: WorkItem; comment: Comment; run: Run | null }>(`${pp(pid)}/items/${id}/comments`, json('POST', { text, attachments, includeNotes })),
  attachToItem: (pid: string, id: string, attachments: string[]) => request<WorkItem>(`${pp(pid)}/items/${id}/attachments`, json('POST', { attachments })),
  /** One image as the raw body. The server checks the bytes, not this header. */
  uploadAttachment: async (pid: string, blob: Blob): Promise<Attachment> => {
    const res = await fetch(`${pp(pid)}/attachments`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    if (!res.ok) throw await failure(res, 'Upload failed');
    return (await res.json()) as Attachment;
  },
  move: (pid: string, id: string, status: ItemStatus) => request<WorkItem>(`${pp(pid)}/items/${id}`, json('PATCH', { status })),
  editDescription: (pid: string, id: string, summary: string) => request<WorkItem>(`${pp(pid)}/items/${id}`, json('PATCH', { summary })),
  run: (pid: string, id: string) => request<Run>(`${pp(pid)}/items/${id}/run`, json('POST')),
  cancelRun: (pid: string, id: string) => request<{ ok: true }>(`${pp(pid)}/runs/${id}/cancel`, json('POST')),
  addAgent: (pid: string, body: AgentBody) => request<Agent>(`${pp(pid)}/agents`, json('POST', body)),
  updateAgent: (pid: string, id: string, body: AgentBody) => request<Agent>(`${pp(pid)}/agents/${id}`, json('PATCH', body)),
  removeAgent: (pid: string, id: string) => request<{ ok: true }>(`${pp(pid)}/agents/${id}`, json('DELETE')),
  reset: (pid: string) => request<StateResponse>(`${pp(pid)}/reset`, json('POST')),

  connections: (pid: string) => request<ConnectionsResponse>(`${pp(pid)}/connections`),
  /** All servers plus claude.ai connectors, or just `names`. */
  checkConnections: (pid: string, names?: string[]) => request<ConnectionsResponse>(`${pp(pid)}/connections/check`, json('POST', names ? { names } : {})),
  previewConnection: (pid: string, body: AddRequest) => request<AddPreview>(`${pp(pid)}/connections/preview`, json('POST', body)),
  addConnection: (pid: string, body: AddRequest, confirm: string) => request<ConnectionsResponse>(`${pp(pid)}/connections`, json('POST', { ...body, confirm })),
  removeConnection: (pid: string, name: string, source: McpSource) =>
    request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}?source=${encodeURIComponent(source)}`, json('DELETE')),
  loginConnection: (pid: string, name: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}/login`, json('POST', {})),
  cancelLogin: (pid: string, name: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}/login`, json('DELETE')),
  /** Sign in to a server for GPT desks: HQ's Codex runs it; the row shows the page to open. */
  gptLoginConnection: (pid: string, name: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}/gpt-login`, json('POST', {})),
  cancelGptLogin: (pid: string, name: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}/gpt-login`, json('DELETE')),
  /** Sign HQ's Codex out of a server: GPT desks need a new sign-in for it. */
  gptLogoutConnection: (pid: string, name: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}/gpt-logout`, json('POST', {})),
  logoutConnection: (pid: string, name: string) => request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}/logout`, json('POST', {})),
  /** Windows Terminal in the project folder, optionally running `claude mcp login <login>`. */
  openTerminal: (pid: string, login?: string) => request<{ ok: true }>(`${pp(pid)}/terminal`, json('POST', login ? { login } : {})),
  updateConnection: (pid: string, name: string, body: { enabled?: boolean; desks?: string[]; mode?: ConnectionMode }) =>
    request<ConnectionsResponse>(`${pp(pid)}/connections/${encodeURIComponent(name)}`, json('PUT', body)),

  /** Skills: one library for every project. */
  skills: () => request<SkillMeta[]>('/api/skills'),
  /** Fetches the link into a staging folder and lists its skills. Installs nothing. `token` (24 hex) lets Cancel stop the fetch before it answers. */
  previewSkills: (url: string, token?: string) => request<SkillPreview>('/api/skills/preview', json('POST', { url, ...(token ? { token } : {}) })),
  /** Stops a fetch that is still running, or throws a fetched repo away. */
  cancelSkillPreview: (token: string) => request<{ ok: true }>(`/api/skills/preview/${encodeURIComponent(token)}`, json('DELETE')),
  installSkills: (token: string, picks: SkillPick[]) => request<SkillMeta[]>('/api/skills/install', json('POST', { token, picks })),
  updateSkill: (id: string, body: { scriptsAllowed: boolean }) => request<SkillMeta[]>(`/api/skills/${encodeURIComponent(id)}`, json('PATCH', body)),
  removeSkill: (id: string) => request<SkillMeta[]>(`/api/skills/${encodeURIComponent(id)}`, json('DELETE')),
  /** The library, and which desks have each skill in this project. */
  projectSkills: (pid: string) => request<ProjectSkillsResponse>(`${pp(pid)}/skills`),
  setSkillDesks: (pid: string, id: string, desks: string[]) => request<ProjectSkillsResponse>(`${pp(pid)}/skills/${encodeURIComponent(id)}`, json('PUT', { desks })),
  /** Adds desks to, or takes them off, several skills at once. Each skill keeps its other desks. */
  changeSkillDesks: (pid: string, skills: string[], change: { add?: string[]; remove?: string[] }) =>
    request<ProjectSkillsResponse>(`${pp(pid)}/skills`, json('PATCH', { skills, ...change })),

  huddle: (pid: string, hid: string) => request<Huddle>(`${pp(pid)}/huddles/${encodeURIComponent(hid)}`),
  startHuddle: (pid: string, body: HuddleBody) => request<Huddle>(`${pp(pid)}/huddles`, json('POST', body)),
  steerHuddle: (pid: string, hid: string, text: string) => request<Huddle>(`${pp(pid)}/huddles/${encodeURIComponent(hid)}/steer`, json('POST', { text })),
  stopHuddle: (pid: string, hid: string) => request<Huddle>(`${pp(pid)}/huddles/${encodeURIComponent(hid)}/stop`, json('POST')),
  resumeHuddle: (pid: string, hid: string) => request<Huddle>(`${pp(pid)}/huddles/${encodeURIComponent(hid)}/resume`, json('POST')),
  decideProposal: (pid: string, hid: string, prid: string, decision: 'approve' | 'decline') =>
    request<{ huddle: Huddle; proposal: HuddleProposal; item?: WorkItem }>(`${pp(pid)}/huddles/${encodeURIComponent(hid)}/proposals/${encodeURIComponent(prid)}`, json('POST', { decision })),
  /** base: the notes the edit started from. A 409 says they changed meanwhile. */
  saveTeamNotes: (pid: string, body: { teamNotes?: string; notesEveryRun?: boolean; base?: string }) =>
    request<{ teamNotes: string; notesEveryRun: boolean }>(`${pp(pid)}/team-notes`, json('PUT', body)),

  thread: (pid: string, tid: string) => request<ThreadResponse>(`${pp(pid)}/threads/${tid}`),
  startThread: (pid: string, body: { text: string; title?: string; itemId?: string; attachments?: string[] }) =>
    request<ThreadResponse & { woke: string[] }>(`${pp(pid)}/threads`, json('POST', body)),
  postMessage: (pid: string, tid: string, text: string, attachments: string[] = []) =>
    request<ThreadResponse & { woke: string[] }>(`${pp(pid)}/threads/${tid}/messages`, json('POST', { text, attachments })),
  resumeThread: (pid: string, tid: string) => request<ThreadResponse & { woke: string[] }>(`${pp(pid)}/threads/${tid}/resume`, json('POST')),
  closeThread: (pid: string, tid: string) => request<ThreadResponse>(`${pp(pid)}/threads/${tid}/close`, json('POST')),

  reports: (pid: string, itemId: string) => request<ReportInfo[]>(`${pp(pid)}/items/${itemId}/reports`),
  report: async (url: string): Promise<string> => {
    const res = await fetch(url);
    if (res.status === 401) throw await failure(res, 'Log in to HQ first.');
    if (!res.ok) throw new Error('Report not found');
    return res.text();
  },
};
