import type { AgentActivity } from './activity';

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
  /** Dev-team projects: the desk that checks finished tickets before you sign them off. One per project. */
  qa?: boolean;
  color: string;
  /** Old 4×3 office grid position. Kept for older data; the office now uses deskNo. */
  seat: { col: number; row: number };
  /** Desks only: which desk in the office, 1-based. Kept when others leave; a new desk takes the lowest free number. */
  deskNo?: number;
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
  /** Live runner only: when the session was last used. Claude's prompt cache for it lasts about an hour. */
  sessionAt?: string;
  /** Live runner only: how many tokens the session's context held at the end of its last run. */
  sessionTokens?: number;
  /** Live runner only: tokens after the session's first turn (system prompt, tools, first prompt). Any fresh session starts this big. */
  sessionBaseTokens?: number;
  /** Live runner only: fingerprint of the system prompt and tools the session was cached with. A new one means a cold cache. */
  sessionKey?: string;
}

export type ItemKind = 'decide' | 'review' | 'fyi';
export type ItemStatus =
  | 'todo'
  | 'in-progress'
  | 'needs-you'
  | 'approved'
  | 'held'
  | 'sent-back'
  /** Dev-team projects: the QA desk is checking the finished work. */
  | 'qa'
  /** Dev-team projects: passed QA (or there is no QA desk). Waits for you to mark it done. */
  | 'signoff'
  | 'done';

/** An image you pasted. The file lives in data/projects/<project>/attachments/<file>. */
export interface Attachment {
  id: string;
  /** <id>.<ext>, named by the server. */
  file: string;
  type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  size: number;
  /** Who uploaded it: 'you' or an agent id. */
  by: string;
  ts: string;
}

export type CommentKind = 'comment' | 'note' | 'decision' | 'qa';

/** A comment on a ticket. Desks comment instead of rewriting the description. */
export interface Comment {
  id: string;
  /** Agent id or 'you'. */
  from: string;
  ts: string;
  text: string;
  attachments?: Attachment[];
  /** note = your Instruct / Send back note; decision = a desk asking you to decide; qa = a QA result. */
  kind?: CommentKind;
  /** Decision and QA comments: the short headline, e.g. "Reply to Paul: confirm Tue kickoff" or "Passed QA". */
  title?: string;
}

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
  /** Images on the description. */
  attachments?: Attachment[];
  comments?: Comment[];
  /** Dev-team projects: where the ticket is in QA. */
  qa?: QaState;
  /** Files in the project folder that desks changed for this ticket, relative to the folder. Newest last. */
  changedFiles?: string[];
  /** When it went into Needs you, for the Office's waiting clock. Cleared when it leaves (see stampNeedsYou). */
  needsYouAt?: string;
}

export interface QaState {
  /** The QA desk that checked it last. */
  by?: string;
  /** Times QA failed it since you last sent it back yourself. */
  fails: number;
  /** Trips into QA so far. A check only counts for the round it started in. Tickets from before rounds have none: 0. */
  round?: number;
  /** This round's verdict. Cleared each time the ticket goes back into QA. */
  result?: 'pass' | 'fail';
  /** The work is finished and checked, or QA gave up on it: your Approve closes the ticket instead of starting a run. */
  ready?: boolean;
  /** QA failed it too often, so it came to you. */
  escalated?: boolean;
}

export type InstructionStatus = 'queued' | 'assigned' | 'done';

export interface Instruction {
  id: string;
  text: string;
  createdAt: string;
  status: InstructionStatus;
  assignedTo?: string;
  itemId?: string;
  attachments?: Attachment[];
}

export interface Activity {
  id: string;
  ts: string;
  agentId: string;
  text: string;
}

export type RunReason = 'instruction' | 'send-back' | 'instruct' | 'approved' | 'manual' | 'message' | 'handoff' | 'comment' | 'huddle' | 'qa' | 'qa-fail';
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
  /** The desk's read marker before the run marked its thread read. Put back if the run dies before it replies. */
  cursorFrom?: number;
  /** Ticket runs: the ticket's thread that cursorFrom belongs to. Message runs use threadId. */
  cursorThread?: string;
  /** Huddle runs: the huddle this turn belongs to. */
  huddleId?: string;
  /** The team notes went into this run's prompt. */
  notes?: boolean;
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

/** read = changes never allowed; ask = changes wait for your approval; auto = changes run on their own, deletes still ask. */
export type ConnectionMode = 'ask' | 'read' | 'auto';

/** Your choice for one server in one project. Only this is stored; tokens never are. */
export interface ProjectConnection {
  name: string;
  source: McpSource;
  enabled: boolean;
  /** Desks allowed to use it. */
  desks: string[];
  /** ask = reads run, changes wait for approval; read = changes are never allowed; auto = changes run, deletes wait for approval. */
  mode: ConnectionMode;
  /**
   * Which server it was when you turned it on: a hash of its masked shape, never the command or URL
   * itself. If Claude Code's setup changes, the connection stops until you turn it on again.
   */
  fingerprint?: string;
}

/** A sign-in running for one server. */
export interface ConnectionLogin {
  state: 'starting' | 'waiting' | 'failed';
  /** The page to sign in on, once the server gives one. */
  authUrl?: string;
  error?: string;
  /** This SDK can't sign in from HQ: log in from a terminal instead. */
  unsupported?: boolean;
  expiresAt: string;
}

/** What Add connection saves, for you to review before it does. */
export interface AddPreview {
  /** Send back as confirm. Secrets are masked. */
  preview: string;
  /** The command it runs on this PC, for local servers. */
  runs: string | null;
  /** Which file it goes in. */
  location: string;
  warnings: string[];
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
  /** Its setup in Claude Code changed since you turned it on, so desks don't get it until you turn it on again. */
  changed?: boolean;
  login?: ConnectionLogin;
}

export interface ConnectionsResponse {
  rows: ConnectionRow[];
  /** claude.ai connectors are found by a check; this is when the last check ran. */
  lastCheck?: string;
  /** HQ can open Windows Terminal in the project folder. */
  canTerminal?: boolean;
  /** Set after an add: the new server's name. */
  added?: string;
  warnings?: string[];
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
  pausedReason?: 'hop-limit' | 'daily-cap' | 'restart' | 'failed';
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
  attachments?: Attachment[];
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
  /** Team sessions you started: retros, brainstorms, planning. Newest first. */
  huddles: Huddle[];
  /** Huddles started today, for the daily cap. */
  huddleDay: { day: string; started: number };
  /** Last huddle number handed out. */
  huddleSeq: number;
  /** What the team has learned, in markdown. Desks read it only when you include it. */
  teamNotes: string;
  /** Include the team notes in every desk run, not only the ones you tick. Off by default. */
  notesEveryRun: boolean;
  /** Dev-team projects: the QA desk was picked once by role. After that your choice sticks, none included. */
  qaPicked?: boolean;
  /** Skills from HQ's library turned on in this project: skill id -> desk ids. */
  skillDesks: Record<string, string[]>;
}

/** Where an installed skill came from: a folder in a GitHub repo. */
export interface SkillSource {
  /** owner/repo */
  repo: string;
  /** Branch or tag from the link, if it named one. */
  ref?: string;
  /** The skill's folder inside the repo, with / between parts. Empty for the repo's root. */
  path: string;
  /** The commit it was installed from. */
  commit?: string;
}

/** One skill in HQ's library. Installed once for every project; turned on per desk in each one. */
export interface SkillMeta {
  /** Folder-safe slug from the SKILL.md name. Its files live in data/skills/lib/<id>/. */
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  installedAt: string;
  files: number;
  bytes: number;
  /** The scripts a desk could run, relative to its folder with / between parts: Python and Node under scripts/ or named in its SKILL.md, never tests. */
  scripts: string[];
  /** You allowed desks to run its scripts on this PC. */
  scriptsAllowed: boolean;
}

/** A skill found in a repo, before you install it. */
export interface SkillCandidate {
  /** Its folder inside the repo, with / between parts. Empty for the repo's root. */
  path: string;
  name: string;
  description: string;
  /** The id it installs as. */
  id: string;
  files: number;
  bytes: number;
  /** The scripts a desk could run: Python and Node under scripts/ or named in SKILL.md, never tests. */
  scripts: string[];
  /** The same folder of the same repo is installed already (reinstalling updates it), or another skill holds the name. */
  alreadyInstalled: boolean;
  /** The id of the install it would replace: same repo and folder. */
  replaces?: string;
  /** The same SKILL.md and files sit at this other path in the repo, the copy worth installing. */
  duplicateOf?: string;
  /** Why it can't be installed, e.g. too big. */
  problem?: string;
}

/** What a GitHub link holds, fetched into a staging folder until you install or cancel. */
export interface SkillPreview {
  token: string;
  repo: string;
  ref?: string;
  commit?: string;
  skills: SkillCandidate[];
  /** HQ stopped looking (50 skills, or 20 folders deep), so the repo may hold more. */
  truncated?: boolean;
}

/** One skill you picked to install, and whether its scripts may run. */
export interface SkillPick {
  path: string;
  allowScripts: boolean;
}

/** The Skills page of one project: the library, and which desks have each skill here. */
export interface ProjectSkillsResponse {
  library: SkillMeta[];
  desks: Record<string, string[]>;
}

export type HuddleKind = 'retro' | 'brainstorm' | 'planning';
export type HuddleStatus = 'running' | 'stopped' | 'done';
/** retro: went-well / didnt / try. brainstorm: idea. planning: task. */
export type HuddleLane = 'went-well' | 'didnt' | 'try' | 'idea' | 'task';

/** One sticky note on a huddle board. */
export interface HuddleCard {
  id: string;
  round: number;
  /** Desk id that wrote it. */
  by: string;
  lane: HuddleLane;
  title: string;
  detail?: string;
  /** Planning: the desk proposed to own the task. */
  owner?: string;
}

/** A line in a huddle's transcript. */
export interface HuddleEntry {
  id: string;
  round: number;
  /** Desk id, or 'you' for your notes. */
  from: string;
  kind: 'contribution' | 'summary' | 'steer' | 'note';
  text: string;
  ts: string;
}

/** Something a huddle proposes. Nothing happens until you approve it. */
export interface HuddleProposal {
  id: string;
  type: 'ticket' | 'note';
  title: string;
  text: string;
  /** Tickets: the desk proposed to own it. */
  owner?: string;
  status: 'pending' | 'approved' | 'declined';
  /** The ticket an approved ticket proposal became. */
  itemId?: string;
  decidedAt?: string;
}

export interface Huddle {
  id: string;
  number: number;
  kind: HuddleKind;
  topic: string;
  status: HuddleStatus;
  /** Why it stopped: you stopped it, a server restart, or a desk run that failed. */
  stopReason?: 'you' | 'restart' | 'failed';
  /** The desk that sums up each round: the project lead. */
  facilitator: string;
  participants: string[];
  rounds: number;
  /** Current round, 1-based. */
  round: number;
  /** contribute: desks are adding theirs. summarize: the facilitator is summing up. */
  phase: 'contribute' | 'summarize' | 'done';
  /** Desks that still owe their contribution this round. */
  waiting: string[];
  includeNotes: boolean;
  /** Desk runs it was expected to take when you started it. */
  estimate: number;
  /** Desk runs it has taken so far. */
  usedRuns: number;
  entries: HuddleEntry[];
  cards: HuddleCard[];
  proposals: HuddleProposal[];
  /** Brainstorm: the idea the facilitator picked, and why. */
  pick?: { title: string; reason: string };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** A proposal as the poll carries it: decided ones come without their text. */
export type HuddleProposalSummary = Omit<HuddleProposal, 'text'> & { text?: string };

/** A huddle as the 3-second poll carries it: the board and transcript load when you open it. */
export type HuddleSummary = Omit<Huddle, 'entries' | 'cards' | 'proposals'> & { proposals: HuddleProposalSummary[]; entryCount: number; cardCount: number };

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
export interface StateResponse extends Omit<State, 'messages' | 'huddles'> {
  huddles: HuddleSummary[];
  /** What each desk is doing right now, for the Office view. Derived, never stored. */
  office: Record<string, AgentActivity>;
  /** Huddles a project can start per day. */
  huddleLimit: number;
  meta: Meta;
  project: ProjectMeta;
}

export type Decision = 'approve' | 'hold' | 'send-back' | 'instruct';

export const BOARD_COLUMNS: { statuses: ItemStatus[]; label: string }[] = [
  { statuses: ['todo'], label: 'To do' },
  // Approved means the desk is now carrying it out: it stays in progress, tagged Approved, until the desk reports it finished.
  { statuses: ['in-progress', 'sent-back', 'approved'], label: 'In progress' },
  // Dev-team projects: the QA desk checks it, then it waits for your sign-off.
  { statuses: ['qa', 'signoff'], label: 'QA' },
  { statuses: ['needs-you', 'held'], label: 'Needs you' },
  { statuses: ['done'], label: 'Done' },
];

/** QA runs on dev-team projects: finished tickets go to the QA desk, then to you, before Done. */
export function hasQa(template: TeamTemplate): boolean {
  return template === 'dev';
}

/** A role that reads like QA, for picking a dev-team project's QA desk when none is set. */
export function isQaRole(role: string): boolean {
  return /\b(qa|quality|tests?|testers?|testing)\b/i.test(role);
}

/** The desk to pick when a dev-team project has none set: the first whose role says QA or testing. */
export function defaultQaDesk(agents: Agent[]): Agent | undefined {
  return agents.find((a) => !a.isHuman && isQaRole(a.role));
}

export const TEMPLATE_LABEL: Record<TeamTemplate, string> = {
  business: 'Business team',
  dev: 'Dev team',
  blank: 'Blank',
};

export const MAX_TEAM = 12;

/** You can edit a ticket's description only before work starts. From In progress on, add a comment. */
export function canEditDescription(status: ItemStatus): boolean {
  return status === 'todo';
}
/** Longest ticket description, in markdown characters. */
export const MAX_DESCRIPTION = 4000;

/** Images per message, comment, note or ticket upload. */
export const MAX_ATTACHMENTS = 6;
/** Claude's per-image limit is 5 MB of base64, about 3.75 MB of file. */
export const MAX_ATTACHMENT_BYTES = 3_750_000;
export const ATTACHMENT_TYPES: Attachment['type'][] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** One report on a ticket, with what the reports list shows. */
export interface ReportInfo {
  url: string;
  /** The link's own label, e.g. "Read the report". */
  label: string;
  /** Desk whose workspace holds it. */
  agent: string;
  /** Path under that desk's reports/ folder. */
  file: string;
  name: string;
  /** First heading in the file, or its first line. */
  title: string | null;
  size: number;
  updatedAt: string | null;
  exists: boolean;
}

export interface ThreadResponse {
  thread: Thread;
  messages: Message[];
  hopLimit: number;
}
