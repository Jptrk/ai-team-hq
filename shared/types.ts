export type AgentStatus = 'working' | 'waiting' | 'idle' | 'off';

export interface Agent {
  id: string;
  name: string;
  role: string;
  desk: string;
  status: AgentStatus;
  isHuman?: boolean;
  /** The desk that routes instructions nobody else matches. One per project. */
  lead?: boolean;
  color: string;
  seat: { col: number; row: number };
  currentTask?: string;
  lastActive: string;
  skills: string[];
  /** Live runner only: true while a Claude run is in flight for this agent. */
  running?: boolean;
  /** Live runner only: Agent SDK session to resume so the agent keeps context between tasks. */
  sessionId?: string;
  /** Live runner only: cumulative estimated spend in USD. */
  spentUsd?: number;
  /** Live runner only: the SDK's running total for the current session, to turn it into per-run cost. */
  sessionTotalUsd?: number;
}

export type ItemKind = 'decide' | 'review' | 'fyi';
export type ItemStatus =
  | 'todo'
  | 'in-progress'
  | 'needs-you'
  | 'approved'
  | 'held'
  | 'sent-back'
  | 'done';

export interface WorkItem {
  id: string;
  /** Per-project ticket number. Shown as <project key>-<number>, like Jira. */
  number?: number;
  kind: ItemKind;
  title: string;
  summary: string;
  status: ItemStatus;
  client?: string;
  from: string;
  assignee: string;
  dated: string;
  links: { label: string; url: string }[];
  history: { ts: string; text: string }[];
  /** The chat thread where this ticket is discussed. */
  threadId?: string;
  /** Desk that handed this ticket over; it hears back when the ticket is done. */
  handoffFrom?: string;
}

export type InstructionStatus = 'queued' | 'assigned' | 'done';

export interface Instruction {
  id: string;
  text: string;
  createdAt: string;
  status: InstructionStatus;
  assignedTo?: string;
  itemId?: string;
}

export interface Activity {
  id: string;
  ts: string;
  agentId: string;
  text: string;
}

export type RunReason = 'instruction' | 'send-back' | 'instruct' | 'approved' | 'manual' | 'message' | 'handoff';
export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

/** One invocation of an agent: on a ticket, or woken by a chat message. */
export interface Run {
  id: string;
  agentId: string;
  /** Ticket the run works on. Message runs carry the thread's ticket, if it has one. */
  itemId?: string;
  /** Set for message runs. */
  threadId?: string;
  reason: RunReason;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  costUsd?: number;
  turns?: number;
  summary?: string;
  error?: string;
}

export interface Company {
  name: string;
  ownerId: string;
  timezone: string;
}

/** Where an MCP server's definition lives. */
export type McpSource = 'user' | 'repo' | 'folder' | 'claude-ai';
/** token = a token sits in the config; oauth = a browser login Claude Code saved; none = no login. */
export type McpAuth = 'token' | 'oauth' | 'none';

export interface McpServerInfo {
  name: string;
  source: McpSource;
  transport: 'stdio' | 'http' | 'sse' | 'claude-ai' | 'unknown';
  /** Command or URL with anything secret blanked out. Safe to show. */
  target: string;
  auth: McpAuth;
}

export interface McpToolInfo {
  name: string;
  readOnly?: boolean;
  destructive?: boolean;
  /** HQ's verdict: true = runs without asking, false = needs your approval. */
  reads: boolean;
}

export type ConnectionMode = 'ask' | 'read';

/** Your choice for one server in one project. Only this is stored; tokens never are. */
export interface ProjectConnection {
  name: string;
  source: McpSource;
  enabled: boolean;
  /** Desks allowed to use it. */
  desks: string[];
  /** ask = reads run, changes wait for approval; read = changes are never allowed. */
  mode: ConnectionMode;
}

export type ConnectionState = 'connected' | 'needs-login' | 'failed' | 'disabled' | 'unchecked';

export interface ConnectionCheck {
  state: ConnectionState;
  checkedAt: string;
  error?: string;
  tools: McpToolInfo[];
}

/** One row on the Connections screen. */
export interface ConnectionRow extends McpServerInfo {
  connection: ProjectConnection;
  check?: ConnectionCheck;
  /** False when the server is saved in HQ but no longer in any config. */
  present: boolean;
}

export interface ConnectionsResponse {
  rows: ConnectionRow[];
  /** claude.ai connectors are found by a check; this is when the last check ran. */
  lastCheck?: string;
}

export type ThreadStatus = 'open' | 'paused' | 'closed';

/** A conversation between desks, and Patrick. Tied to a ticket or free-standing. */
export interface Thread {
  id: string;
  title: string;
  itemId?: string;
  /** Agent id or 'you'. */
  createdBy: string;
  /** Agent ids, plus 'you' once Patrick posts. */
  participants: string[];
  status: ThreadStatus;
  pausedReason?: 'hop-limit' | 'daily-cap' | 'restart';
  /** Desks woken by other desks since Patrick last posted or resumed. Capped by the loop limit. */
  agentHops: number;
  /** Messages so far. Message.n runs 1..count. */
  count: number;
  /** Per desk: the last message n it has been shown. */
  cursor: Record<string, number>;
  /** Desks woken to reply and not finished yet. */
  waiting: string[];
  /** Last message n Patrick has seen. */
  youSeen: number;
  last?: { from: string; to: string[]; text: string; ts: string };
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  n: number;
  /** Agent id, 'you', or 'hq' for a system note. */
  from: string;
  /** Agent ids and/or 'you'. Empty = a note that wakes nobody. */
  to: string[];
  text: string;
  ts: string;
  runId?: string;
  /** Recipients not woken because the thread paused. Resume delivers them. */
  undelivered?: string[];
}

/** Everything that belongs to one project: its team, its board, its history. */
export interface State {
  company: Company;
  agents: Agent[];
  items: WorkItem[];
  instructions: Instruction[];
  activity: Activity[];
  runs: Run[];
  /** Last ticket number handed out. */
  seq: number;
  /** MCP servers you turned on for this project, and who may use them. */
  connections: ProjectConnection[];
  /** Latest connection check per server, including claude.ai connectors found by it. */
  checks: Record<string, ConnectionCheck & { info?: McpServerInfo }>;
  lastCheck?: string;
  threads: Thread[];
  messages: Message[];
  /** Agent-triggered wakes today, for the daily cap. */
  chat: { day: string; wakes: number };
}

export type TeamTemplate = 'business' | 'dev' | 'blank';
/** read = agents can read the linked folder; write = they can also edit files in it. */
export type ProjectAccess = 'read' | 'write';

export interface ProjectMeta {
  /** Slug used in URLs and on disk. Never changes. */
  id: string;
  /** Jira-style key, e.g. GA. Tickets show as GA-12. */
  key: string;
  name: string;
  /** Linked folder on disk, or null for a project with no codebase. */
  path: string | null;
  access: ProjectAccess;
  template: TeamTemplate;
  color: string;
  createdAt: string;
}

export interface ProjectSummary extends ProjectMeta {
  teamSize: number;
  openItems: number;
  needsYou: number;
  running: number;
  /** False when the linked folder no longer exists. */
  pathOk: boolean;
}

export interface PathCheck {
  ok: boolean;
  path: string;
  exists: boolean;
  isDir: boolean;
  isGit: boolean;
  /** CLAUDE.md or AGENTS.md at the folder root, read into every agent's prompt. */
  instructionsFile: string | null;
  hasReadme: boolean;
  suggestedName: string;
  suggestedKey: string;
  /** Name of another project already linked to this folder. */
  inUseBy?: string;
  error?: string;
}

export type RunnerName = 'claude' | 'sim';

/** Server-side facts the UI needs that are not persisted. */
export interface Meta {
  runner: RunnerName;
  model: string;
  /** True when some credential exists, so live mode can actually run. */
  liveReady: boolean;
  /** Which credential the Agent SDK will use. */
  auth: 'api-key' | 'claude-login' | 'none';
}

/** The polled state leaves out messages; a thread's messages load when it opens. */
export interface StateResponse extends Omit<State, 'messages'> {
  meta: Meta;
  project: ProjectMeta;
}

export type Decision = 'approve' | 'hold' | 'send-back' | 'instruct';

export const BOARD_COLUMNS: { statuses: ItemStatus[]; label: string }[] = [
  { statuses: ['todo'], label: 'To do' },
  { statuses: ['in-progress', 'sent-back'], label: 'In progress' },
  { statuses: ['needs-you', 'held'], label: 'Needs you' },
  { statuses: ['approved', 'done'], label: 'Done' },
];

export const TEMPLATE_LABEL: Record<TeamTemplate, string> = {
  business: 'Business team',
  dev: 'Dev team',
  blank: 'Blank',
};

export const MAX_TEAM = 12;

export interface ThreadResponse {
  thread: Thread;
  messages: Message[];
  hopLimit: number;
}
