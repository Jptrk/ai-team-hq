import fs from 'node:fs';
import path from 'node:path';
import type { Activity, ProjectAccess, ProjectMeta, State, TeamTemplate } from '../shared/types';
import { slug } from './paths';
import { seed } from './seed';

/**
 * Multi-project store.
 *
 *   data/projects.json            registry: owner + list of projects
 *   data/projects/<id>/db.json    one project's team, board, history
 *   workspaces/<id>/<agent>/      one agent's ROLE.md, memory.md, reports/
 *   data/archive/                 removed projects land here, never deleted
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
const handles = new Map<string, Project>();

export class Project {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    public state: State,
  ) {}

  get meta(): ProjectMeta {
    const meta = reg().projects.find((p) => p.id === this.id);
    if (!meta) throw new Error(`Project ${this.id} no longer exists`);
    return meta;
  }

  get workspace(): string {
    return path.join(WORKSPACES, this.id);
  }

  save(): void {
    const file = stateFile(this.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.state, null, 2));
  }

  /** Debounced write so a burst of edits hits disk once. */
  commit(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 200);
  }

  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
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

/** data/projects/<id>: the project's db.json and its attachments/ folder. Archived with the project. */
export function projectDataDir(id: string): string {
  return path.join(PROJECTS_DIR, id);
}

function saveRegistry(): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/** Call once at boot. `empty` seeds new default projects without demo work (live mode). */
export function initStore(opts: { emptySeed: boolean }): void {
  emptySeed = opts.emptySeed;
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
    writeState(meta.id, seed('business', { empty: emptySeed, ownerName: registry.owner.name, projectName: meta.name }));
  }
  saveRegistry();
  return registry;
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
    fs.cpSync(from, to, { recursive: true });
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

/** Fill in fields added over time, and close out anything a restart killed. */
function migrateState(s: State): State {
  s.runs ??= [];
  s.instructions ??= [];
  s.activity ??= [];
  s.seq ??= 0;
  s.connections ??= [];
  s.checks ??= {};
  s.threads ??= [];
  s.messages ??= [];
  s.chat ??= { day: today(), wakes: 0 };
  for (const a of s.agents) a.running = false;
  // Nobody is mid-reply after a restart.
  for (const t of s.threads) {
    t.waiting = [];
    t.cursor ??= {};
  }

  if (!s.agents.some((a) => a.lead && !a.isHuman)) {
    const lead = s.agents.find((a) => a.id === 'dylan') ?? s.agents.find((a) => !a.isHuman);
    if (lead) lead.lead = true;
  }

  for (const r of s.runs) {
    if (r.status === 'running' || r.status === 'queued') {
      r.status = 'failed';
      r.error = 'Interrupted by a server restart';
      r.finishedAt = now();
      const thread = r.reason === 'message' && r.threadId ? s.threads.find((t) => t.id === r.threadId) : undefined;
      if (thread) {
        // A reply cut off by a restart: pause the thread so Patrick can resume it, and leave the ticket alone.
        if (thread.status === 'open') {
          thread.status = 'paused';
          thread.pausedReason = 'restart';
        }
        thread.count += 1;
        s.messages.push({ id: uid('msg'), threadId: thread.id, n: thread.count, from: 'hq', to: [], text: 'A reply was cut off by a server restart. Resume to try again.', ts: r.finishedAt, undelivered: [r.agentId] });
        thread.updatedAt = r.finishedAt;
      } else if (r.itemId) {
        const item = s.items.find((i) => i.id === r.itemId);
        item?.history.push({ ts: r.finishedAt, text: 'Run interrupted by a server restart. Use "Put them on it" to retry.' });
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
    ? seed(meta.template, { empty: true, ownerName: reg().owner.name, projectName: meta.name })
    : migrateState(JSON.parse(fs.readFileSync(file, 'utf8')) as State);
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
}

function makeMeta(input: ProjectInput, r: Registry, forcedId?: string): ProjectMeta {
  const base = forcedId ?? (slug(input.name) || 'project');
  let id = base;
  for (let n = 2; r.projects.some((p) => p.id === id) || id === 'archive'; n++) id = `${base}-${n}`;
  return {
    id,
    key: input.key,
    name: input.name,
    path: input.path,
    access: input.access,
    template: input.template,
    color: PROJECT_COLORS[r.projects.length % PROJECT_COLORS.length],
    createdAt: now(),
  };
}

export function keyTaken(key: string, exceptId?: string): boolean {
  return reg().projects.some((p) => p.id !== exceptId && p.key.toUpperCase() === key.toUpperCase());
}

export function createProject(input: ProjectInput): Project {
  const r = reg();
  const meta = makeMeta(input, r);
  r.projects.push(meta);
  saveRegistry();
  writeState(meta.id, seed(input.template, { empty: true, ownerName: r.owner.name, projectName: meta.name }));
  return getProject(meta.id)!;
}

export function updateProject(id: string, patch: Partial<Pick<ProjectMeta, 'name' | 'key' | 'path' | 'access'>>): ProjectMeta {
  const meta = reg().projects.find((p) => p.id === id);
  if (!meta) throw new Error('project not found');
  Object.assign(meta, patch);
  saveRegistry();
  const project = getProject(id);
  if (project && patch.name) {
    project.state.company.name = patch.name;
    project.commit();
  }
  return meta;
}

/** Moves the project's data and workspaces into data/archive. The linked folder is untouched. */
export function archiveProject(id: string): string {
  const r = reg();
  const meta = r.projects.find((p) => p.id === id);
  if (!meta) throw new Error('project not found');
  const project = handles.get(id);
  project?.flush();
  handles.delete(id);

  const dest = path.join(ARCHIVE_DIR, `${id}-${stamp()}`);
  const dataDir = path.dirname(stateFile(id));
  if (fs.existsSync(dataDir)) moveDir(dataDir, path.join(dest, 'data'));
  const ws = path.join(WORKSPACES, id);
  if (fs.existsSync(ws)) moveDir(ws, path.join(dest, 'workspaces'));
  fs.writeFileSync(path.join(dest, 'project.json'), JSON.stringify(meta, null, 2));

  r.projects = r.projects.filter((p) => p.id !== id);
  saveRegistry();
  return dest;
}

export function resetProject(id: string, empty: boolean): State {
  const project = getProject(id);
  if (!project) throw new Error('project not found');
  project.state = seed(project.meta.template, { empty, ownerName: reg().owner.name, projectName: project.meta.name });
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
