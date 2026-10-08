import fs from 'node:fs';
import path from 'node:path';
import { stampNeedsYou } from '../shared/activity';
import type { Activity, ProjectAccess, ProjectMeta, Provider, RemovedProject, State, TeamTemplate } from '../shared/types';
import { defaultQaDesk, emptyAutoState, hasQa } from '../shared/types';
import { assignDeskNumbers } from '../shared/desks';
import { rewindCursor } from './cursor';
import { SKILL_ID, slug } from './paths';
import { seed } from './seed';

/**
 * Multi-project store.
 *
 *   data/projects.json            registry: owner + list of projects
 *   data/projects/<id>/db.json    one project's team, board, history
 *   workspaces/<id>/<agent>/      one agent's ROLE.md, memory.md, reports/
 *   data/archive/                 removed projects land here, until you delete them for good
 *   data/backup/                  the pre-projects db.json after migration
 *
 * A linked project folder (e.g. a git repo) is never written by the store.
 */

const DATA = path.resolve(process.cwd(), 'data');
const REGISTRY_FILE = path.join(DATA, 'projects.json');
const PROJECTS_DIR = path.join(DATA, 'projects');
const ARCHIVE_DIR = path.join(DATA, 'archive');
const BACKUP_DIR = path.join(DATA, 'backup');
const LEGACY_DB = path.join(DATA, 'db.json');
export const WORKSPACES = path.resolve(process.cwd(), 'workspaces');

const PROJECT_COLORS = ['#b4482f', '#3b6ea5', '#2f8f6b', '#8a5fb8', '#d98a2b', '#c9407a', '#4f8fd6', '#6b7f3a'];

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => now().replace(/[:.]/g, '-');

interface Registry {
  version: 1;
  owner: { name: string };
  projects: ProjectMeta[];
}

let registry: Registry | null = null;
let emptySeed = false;
let freshNames = false;
const handles = new Map<string, Project>();

export class Project {
  private timer: NodeJS.Timeout | null = null;
  /**
   * Archived or deleted. It never saves again, so a late log from a check, sign-in or huddle can't bring its
   * data/projects folder back, or write into a new project that took the same id.
   */
  private removed = false;

  constructor(
    readonly id: string,
    public state: State,
  ) {}

  get meta(): ProjectMeta {
    const meta = this.removed ? undefined : reg().projects.find((p) => p.id === this.id);
    if (!meta) throw new Error(`Project ${this.id} no longer exists`);
    return meta;
  }

  get workspace(): string {
    return path.join(WORKSPACES, this.id);
  }

  save(): void {
    if (this.removed) return;
    const file = stateFile(this.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.state, null, 2));
  }

  /** Debounced write so a burst of edits hits disk once. */
  commit(): void {
    if (this.removed) return;
    // Every change that moves a ticket commits, so this is where Needs-you tickets get their start time.
    stampNeedsYou(this.state.items, now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 200);
  }

  flush(): void {
    if (!this.timer || this.removed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  /** The project was archived or deleted: a write still waiting is dropped, and none comes after. */
  markRemoved(): void {
    this.removed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  log(agentId: string, text: string): Activity {
    const entry: Activity = { id: uid('act'), ts: now(), agentId, text };
    this.state.activity.unshift(entry);
    this.state.activity = this.state.activity.slice(0, 200);
    this.commit();
    return entry;
  }

  nextNumber(): number {
    this.state.seq = (this.state.seq ?? 0) + 1;
    return this.state.seq;
  }

  /** GA-12 style reference for an item. */
  ticket(item: { number?: number; id: string }): string {
    return item.number ? `${this.meta.key}-${item.number}` : item.id;
  }
}

function stateFile(id: string): string {
  return path.join(PROJECTS_DIR, id, 'db.json');
}

/**
 * Some project has desk runs on record, so HQ has run live here (the sim and the seeds never make runs). Read from
 * disk before initStore, for installs from before HQ kept settings.wentLive.
 */
export function deskRunsOnDisk(): boolean {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Partial<Registry>;
    return (r.projects ?? []).some((m) => {
      try {
        const runs = (JSON.parse(fs.readFileSync(stateFile(m.id), 'utf8')) as Partial<State>).runs;
        return Array.isArray(runs) && runs.length > 0;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** data/projects/<id>: the project's db.json and its attachments/ folder. Archived with the project. */
export function projectDataDir(id: string): string {
  return path.join(PROJECTS_DIR, id);
}

function saveRegistry(): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Call once at boot. `emptySeed` seeds new default projects without demo work (live mode). `freshNames` gives
 * each new or reset team its own desk names; off by default so tests get the template names.
 */
export function initStore(opts: { emptySeed: boolean; freshNames?: boolean }): void {
  emptySeed = opts.emptySeed;
  freshNames = opts.freshNames ?? false;
  reg();
  for (const meta of reg().projects) getProject(meta.id);
}

function reg(): Registry {
  if (registry) return registry;
  if (fs.existsSync(REGISTRY_FILE)) {
    registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Registry;
    registry.owner ??= { name: 'Patrick' };
    registry.projects ??= [];
    return registry;
  }
  registry = { version: 1, owner: { name: 'Patrick' }, projects: [] };
  if (fs.existsSync(LEGACY_DB)) {
    migrateLegacy(registry);
  } else {
    const meta = makeMeta({ name: 'My Company', key: 'HQ', path: null, access: 'read', template: 'business' }, registry, 'hq');
    registry.projects.push(meta);
    writeState(meta.id, seedTeam(meta.id, 'business', emptySeed, meta.name, []));
  }
  saveRegistry();
  return registry;
}

/**
 * A new team for project `id`. `avoid` is desk names other projects use, so the new desks get different ones.
 * Work it out before the new project joins the registry: listing projects loads each one, and a project with no
 * db.json yet would seed itself. Desk folders already in the project's workspace (from a reset, or a removed desk)
 * are never reused while another name is free: ensureWorkspace keeps an existing ROLE.md and memory.md.
 */
function seedTeam(id: string, template: TeamTemplate, empty: boolean, projectName: string, avoid: string[]): State {
  let staleIds: string[] = [];
  try {
    staleIds = fs.readdirSync(path.join(WORKSPACES, id), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* no workspace yet */
  }
  return seed(template, { empty, ownerName: reg().owner.name, projectName, randomNames: freshNames, avoidNames: avoid, staleIds });
}

/** Every desk name in every project. */
function deskNamesInUse(): string[] {
  return allProjects().flatMap((p) => p.state.agents.filter((a) => !a.isHuman).map((a) => a.name));
}

function writeState(id: string, state: State): void {
  const file = stateFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    // Windows refuses to rename a folder with an open handle inside; copy instead and keep the original.
    // Links are left out, never followed: a junction that loops back would copy forever.
    fs.cpSync(from, to, { recursive: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch {
      /* leave it */
    }
  }
}

/** The pre-projects layout (data/db.json + workspaces/<agent>) becomes project "hq". */
function migrateLegacy(r: Registry): void {
  const state = JSON.parse(fs.readFileSync(LEGACY_DB, 'utf8')) as State;
  const owner = state.agents.find((a) => a.isHuman);
  if (owner) r.owner.name = owner.name;

  const meta: ProjectMeta = {
    id: 'hq',
    key: 'HQ',
    name: state.company?.name || 'My Company',
    path: null,
    access: 'read',
    template: 'business',
    color: PROJECT_COLORS[0],
    createdAt: now(),
  };
  r.projects.push(meta);

  // Workspaces move, so the agent's cwd changes and SDK sessions cannot resume. memory.md carries over.
  for (const a of state.agents) delete a.sessionId;
  for (const item of state.items) {
    for (const link of item.links) link.url = link.url.replace(/^\/api\/workspaces\//, `/api/projects/${meta.id}/workspaces/`);
  }
  writeState(meta.id, migrateState(state));

  for (const a of state.agents) {
    const from = path.join(WORKSPACES, a.id);
    if (!a.isHuman && fs.existsSync(from)) moveDir(from, path.join(WORKSPACES, meta.id, a.id));
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.renameSync(LEGACY_DB, path.join(BACKUP_DIR, `db-before-projects-${stamp()}.json`));
  console.log(`[hq] migrated the single-project data into project "${meta.name}" (${meta.key})`);
}

/**
 * Which desks have each skill, as saved: only skill ids, and only this team's desks (not the founder), each
 * once. Anything else (a hand edit, a desk removed while HQ was off, a list that isn't one) drops out. Skills
 * no longer in the library drop out once it loads (initSkills in skills.ts, which this module can't import).
 */
function cleanSkillDesks(raw: unknown, agents: State['agents']): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const desks = new Set(agents.filter((a) => !a.isHuman).map((a) => a.id));
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!SKILL_ID.test(id)) continue;
    const kept = [...new Set((Array.isArray(list) ? list : []).filter((d): d is string => typeof d === 'string' && desks.has(d)))];
    if (kept.length) out[id] = kept;
  }
  return out;
}

/** Fill in fields added over time, and close out anything a restart killed. Exported for tests. */
export function migrateState(s: State, template?: TeamTemplate): State {
  s.runs ??= [];
  s.instructions ??= [];
  s.activity ??= [];
  s.seq ??= 0;
  s.connections ??= [];
  // Early builds saved the masked command or URL; only a fingerprint is kept now.
  for (const c of s.connections) delete (c as { target?: string }).target;
  s.checks ??= {};
  s.threads ??= [];
  s.messages ??= [];
  s.chat ??= { day: today(), wakes: 0 };
  s.huddles ??= [];
  s.huddleDay ??= { day: today(), started: 0 };
  s.huddleSeq ??= s.huddles.reduce((n, h) => Math.max(n, h.number ?? 0), 0);
  s.teamNotes ??= '';
  s.notesEveryRun ??= false;
  s.skillDesks = cleanSkillDesks(s.skillDesks, s.agents);
  s.auto ??= emptyAutoState();
  s.auto.heldWakes ??= [];
  s.auto.failStreak ??= 0;
  s.auto.usage ??= emptyAutoState().usage;
  // The Office's waiting clock. Before the restart notes below add history, so they don't count as the start.
  stampNeedsYou(s.items, now(), true);
  // A huddle mid-round when the server stopped: it stops too, and Resume picks it up.
  for (const h of s.huddles) {
    if (h.status !== 'running') continue;
    h.status = 'stopped';
    h.stopReason = 'restart';
  }
  for (const a of s.agents) a.running = false;
  // A test build kept the model per desk; it is the project's now.
  for (const a of s.agents) delete (a as { provider?: unknown }).provider;
  // Office desks: every desk gets a number it keeps (see shared/desks.ts).
  assignDeskNumbers(s.agents);
  // Nobody is mid-reply after a restart.
  for (const t of s.threads) {
    t.waiting = [];
    t.cursor ??= {};
  }

  // Dev-team projects get a QA desk once: the first whose role says QA or testing. After that your pick stands, none included.
  if (template && hasQa(template) && !s.qaPicked) {
    if (!s.agents.some((a) => a.qa && !a.isHuman)) {
      const qa = defaultQaDesk(s.agents);
      if (qa) qa.qa = true;
    }
    s.qaPicked = true;
  }

  if (!s.agents.some((a) => a.lead && !a.isHuman)) {
    const lead = s.agents.find((a) => a.id === 'dylan') ?? s.agents.find((a) => !a.isHuman);
    if (lead) lead.lead = true;
  }

  // Oldest first (runs are stored newest first): when a ticket had several starts cut off, the latest one is what it waits for.
  const restarted = new Set<string>();
  for (const r of [...s.runs].reverse()) {
    if (r.status === 'running' || r.status === 'queued') {
      r.status = 'failed';
      r.error = 'Interrupted by a server restart';
      r.finishedAt = now();
      // The desk never got to answer: un-read what it was woken for (or its ticket's thread), so it sees it again.
      const readThreadId = r.threadId ?? r.cursorThread;
      const readThread = readThreadId ? s.threads.find((t) => t.id === readThreadId) : undefined;
      if (readThread) rewindCursor(readThread, s.messages, r.agentId, r.cursorFrom, r.startedAt);
      const thread = r.reason === 'message' && r.threadId ? s.threads.find((t) => t.id === r.threadId) : undefined;
      // The team's own start (a hand-off, a chat wake, a QA check, Autopilot) starts again by itself, once. A second restart leaves it to you.
      const again = r.auto && r.reason !== 'plan' && r.reason !== 'huddle' ? (r.restarts ?? 0) + 1 : 0;
      // A plan cut off never planned: the lead plans again once it may.
      if (r.reason === 'plan' && s.auto.goal) delete s.auto.goal.lastPlanAt;
      const item = !thread && r.itemId ? s.items.find((i) => i.id === r.itemId) : undefined;
      if (thread && again === 1 && thread.status !== 'closed') {
        if (!s.auto.heldWakes.some((w) => w.threadId === thread.id && w.agentId === r.agentId)) {
          s.auto.heldWakes.push({ threadId: thread.id, agentId: r.agentId, at: r.finishedAt, why: 'restart', restarts: 1 });
        }
        thread.count += 1;
        s.messages.push({ id: uid('msg'), threadId: thread.id, n: thread.count, from: 'hq', to: [], text: 'A reply was cut off by a server restart. It starts again by itself when HQ can run it.', ts: r.finishedAt });
        thread.updatedAt = r.finishedAt;
      } else if (item && again === 1 && item.autoHold?.mine) {
        // A start of yours waits on this ticket: it goes first, and the team's cut-off run never takes its place.
        if (!restarted.has(item.id)) item.history.push({ ts: r.finishedAt, text: 'Run interrupted by a server restart. Your waiting start goes instead.' });
        restarted.add(item.id);
      } else if (item && again === 1) {
        item.autoHold = { reason: r.reason, at: r.finishedAt, why: 'restart', restarts: 1 };
        if (!restarted.has(item.id)) item.history.push({ ts: r.finishedAt, text: 'Run interrupted by a server restart. It starts again by itself when HQ can run it.' });
        restarted.add(item.id);
      } else if (item && again > 1) {
        item.autoSkip = { at: r.finishedAt, why: 'A server restart cut its run off twice.' };
        item.history.push({ ts: r.finishedAt, text: 'Run interrupted by a server restart again. It waits for you: use "Put them on it".' });
      } else if (thread) {
        // A reply cut off by a restart: pause the thread so Patrick can resume it, and leave the ticket alone.
        if (thread.status === 'open') {
          thread.status = 'paused';
          thread.pausedReason = 'restart';
        }
        thread.count += 1;
        s.messages.push({ id: uid('msg'), threadId: thread.id, n: thread.count, from: 'hq', to: [], text: 'A reply was cut off by a server restart. Resume to try again.', ts: r.finishedAt, undelivered: [r.agentId] });
        thread.updatedAt = r.finishedAt;
      } else if (item) {
        item.history.push({ ts: r.finishedAt, text: 'Run interrupted by a server restart. Use "Put them on it" to retry.' });
      }
    }
  }

  // Ticket numbers, oldest first. Items are stored newest first.
  for (const item of [...s.items].reverse()) {
    if (!item.number) item.number = ++s.seq;
  }
  return s;
}

export function listMeta(): ProjectMeta[] {
  return reg().projects;
}

export function getProject(id: string): Project | null {
  const cached = handles.get(id);
  if (cached) return cached;
  const meta = reg().projects.find((p) => p.id === id);
  if (!meta) return null;

  const file = stateFile(id);
  const fresh = !fs.existsSync(file);
  const state = fresh
    ? seedTeam(id, meta.template, true, meta.name, [])
    : migrateState(JSON.parse(fs.readFileSync(file, 'utf8')) as State, meta.template);
  const project = new Project(id, state);
  handles.set(id, project);
  project.save();
  return project;
}

export function allProjects(): Project[] {
  return reg()
    .projects.map((m) => getProject(m.id))
    .filter((p): p is Project => p !== null);
}

export interface ProjectInput {
  name: string;
  key: string;
  path: string | null;
  access: ProjectAccess;
  template: TeamTemplate;
  /** Finished tickets wait for your sign-off. Left out means on. */
  signoff?: boolean;
  /** The model every desk runs on. Left out means Claude. */
  provider?: Provider;
}

function makeMeta(input: ProjectInput, r: Registry, forcedId?: string): ProjectMeta {
  const base = forcedId ?? (slug(input.name) || 'project');
  // What a deleted project left behind (a file another program held open) is never taken over by a new one.
  const leftOver = (id: string) => !forcedId && (fs.existsSync(projectDataDir(id)) || fs.existsSync(path.join(WORKSPACES, id)));
  let id = base;
  for (let n = 2; r.projects.some((p) => p.id === id) || id === 'archive' || leftOver(id); n++) id = `${base}-${n}`;
  return {
    id,
    key: input.key,
    name: input.name,
    path: input.path,
    access: input.access,
    template: input.template,
    color: PROJECT_COLORS[r.projects.length % PROJECT_COLORS.length],
    createdAt: now(),
    signoff: input.signoff ?? true,
    ...(input.provider === 'gpt' ? { provider: 'gpt' as const } : {}),
  };
}

export function keyTaken(key: string, exceptId?: string): boolean {
  return reg().projects.some((p) => p.id !== exceptId && p.key.toUpperCase() === key.toUpperCase());
}

export function createProject(input: ProjectInput): Project {
  const r = reg();
  const avoid = freshNames ? deskNamesInUse() : [];
  const meta = makeMeta(input, r);
  r.projects.push(meta);
  saveRegistry();
  writeState(meta.id, seedTeam(meta.id, input.template, true, meta.name, avoid));
  return getProject(meta.id)!;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<ProjectMeta, 'name' | 'key' | 'path' | 'access' | 'signoff' | 'autopilot' | 'goalMode' | 'goal' | 'autoLimits' | 'provider'>>,
): ProjectMeta {
  const meta = reg().projects.find((p) => p.id === id);
  if (!meta) throw new Error('project not found');
  Object.assign(meta, patch);
  // Claude is the default: only GPT is written down.
  if (meta.provider !== 'gpt') delete meta.provider;
  saveRegistry();
  const project = getProject(id);
  if (project && patch.name) {
    project.state.company.name = patch.name;
    project.commit();
  }
  return meta;
}

/** A project that could not be archived, with the HTTP status the route should answer with. Nothing was moved. */
export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The errors Windows gives for a file or folder another program has open. */
const IN_USE = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'];
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code ?? '';
/** A path as you'd find it from HQ's folder: "workspaces/shop-app". */
const fromHq = (dir: string) => path.relative(path.dirname(DATA), dir).split(path.sep).join('/');

/**
 * Moves the project's data and workspaces into data/archive. The linked folder is untouched. Each folder moves whole
 * or not at all: when Windows refuses (another program has a file open), what already moved goes back, the project
 * stays as it was, and this throws an ArchiveError.
 */
export function archiveProject(id: string): string {
  const r = reg();
  const meta = r.projects.find((p) => p.id === id);
  if (!meta) throw new Error('project not found');
  const project = handles.get(id);
  project?.flush();

  const dest = path.join(ARCHIVE_DIR, `${id}-${stamp()}`);
  const metaFile = path.join(dest, 'project.json');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  const moved: [string, string][] = [];
  try {
    for (const [from, to] of [
      [projectDataDir(id), path.join(dest, 'data')],
      [path.join(WORKSPACES, id), path.join(dest, 'workspaces')],
    ]) {
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (e) {
    let stuck = false;
    for (const [from, to] of moved.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch {
        stuck = true;
        console.error(`[hq] could not move ${to} back to ${from}: move it back by hand`);
      }
    }
    // One holding a folder that could not go back keeps its project.json, so Removed projects names it.
    if (stuck) throw new ArchiveError(`Part of this project is stuck in ${fromHq(dest)}. Move it back by hand, then try again.`, 500);
    try {
      fs.rmSync(metaFile, { force: true });
      fs.rmdirSync(dest);
    } catch {
      /* leave it */
    }
    if (IN_USE.includes(codeOf(e))) throw new ArchiveError('Another program has a file of this project open. Close it and try again.', 409);
    throw new ArchiveError(`Could not move this project to data/archive (${codeOf(e) || 'error'}). Nothing was moved.`, 500);
  }

  project?.markRemoved();
  handles.delete(id);
  r.projects = r.projects.filter((p) => p.id !== id);
  saveRegistry();
  return dest;
}

/**
 * Removes the project and deletes its data and workspaces for good, where they are: board, history, attachments,
 * trash, and every desk's ROLE.md, memory.md and reports. The linked folder is untouched. Returns what is still there
 * because another program holds a file open, relative to HQ's folder. A new project never takes those folders over
 * (see makeMeta).
 */
export async function deleteProject(id: string): Promise<string[]> {
  const r = reg();
  if (!r.projects.some((p) => p.id === id)) throw new Error('project not found');
  handles.get(id)?.markRemoved();
  handles.delete(id);
  r.projects = r.projects.filter((p) => p.id !== id);
  saveRegistry();

  const left: string[] = [];
  for (const dir of [projectDataDir(id), path.join(WORKSPACES, id)]) {
    if (!(await removeForGood(dir))) left.push(fromHq(dir));
  }
  return left;
}

/**
 * Deletes a folder and everything in it. Links inside are removed, never followed. A file another program has open
 * is tried again for about a second. False when some of it is left.
 */
async function removeForGood(dir: string): Promise<boolean> {
  for (let tries = 1; tries <= 5; tries++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if (!IN_USE.includes(codeOf(e)) || tries === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return !fs.existsSync(dir);
}

function removedFolders(): string[] {
  try {
    return fs
      .readdirSync(ARCHIVE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** "shop-app-2026-10-08T18-03-32-453Z": the id, and when it was removed (see archiveProject). */
function parseRemovedFolder(folder: string): { id: string; at: string | null } {
  const m = /^(.*)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(folder);
  return m ? { id: m[1], at: `${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z` } : { id: folder, at: null };
}

/** Bytes on disk under `at`. Links count as themselves and are never followed. */
async function sizeOf(at: string): Promise<number> {
  const st = await fs.promises.lstat(at).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await fs.promises.readdir(at).catch(() => [] as string[])) total += await sizeOf(path.join(at, name));
  return total;
}

/** Removed projects waiting in data/archive, newest first. */
export async function listRemoved(): Promise<RemovedProject[]> {
  const out = await Promise.all(
    removedFolders().map(async (folder): Promise<RemovedProject | null> => {
      const dir = path.join(ARCHIVE_DIR, folder);
      // Deleted while this listed it (from another tab, or by hand): left out.
      const st = await fs.promises.stat(dir).catch(() => null);
      if (!st) return null;
      const { id, at } = parseRemovedFolder(folder);
      let meta: Partial<ProjectMeta> = {};
      try {
        meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'project.json'), 'utf8')) as Partial<ProjectMeta>;
      } catch {
        // A folder without it still shows, by its id; one deleted meanwhile doesn't.
        if (!fs.existsSync(dir)) return null;
      }
      const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
      return {
        folder,
        name: text(meta.name) ?? id,
        key: text(meta.key),
        color: text(meta.color),
        removedAt: at ?? st.mtime.toISOString(),
        bytes: await sizeOf(dir),
      };
    }),
  );
  return out.filter((r): r is RemovedProject => r !== null).sort((a, b) => b.removedAt.localeCompare(a.removedAt));
}

/** Deletes a removed project from data/archive for good. Only a folder there by that exact name. */
export async function deleteRemoved(folder: string): Promise<'deleted' | 'not-found' | 'in-use'> {
  if (!removedFolders().includes(folder)) return 'not-found';
  return (await removeForGood(path.join(ARCHIVE_DIR, folder))) ? 'deleted' : 'in-use';
}

export function resetProject(id: string, empty: boolean): State {
  const project = getProject(id);
  if (!project) throw new Error('project not found');
  // Its own current names count as taken too, so a reset brings in new people.
  project.state = seedTeam(id, project.meta.template, empty, project.meta.name, freshNames ? deskNamesInUse() : []);
  project.save();
  return project.state;
}

export function ownerName(): string {
  return reg().owner.name;
}

/** The founder is the same person in every project. */
export function setOwnerName(name: string): void {
  reg().owner.name = name;
  saveRegistry();
  for (const project of allProjects()) {
    const you = project.state.agents.find((a) => a.isHuman);
    if (you) {
      you.name = name;
      project.commit();
    }
  }
}

export function flushAll(): void {
  for (const project of handles.values()) project.flush();
}
