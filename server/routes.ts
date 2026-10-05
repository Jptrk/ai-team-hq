import express, { Router, type Response } from 'express';
import fs from 'node:fs';
import type { Attachment, Decision, EffortLevel, ItemStatus, ProjectAccess, ProjectMeta, ProjectSummary, ReportInfo, StateResponse, TeamTemplate, ThreadResponse, WorkItem } from '../shared/types';
import { canEditDescription, EFFORT_LEVELS, hasQa, isEffortLevel, MAX_ATTACHMENTS, MAX_GOAL, MAX_DESCRIPTION, signoffOn } from '../shared/types';
import { acceptInstruction, addAgent, parseSkills, refreshStatuses, removeAgent, settleInstructions } from './agents';
import { AttachmentError, pickAttachments, resolveAttachment, saveUpload } from './attachments';
import {
  ChatError,
  closeThread,
  createThread,
  findThread,
  HOP_LIMIT,
  messagesOf,
  noticeHandoff,
  postFounderMessage,
  resumeThread,
  threadForItem,
} from './chat';
import { titleFrom } from '../shared/plainText';
import { parseReportUrl, reportTitleFrom, type ReportUrlParts } from '../shared/reportUrl';
import { addComment } from './comments';
import {
  addConnection,
  cancelConnectionLogin,
  checkConnections,
  ConnectionError,
  listConnections,
  loginConnection,
  logoutConnection,
  openProjectTerminal,
  previewAdd,
  removeConnection,
  updateConnection,
  type ConnectionPatch,
} from './connections';
import { jsonOnly } from './http';
import { parseAddRequest } from '../shared/mcpSpec';
import { MAX_STEER } from '../shared/huddle';
import { addSteer, decideProposal, findHuddle, HUDDLES_PER_DAY, MAX_NOTES, notesConflict, pendingProposals, stripHuddle } from './huddle-core';
import { resumeHuddleRun, startHuddle, stopHuddleRun } from './huddles';
import { checkFolder, folderExists, KEY_PATTERN, suggestKey } from './paths';
import { backToWork, closesOnApprove, moveByHand, qaDeskOf, rerouteAllQa, setQaDesk } from './qa';
import { resolveReport } from './runner/claude';
import { autoGate, autoStatus, haltedHold, resumeProject } from './autopilot';
import { setEffort } from './settings';
import { cancelPreview, changeSkillDesks, installSkills, listLibrary, previewSkills, projectSkills, removeSkill, setScriptsAllowed, setSkillDesks, SkillError } from './skills';
import { officeState } from './office';
import { autoTick, cancelRun, deliver, isLive, kickoff, meta, mootRun, pauseAll, resumeAll } from './runner';
import {
  allProjects,
  archiveProject,
  createProject,
  getProject,
  keyTaken,
  listMeta,
  now,
  ownerName,
  resetProject,
  setOwnerName,
  updateProject,
  type Project,
} from './store';

export const router = Router();

const ITEM_STATUSES: ItemStatus[] = ['todo', 'in-progress', 'needs-you', 'approved', 'held', 'sent-back', 'qa', 'signoff', 'done'];
const DECISIONS: Decision[] = ['approve', 'hold', 'send-back', 'instruct'];
const TEMPLATES: TeamTemplate[] = ['business', 'dev', 'design', 'blank'];
const ACCESS: ProjectAccess[] = ['read', 'write'];

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Attachment ids from a request body, checked against the files on disk. Sends a 400 and returns null when bad. */
function attachmentsFrom(p: Project, body: unknown, res: Response): Attachment[] | null {
  try {
    return pickAttachments(p.id, (body as { attachments?: unknown } | undefined)?.attachments, 'you');
  } catch (e) {
    if (e instanceof AttachmentError) {
      res.status(400).json({ error: e.message });
      return null;
    }
    throw e;
  }
}

/** Text that may be empty when images carry the message. */
function textOk(text: string, attachments: Attachment[], max = 2000): string | null {
  if (text.length > max) return `Text can be at most ${max} characters`;
  if (!text && !attachments.length) return 'Write something or attach an image';
  return null;
}

function summary(p: Project): ProjectSummary {
  const s = p.state;
  return {
    ...p.meta,
    teamSize: s.agents.length,
    openItems: s.items.filter((i) => i.status !== 'done').length,
    // Paused chat threads wait on Patrick too.
    // So do tickets Autopilot left for you after their run failed.
    needsYou:
      s.items.filter((i) => i.status === 'needs-you' || i.status === 'signoff' || (i.autoSkip && !['done', 'held'].includes(i.status))).length +
      s.threads.filter((t) => t.status === 'paused').length +
      pendingProposals(s),
    running: s.agents.filter((a) => a.running).length,
    pathOk: p.meta.path ? folderExists(p.meta.path) : true,
    autoHold: (autoGate(p) ?? haltedHold(p))?.kind ?? null,
  };
}

type ProjectPatch = Partial<Pick<ProjectMeta, 'name' | 'key' | 'path' | 'access' | 'signoff' | 'autopilot' | 'goalMode' | 'goal' | 'autoLimits'>>;

/** Validate the editable project fields present in `body`. Exported for tests. */
export function readProjectPatch(body: Record<string, unknown>, exceptId?: string): { patch: ProjectPatch; error?: string } {
  const patch: ProjectPatch = {};
  if ('name' in body) {
    const name = str(body.name);
    if (!name || name.length > 60) return { patch, error: 'Name must be 1-60 characters' };
    patch.name = name;
  }
  if ('key' in body) {
    const key = str(body.key).toUpperCase();
    if (!KEY_PATTERN.test(key)) return { patch, error: 'Key must be 2-10 letters or digits, starting with a letter' };
    if (keyTaken(key, exceptId)) return { patch, error: `Key ${key} is already used by another project` };
    patch.key = key;
  }
  if ('path' in body) {
    const raw = str(body.path);
    if (!raw) patch.path = null;
    else {
      const check = checkFolder(raw, listMeta(), exceptId);
      if (!check.ok) return { patch, error: check.error ?? 'Folder not usable' };
      patch.path = check.path;
    }
  }
  if ('access' in body) {
    if (!ACCESS.includes(body.access as ProjectAccess)) return { patch, error: 'Access must be read or write' };
    patch.access = body.access as ProjectAccess;
  }
  // Tickets already waiting for sign-off stay there when you turn it off; new finished work goes to Done.
  if ('signoff' in body) {
    if (typeof body.signoff !== 'boolean') return { patch, error: 'signoff must be true or false' };
    patch.signoff = body.signoff;
  }
  for (const flag of ['autopilot', 'goalMode'] as const) {
    if (!(flag in body)) continue;
    if (typeof body[flag] !== 'boolean') return { patch, error: `${flag} must be true or false` };
    patch[flag] = body[flag] as boolean;
  }
  if ('goal' in body) {
    if (body.goal !== null && typeof body.goal !== 'string') return { patch, error: 'goal must be text' };
    const goal = str(body.goal);
    if (goal.length > MAX_GOAL) return { patch, error: `The goal can be at most ${MAX_GOAL} characters` };
    patch.goal = goal || undefined;
  }
  if ('autoLimits' in body) {
    const l = body.autoLimits as { runs?: unknown; usd?: unknown } | null;
    const runs = l && typeof l === 'object' ? l.runs : undefined;
    const usd = l && typeof l === 'object' ? l.usd : undefined;
    if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1 || runs > 500) return { patch, error: 'The daily run limit must be a whole number from 1 to 500' };
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 1 || usd > 1000) return { patch, error: 'The daily spend limit must be from $1 to $1000' };
    patch.autoLimits = { runs, usd: Math.round(usd * 100) / 100 };
  }
  return { patch };
}

/** Goal mode needs a goal to work toward and Autopilot to work through its tickets. Judged on the project as it would be. Exported for tests. */
export function goalModeProblem(meta: Pick<ProjectMeta, 'goalMode' | 'goal' | 'autopilot'>): string | null {
  if (!meta.goalMode) return null;
  if (!meta.goal?.trim()) return 'Goal mode needs a goal: write what the team should work toward.';
  if (!meta.autopilot) return 'Goal mode needs Autopilot on, so the team works through the tickets it plans.';
  return null;
}

// ---------- global ----------

router.get('/meta', (_req, res) => {
  res.json({ ...meta(), owner: ownerName() });
});

/** The settings body: `effort` is a level, or null for the model's default. Exported for tests. */
export function readSettingsPatch(body: Record<string, unknown>): { effort?: EffortLevel | null; paused?: boolean; error?: string } {
  if (!('effort' in body) && !('paused' in body)) return { error: 'Nothing to change' };
  const out: { effort?: EffortLevel | null; paused?: boolean } = {};
  if ('effort' in body) {
    const effort = body.effort;
    if (effort !== null && !isEffortLevel(effort)) return { error: `effort must be ${EFFORT_LEVELS.slice(0, -1).join(', ')} or ${EFFORT_LEVELS.at(-1)}, or null` };
    out.effort = effort;
  }
  if ('paused' in body) {
    if (typeof body.paused !== 'boolean') return { error: 'paused must be true or false' };
    out.paused = body.paused;
  }
  return out;
}

/** Settings for all of HQ, every project: the effort level, and Pause/Resume for everything the team starts on its own. Answers with the new meta. */
router.patch('/settings', jsonOnly, (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
  const { effort, paused, error } = readSettingsPatch(body);
  if (error) return res.status(400).json({ error });
  try {
    if (effort !== undefined) setEffort(effort);
    if (paused === true) pauseAll();
    else if (paused === false) resumeAll();
  } catch (e) {
    console.error('[hq] settings:', e instanceof Error ? e.message : 'error');
    return res.status(500).json({ error: 'Could not save the setting.' });
  }
  res.json({ ...meta(), owner: ownerName() });
});

/** Live check for the "project folder" field. */
router.get('/fs/check', (req, res) => {
  const except = typeof req.query.except === 'string' ? req.query.except : undefined;
  res.json(checkFolder(String(req.query.path ?? ''), listMeta(), except));
});

router.get('/projects', (_req, res) => {
  res.json(allProjects().map(summary));
});

router.post('/projects', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = str(body.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const withKey = { ...body, key: str(body.key) || suggestKey(name, listMeta().map((m) => m.key)) };
  const { patch, error } = readProjectPatch(withKey);
  if (error) return res.status(400).json({ error });

  const template = (body.template ?? (patch.path ? 'dev' : 'business')) as TeamTemplate;
  if (!TEMPLATES.includes(template)) return res.status(400).json({ error: 'Unknown team template' });
  const p = createProject({
    name: patch.name ?? name,
    key: patch.key!,
    path: patch.path ?? null,
    access: patch.access ?? 'read',
    template,
    signoff: patch.signoff ?? true,
  });
  res.status(201).json(summary(p));
});

// ---------- skills: one library for every project ----------

/** A SkillError carries its own status and a safe sentence. Anything else stays generic. */
function skillFailed(res: Response, e: unknown, fallback: string) {
  if (e instanceof SkillError) return res.status(e.status).json({ error: e.message });
  console.error('[hq] skills:', e instanceof Error ? e.message : 'error');
  return res.status(500).json({ error: fallback });
}

router.get('/skills', (_req, res) => {
  res.json(listLibrary());
});

/**
 * Fetch a GitHub link into a staging folder and list the skills in it. Installs nothing. 409 while another fetch
 * or install runs. The page may send its own token, so Cancel can stop the fetch before this answers.
 */
router.post('/skills/preview', jsonOnly, async (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown; token?: unknown };
  try {
    res.json(await previewSkills(body.url, body.token));
  } catch (e) {
    skillFailed(res, e, 'Could not fetch that link');
  }
});

/** Stop a fetch that is still running, or throw away a fetched repo without installing. */
router.delete('/skills/preview/:token', jsonOnly, (req, res) => {
  cancelPreview(String(req.params.token));
  res.json({ ok: true });
});

/** Install the picked skills from a fetched repo. */
router.post('/skills/install', jsonOnly, async (req, res) => {
  const body = (req.body ?? {}) as { token?: unknown; picks?: unknown };
  try {
    res.status(201).json(await installSkills(body.token, body.picks));
  } catch (e) {
    skillFailed(res, e, 'Could not install those skills');
  }
});

/** Allow or stop a skill's scripts, everywhere. */
router.patch('/skills/:id', jsonOnly, (req, res) => {
  const on = (req.body as { scriptsAllowed?: unknown } | undefined)?.scriptsAllowed;
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'scriptsAllowed must be true or false' });
  try {
    res.json(setScriptsAllowed(String(req.params.id), on));
  } catch (e) {
    skillFailed(res, e, 'Could not change that skill');
  }
});

/** Delete a skill from HQ, and from every project's desks. */
router.delete('/skills/:id', jsonOnly, (req, res) => {
  try {
    res.json(removeSkill(String(req.params.id)));
  } catch (e) {
    skillFailed(res, e, 'Could not remove that skill');
  }
});

// ---------- one project ----------

const project = Router({ mergeParams: true });
const P = (res: Response) => res.locals.project as Project;

// Anything you change in a project gives what the team does on its own a pass straight away: held work may start, and
// with Autopilot on, a desk you just freed picks its next ticket. The minute sweep catches the rest.
project.use((req, res, next) => {
  // Not removing the project: there is nothing left to work on.
  const removing = req.method === 'DELETE' && req.path === '/';
  if (req.method !== 'GET' && !removing && typeof res.on === 'function') {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      try {
        autoTick(P(res));
      } catch (e) {
        console.error(`[hq] ${P(res).meta.key} autopilot:`, e instanceof Error ? e.message : e);
      }
    });
  }
  next();
});

router.use(
  '/projects/:pid',
  (req, res, next) => {
    const p = getProject(String(req.params.pid));
    if (!p) return res.status(404).json({ error: 'project not found' });
    res.locals.project = p;
    next();
  },
  project,
);

project.get('/', (_req, res) => {
  res.json(summary(P(res)));
});

project.patch('/', (req, res) => {
  const p = P(res);
  const { patch, error } = readProjectPatch((req.body ?? {}) as Record<string, unknown>, p.id);
  if (error) return res.status(400).json({ error });
  // Autopilot off takes Goal mode with it: there is nothing to work through the tickets it would plan.
  if (patch.autopilot === false && !('goalMode' in patch)) patch.goalMode = false;
  const problem = goalModeProblem({ ...p.meta, ...patch });
  if (problem) return res.status(400).json({ error: problem });
  updateProject(p.id, patch);
  // A raised limit, or Autopilot just turned on: held work and free desks may start now.
  autoTick(p);
  res.json(summary(p));
});

/** Autopilot stopped itself here after 3 automatic runs failed in a row: you resume it. Answers with the project's auto status. */
project.post('/auto/resume', (_req, res) => {
  const p = P(res);
  resumeProject(p);
  p.commit();
  autoTick(p);
  res.json(autoStatus(p));
});

/** Archive: data and workspaces move to data/archive. The linked folder is never touched. */
project.delete('/', (_req, res) => {
  const p = P(res);
  if (listMeta().length <= 1) return res.status(409).json({ error: 'This is the only project. Create another one first.' });
  if (p.state.agents.some((a) => a.running) || p.state.runs.some((r) => r.status === 'queued' || r.status === 'running')) {
    return res.status(409).json({ error: 'Agents are still working on this project. Wait for their runs to finish.' });
  }
  const archivedTo = archiveProject(p.id);
  res.json({ ok: true, archivedTo });
});

project.get('/state', (_req, res) => {
  const p = P(res);
  // Messages stay out of the 3-second poll; a thread's messages load when it opens. Same for a huddle's board and transcript.
  // What the team does on its own goes as a status (why it waits, today's count), not the raw held wakes.
  const { messages: _messages, huddles, auto: _auto, ...rest } = p.state;
  const body: StateResponse = { ...rest, huddles: huddles.map(stripHuddle), office: officeState(p), huddleLimit: HUDDLES_PER_DAY, meta: meta(), project: p.meta, auto: autoStatus(p) };
  res.json(body);
});

// ---------- chat ----------

function threadBody(p: Project, threadId: string): ThreadResponse | null {
  const thread = findThread(p.state, threadId);
  if (!thread) return null;
  return { thread, messages: messagesOf(p.state, thread.id), hopLimit: HOP_LIMIT };
}

/** Open a thread. Marks it read for Patrick. */
project.get('/threads/:tid', (req, res) => {
  const p = P(res);
  const thread = findThread(p.state, String(req.params.tid));
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  if (thread.youSeen !== thread.count) {
    thread.youSeen = thread.count;
    p.commit();
  }
  res.json(threadBody(p, thread.id));
});

/** Patrick starts a thread, optionally about a ticket, with a first message. */
project.post('/threads', (req, res) => {
  const p = P(res);
  const s = p.state;
  const text = str(req.body?.text);
  const title = str(req.body?.title);
  const itemId = str(req.body?.itemId);
  const attachments = attachmentsFrom(p, req.body, res);
  if (!attachments) return;
  const bad = textOk(text, attachments);
  if (bad) return res.status(400).json({ error: bad });
  if (title.length > 80) return res.status(400).json({ error: 'Title must be at most 80 characters' });
  let thread;
  if (itemId) {
    const item = s.items.find((i) => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'ticket not found' });
    thread = threadForItem(s, item, p.ticket(item), 'you');
  } else {
    thread = createThread(s, { title: title || titleFrom(text, attachments.length, 60, 'thread'), createdBy: 'you' });
  }
  const posted = postFounderMessage(s, thread, text, attachments);
  p.commit();
  deliver(p, thread.id, posted.deliver);
  res.status(201).json({ ...threadBody(p, thread.id), woke: posted.deliver });
});

project.post('/threads/:tid/messages', (req, res) => {
  const p = P(res);
  const thread = findThread(p.state, String(req.params.tid));
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const text = str(req.body?.text);
  const attachments = attachmentsFrom(p, req.body, res);
  if (!attachments) return;
  const bad = textOk(text, attachments);
  if (bad) return res.status(400).json({ error: bad });
  const posted = postFounderMessage(p.state, thread, text, attachments);
  p.commit();
  deliver(p, thread.id, posted.deliver);
  res.status(201).json({ ...threadBody(p, thread.id), woke: posted.deliver });
});

project.post('/threads/:tid/resume', (req, res) => {
  const p = P(res);
  const thread = findThread(p.state, String(req.params.tid));
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  try {
    const woke = resumeThread(p.state, thread);
    p.commit();
    deliver(p, thread.id, woke);
    res.json({ ...threadBody(p, thread.id), woke });
  } catch (e) {
    if (e instanceof ChatError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

project.post('/threads/:tid/close', (req, res) => {
  const p = P(res);
  const thread = findThread(p.state, String(req.params.tid));
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  closeThread(p.state, thread);
  p.commit();
  res.json(threadBody(p, thread.id));
});

project.get('/agents/:id', (req, res) => {
  const s = P(res).state;
  const agent = s.agents.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const items = s.items.filter((i) => i.assignee === agent.id);
  const activity = s.activity.filter((a) => a.agentId === agent.id).slice(0, 20);
  const runs = s.runs.filter((r) => r.agentId === agent.id).slice(0, 20);
  res.json({ agent, items, activity, runs });
});

project.post('/agents', (req, res) => {
  const p = P(res);
  const name = str(req.body?.name);
  const role = str(req.body?.role);
  if (!name || name.length > 40) return res.status(400).json({ error: 'Name must be 1-40 characters' });
  if (!role || role.length > 60) return res.status(400).json({ error: 'Role must be 1-60 characters' });
  const result = addAgent(p, { name, role, skills: parseSkills(req.body?.skills), lead: req.body?.lead === true });
  if (typeof result === 'string') return res.status(409).json({ error: result });
  res.status(201).json(result);
});

project.patch('/agents/:id', (req, res) => {
  const p = P(res);
  const agent = p.state.agents.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = str(body.name);
  const role = str(body.role);
  if ('name' in body && (!name || name.length > 40)) return res.status(400).json({ error: 'Name must be 1-40 characters' });
  if ('role' in body && (!role || role.length > 60)) return res.status(400).json({ error: 'Role must be 1-60 characters' });

  // The founder is one person across every project.
  if (name && agent.isHuman) setOwnerName(name);
  else if (name) agent.name = name;
  if (role) agent.role = role;
  if ('skills' in body && !agent.isHuman) agent.skills = parseSkills(body.skills);
  if (body.lead === true && !agent.isHuman) for (const a of p.state.agents) a.lead = a.id === agent.id;
  // Dev-team projects: one QA desk, or none.
  let recheck: WorkItem[] = [];
  if ('qa' in body && !agent.isHuman) {
    if (typeof body.qa !== 'boolean') return res.status(400).json({ error: 'qa must be true or false' });
    if (body.qa && !hasQa(p.meta.template)) return res.status(400).json({ error: 'QA is for dev-team projects' });
    if (body.qa) setQaDesk(p.state, agent.id);
    else if (agent.qa) setQaDesk(p.state, null);
    p.log(
      'you',
      body.qa
        ? `${agent.name} is now the QA desk`
        : `${agent.name} is no longer the QA desk; finished tickets ${signoffOn(p.meta) ? 'come to you to sign off' : 'go straight to Done'}`,
    );
    // Tickets waiting in QA go to the new QA desk, or to your sign-off, instead of waiting on a desk that stopped.
    recheck = rerouteAllQa(p.state);
  }
  p.commit();
  for (const item of recheck) kickoff(p, item.id, 'qa');
  res.json(agent);
});

project.delete('/agents/:id', (req, res) => {
  const p = P(res);
  const wasQa = Boolean(p.state.agents.find((a) => a.id === req.params.id)?.qa);
  const error = removeAgent(p, String(req.params.id));
  if (error) return res.status(error === 'agent not found' ? 404 : 409).json({ error });
  // The QA desk left: tickets waiting in QA come to your sign-off (or a QA desk, if there still is one).
  if (wasQa) {
    const recheck = rerouteAllQa(p.state);
    p.commit();
    for (const item of recheck) kickoff(p, item.id, 'qa');
  }
  res.json({ ok: true });
});

project.post('/instructions', (req, res) => {
  const p = P(res);
  const text = str(req.body?.text);
  const attachments = attachmentsFrom(p, req.body, res);
  if (!attachments) return;
  const bad = textOk(text, attachments);
  if (bad) return res.status(400).json({ error: bad });
  const result = acceptInstruction(p, text, attachments);
  if (!result) return res.status(409).json({ error: 'This project has no teammates yet. Add one on the Team tab.' });
  const run = kickoff(p, result.item.id, 'instruction', undefined, attachments, { includeNotes: req.body?.includeNotes === true });
  res.status(201).json({ ...result, run });
});

project.post('/items/:id/decision', (req, res) => {
  const p = P(res);
  const s = p.state;
  const item = s.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });

  const decision = req.body?.decision as Decision;
  if (!DECISIONS.includes(decision)) return res.status(400).json({ error: 'unknown decision' });
  const note = str(req.body?.note);
  if (note.length > 2000) return res.status(400).json({ error: 'The note can be at most 2000 characters' });
  const images = attachmentsFrom(p, req.body, res);
  if (!images) return;
  const agent = s.agents.find((a) => a.id === item.assignee);
  const name = agent?.name ?? item.assignee;
  const ref = p.ticket(item);

  // Finished and waiting for your sign-off (or QA gave up on it): approving signs it off. Nothing is left for a desk to do.
  const signOff = decision === 'approve' && closesOnApprove(item);
  // An instruction needs something to say. Checked before anything changes.
  if (decision === 'instruct' && !note && !images.length) return res.status(400).json({ error: 'instruct needs a note' });
  // You decided: whatever the team had held or Autopilot had left on this ticket is settled by your decision.
  delete item.autoHold;
  delete item.autoSkip;

  switch (decision) {
    case 'approve':
      if (signOff) {
        item.status = 'done';
        item.history.push({ ts: now(), text: item.qa?.escalated ? 'Accepted by you as it is, after QA' : 'Signed off by you' });
        p.log('you', `Signed off ${ref} "${item.title}"`);
        break;
      }
      item.status = 'approved';
      item.history.push({ ts: now(), text: 'Approved by you' });
      p.log(item.assignee, `Approved: ${ref} "${item.title}", ${name} is executing`);
      if (agent) agent.currentTask = `Executing: ${item.title}`;
      break;
    case 'hold':
      item.status = 'held';
      item.history.push({ ts: now(), text: note ? `Held: ${note}` : 'Held by you' });
      p.log('you', `Held ${ref} "${item.title}"`);
      break;
    case 'send-back':
      // Your send-back makes it work again; QA counts fails afresh.
      backToWork(item);
      item.status = 'sent-back';
      item.history.push({ ts: now(), text: note ? `Sent back to ${name}: ${note}` : `Sent back to ${name}` });
      p.log(item.assignee, `${ref} "${item.title}" came back for another pass`);
      if (agent) agent.currentTask = `Reworking: ${item.title}`;
      break;
    case 'instruct':
      // Your instruction makes it work again too.
      backToWork(item);
      item.status = 'in-progress';
      item.history.push({ ts: now(), text: note ? `Instruction from you: ${note}` : 'Instruction from you (images)' });
      p.log(item.assignee, `New instruction on ${ref} "${item.title}"`);
      if (agent) agent.currentTask = `${item.title} (with your note)`;
      break;
  }
  if (agent) agent.lastActive = now();
  // Your note, with any images, also lands in the ticket's comments.
  if (note || images.length) addComment(item, { from: 'you', text: note, attachments: images, kind: 'note' });
  settleInstructions(s);
  refreshStatuses(s);
  p.commit();

  // Live mode: the desk picks the ticket back up. Hold needs nothing from them.
  const opts = { includeNotes: req.body?.includeNotes === true };
  let run = null;
  if (signOff) {
    // A handed-off ticket reports back once you sign it off; only that, when the desk already heard it was finished.
    const posted = noticeHandoff(s, item, item.assignee, `Done with ${ref} (signed off by you).`, `Signed off: ${ref} is done.`);
    if (posted) {
      p.commit();
      deliver(p, posted.threadId, posted.deliver);
    }
  } else if (decision === 'approve') {
    run = kickoff(p, item.id, 'approved', note || undefined, images, opts);
    // Nobody to carry it out (it is yours, or its desk is gone): approving finishes it.
    if (!agent || agent.isHuman) {
      item.status = 'done';
      item.history.push({ ts: now(), text: 'Done: approved, nothing left for a desk to do' });
      settleInstructions(s);
      refreshStatuses(s);
      p.commit();
    }
  }
  else if (decision === 'send-back') run = kickoff(p, item.id, 'send-back', note || undefined, images, opts);
  else if (decision === 'instruct') run = kickoff(p, item.id, 'instruct', note, images, opts);

  res.json({ item, run });
});

project.patch('/items/:id', (req, res) => {
  const p = P(res);
  const s = p.state;
  const item = s.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!('status' in body) && !('summary' in body)) return res.status(400).json({ error: 'Send a status or a summary' });

  // Check everything first, so a request with one bad field changes nothing.
  let nextStatus: ItemStatus | undefined;
  if ('status' in body) {
    nextStatus = body.status as ItemStatus;
    if (!ITEM_STATUSES.includes(nextStatus)) return res.status(400).json({ error: 'unknown status' });
  }
  let nextSummary: string | undefined;
  if ('summary' in body) {
    if (typeof body.summary !== 'string') return res.status(400).json({ error: 'summary must be text' });
    // The description can change only before work starts, judged by the status before this request.
    if (!canEditDescription(item.status)) {
      return res.status(409).json({ error: 'This ticket is already being worked on, so its description is locked. Add a comment instead.' });
    }
    nextSummary = body.summary.replace(/\s+$/, '');
    if (nextSummary.length > MAX_DESCRIPTION) return res.status(400).json({ error: `The description can be at most ${MAX_DESCRIPTION} characters` });
  }

  if (nextSummary !== undefined && nextSummary !== item.summary) {
    item.summary = nextSummary;
    item.history.push({ ts: now(), text: 'Description edited by you' });
  }
  // Into QA the QA desk checks it; into sign-off Approve closes it; anywhere else it stops waiting on a sign-off.
  const from = item.status;
  const moved = nextStatus !== undefined ? moveByHand(s, item, nextStatus) : null;
  // You moved it: Autopilot giving up on it no longer applies, and a held start that no longer fits where it is now is dropped.
  if (nextStatus !== undefined && nextStatus !== from) {
    delete item.autoSkip;
    const moot = item.autoHold ? mootRun(item.autoHold.reason, item.status) : null;
    if (moot) {
      item.history.push({ ts: now(), text: `Dropped a held start: ${moot}` });
      delete item.autoHold;
    }
  }
  settleInstructions(s);
  refreshStatuses(s);
  p.commit();
  if (moved === 'qa') kickoff(p, item.id, 'qa');
  if (moved === 'done') {
    // A handed-off ticket you mark done reports back, as one a desk finishes does; as signed off, when the desk already heard it was finished.
    const posted = noticeHandoff(s, item, item.assignee, `Done with ${p.ticket(item)} (marked done by you).`, `Signed off: ${p.ticket(item)} is done.`);
    if (posted) {
      p.commit();
      deliver(p, posted.threadId, posted.deliver);
    }
  }
  res.json(item);
});

/** You comment on a ticket. The desk that owns it is woken to answer. */
project.post('/items/:id/comments', (req, res) => {
  const p = P(res);
  const s = p.state;
  const item = s.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const text = str(req.body?.text);
  const attachments = attachmentsFrom(p, req.body, res);
  if (!attachments) return;
  const bad = textOk(text, attachments);
  if (bad) return res.status(400).json({ error: bad });
  const comment = addComment(item, { from: 'you', text, attachments });
  p.log('you', `Commented on ${p.ticket(item)} "${item.title}"`);
  p.commit();
  const agent = s.agents.find((a) => a.id === item.assignee && !a.isHuman);
  // A desk that is off shift is not woken; the comment waits on the ticket.
  const run = agent && agent.status !== 'off' ? kickoff(p, item.id, 'comment', text || undefined, attachments, { includeNotes: req.body?.includeNotes === true }) : null;
  res.status(201).json({ item, comment, run });
});

/** Add images to a ticket's description. Wakes nobody. */
project.post('/items/:id/attachments', (req, res) => {
  const p = P(res);
  const item = p.state.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const attachments = attachmentsFrom(p, req.body, res);
  if (!attachments) return;
  if (!attachments.length) return res.status(400).json({ error: 'Attach at least one image' });
  const current = item.attachments ?? [];
  const added = attachments.filter((a) => !current.some((c) => c.id === a.id));
  if (!added.length) return res.json(item);
  const cap = MAX_ATTACHMENTS * 4;
  if (current.length + added.length > cap) return res.status(400).json({ error: `A ticket description can hold at most ${cap} images` });
  item.attachments = [...current, ...added];
  item.history.push({ ts: now(), text: `You attached ${added.length} image${added.length === 1 ? '' : 's'}` });
  p.commit();
  res.json(item);
});

/** Put the assignee on a ticket right now (live mode only). */
project.post('/items/:id/run', (req, res) => {
  const p = P(res);
  if (!isLive()) return res.status(409).json({ error: 'Live runner is off. Set HQ_RUNNER=claude in .env to enable it.' });
  const item = p.state.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  // A ticket in QA gets its check again; anything else goes to its owner.
  const inQa = item.status === 'qa';
  const agent = inQa ? qaDeskOf(p.state) : p.state.agents.find((a) => a.id === item.assignee);
  if (!agent || agent.isHuman) return res.status(400).json({ error: inQa ? 'This project has no QA desk. Pick one on the Team tab.' : 'no agent owns this ticket' });
  if (agent.running) return res.status(409).json({ error: `${agent.name} is already running` });
  // An approved ticket that did not get finished (a failed run) is retried as the approved action.
  const run = kickoff(p, item.id, inQa ? 'qa' : item.status === 'approved' ? 'approved' : 'manual');
  if (!run) return res.status(500).json({ error: 'could not queue the run' });
  res.status(202).json(run);
});

project.post('/runs/:id/cancel', (req, res) => {
  const p = P(res);
  if (!p.state.runs.some((r) => r.id === req.params.id)) return res.status(404).json({ error: 'run not found' });
  if (!cancelRun(String(req.params.id))) return res.status(404).json({ error: 'that run is not running' });
  res.json({ ok: true });
});

// ---------- huddles and team notes ----------

/** One huddle with its board and transcript. The poll only carries summaries. */
project.get('/huddles/:hid', (req, res) => {
  const h = findHuddle(P(res).state, String(req.params.hid));
  if (!h) return res.status(404).json({ error: 'huddle not found' });
  res.json(h);
});

/** Start a huddle. Its desks get to work right away (live mode spends usage; sim mode answers with canned turns). */
project.post('/huddles', (req, res) => {
  const p = P(res);
  const out = startHuddle(p, req.body);
  if ('error' in out) return res.status(out.status).json({ error: out.error });
  res.status(201).json(out);
});

/** A note from you to the huddle. Desks see it from their next turn. */
project.post('/huddles/:hid/steer', (req, res) => {
  const p = P(res);
  const h = findHuddle(p.state, String(req.params.hid));
  if (!h) return res.status(404).json({ error: 'huddle not found' });
  if (h.status === 'done') return res.status(409).json({ error: 'This huddle is finished. Start a new one to keep going.' });
  const text = str(req.body?.text);
  if (!text || text.length > MAX_STEER) return res.status(400).json({ error: `The note must be 1-${MAX_STEER} characters` });
  addSteer(h, text);
  p.commit();
  res.status(201).json(h);
});

project.post('/huddles/:hid/stop', (req, res) => {
  const p = P(res);
  const why = stopHuddleRun(p, String(req.params.hid));
  if (why) return res.status(why === 'huddle not found' ? 404 : 409).json({ error: why });
  res.json(findHuddle(p.state, String(req.params.hid)));
});

project.post('/huddles/:hid/resume', (req, res) => {
  const p = P(res);
  const why = resumeHuddleRun(p, String(req.params.hid));
  if (why) return res.status(why === 'huddle not found' ? 404 : 409).json({ error: why });
  res.json(findHuddle(p.state, String(req.params.hid)));
});

/** Approve or decline what a huddle proposed. An approved ticket lands in To do and waits for you to start it. */
project.post('/huddles/:hid/proposals/:prid', (req, res) => {
  const p = P(res);
  const h = findHuddle(p.state, String(req.params.hid));
  if (!h) return res.status(404).json({ error: 'huddle not found' });
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'decline') return res.status(400).json({ error: 'decision must be approve or decline' });
  const out = decideProposal(p, h, String(req.params.prid), decision);
  if (typeof out === 'string') return res.status(409).json({ error: out });
  refreshStatuses(p.state);
  p.commit();
  res.json({ huddle: h, ...out });
});

/** Edit the team notes, or whether every run gets them. base: the notes the edit started from, so a change made meanwhile is not lost. */
project.put('/team-notes', (req, res) => {
  const p = P(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!('teamNotes' in body) && !('notesEveryRun' in body)) return res.status(400).json({ error: 'Send teamNotes or notesEveryRun' });
  if ('teamNotes' in body) {
    if (typeof body.teamNotes !== 'string') return res.status(400).json({ error: 'teamNotes must be text' });
    if (body.base !== undefined && typeof body.base !== 'string') return res.status(400).json({ error: 'base must be text' });
    const next = body.teamNotes.replace(/\s+$/, '');
    if (next.length > MAX_NOTES) return res.status(400).json({ error: `The team notes can be at most ${MAX_NOTES} characters` });
    const conflict = notesConflict(p.state.teamNotes, body.base);
    if (conflict) return res.status(409).json({ error: conflict });
    if (next !== p.state.teamNotes) {
      p.state.teamNotes = next;
      p.log('you', 'Edited the team notes');
    }
  }
  if ('notesEveryRun' in body) {
    if (typeof body.notesEveryRun !== 'boolean') return res.status(400).json({ error: 'notesEveryRun must be true or false' });
    p.state.notesEveryRun = body.notesEveryRun;
  }
  p.commit();
  res.json({ teamNotes: p.state.teamNotes, notesEveryRun: p.state.notesEveryRun });
});

// ---------- connections (MCP servers per project) ----------

project.get('/connections', (_req, res) => {
  res.json(listConnections(P(res)));
});

/** A ConnectionError carries its own status and a safe sentence. Anything else stays generic: it could hold a command line. */
function connectionFailed(res: Response, e: unknown, fallback: string) {
  if (e instanceof ConnectionError) return res.status(e.status).json({ error: e.message });
  console.error('[hq] connections:', e instanceof Error ? e.name : 'error');
  return res.status(500).json({ error: fallback });
}

/** Connect to every server (or just `names`) and list tools. Sends no prompt and calls no tool. */
project.post('/connections/check', jsonOnly, async (req, res) => {
  const names = (req.body as { names?: unknown } | undefined)?.names;
  if (names !== undefined && (!Array.isArray(names) || !names.every((n) => typeof n === 'string') || names.length > 50)) {
    return res.status(400).json({ error: 'names must be a list of server names' });
  }
  try {
    res.json(await checkConnections(P(res), names as string[] | undefined));
  } catch (e) {
    connectionFailed(res, e, 'Check failed');
  }
});

/** What adding a server would save, masked, for you to review. Changes nothing. */
project.post('/connections/preview', jsonOnly, (req, res) => {
  const parsed = parseAddRequest(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  try {
    res.json(previewAdd(P(res), parsed));
  } catch (e) {
    connectionFailed(res, e, 'Could not check those details');
  }
});

/** Save a new server through `claude mcp add-json`. It starts off. `confirm` is the preview you reviewed. */
project.post('/connections', jsonOnly, async (req, res) => {
  const parsed = parseAddRequest(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  const confirm = (req.body as { confirm?: unknown }).confirm;
  try {
    res.status(201).json(await addConnection(P(res), parsed, typeof confirm === 'string' ? confirm : undefined));
  } catch (e) {
    connectionFailed(res, e, 'Could not add it');
  }
});

/** Remove a server from where ?source= says it lives. Also clears its saved sign-in. */
project.delete('/connections/:name', jsonOnly, async (req, res) => {
  try {
    res.json(await removeConnection(P(res), String(req.params.name), str(req.query.source)));
  } catch (e) {
    connectionFailed(res, e, 'Could not remove it');
  }
});

/** Start signing in. The row shows the sign-in page to open; you sign in yourself in your browser. */
project.post('/connections/:name/login', jsonOnly, (req, res) => {
  try {
    res.status(202).json(loginConnection(P(res), String(req.params.name)));
  } catch (e) {
    connectionFailed(res, e, 'Could not start signing in');
  }
});

project.delete('/connections/:name/login', jsonOnly, (req, res) => {
  try {
    res.json(cancelConnectionLogin(P(res), String(req.params.name)));
  } catch (e) {
    connectionFailed(res, e, 'Could not cancel');
  }
});

project.post('/connections/:name/logout', jsonOnly, async (req, res) => {
  try {
    res.json(await logoutConnection(P(res), String(req.params.name)));
  } catch (e) {
    connectionFailed(res, e, 'Could not log out');
  }
});

/** Open Windows Terminal in the project folder, optionally running `claude mcp login <login>`. */
project.post('/terminal', jsonOnly, async (req, res) => {
  const login = (req.body as { login?: unknown } | undefined)?.login;
  if (login !== undefined && typeof login !== 'string') return res.status(400).json({ error: 'login must be a server name' });
  try {
    await openProjectTerminal(P(res), login as string | undefined);
    res.status(202).json({ ok: true });
  } catch (e) {
    connectionFailed(res, e, 'Could not open a terminal');
  }
});

project.put('/connections/:name', jsonOnly, (req, res) => {
  const p = P(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: ConnectionPatch = {};
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    patch.enabled = body.enabled;
  }
  if ('desks' in body) {
    if (!Array.isArray(body.desks) || !body.desks.every((d) => typeof d === 'string')) return res.status(400).json({ error: 'desks must be a list of desk ids' });
    patch.desks = body.desks as string[];
  }
  if ('mode' in body) {
    if (body.mode !== 'ask' && body.mode !== 'read' && body.mode !== 'auto') return res.status(400).json({ error: 'mode must be ask, read or auto' });
    patch.mode = body.mode;
  }
  const result = updateConnection(p, String(req.params.name), patch);
  if (typeof result === 'string') return res.status(404).json({ error: result });
  res.json(listConnections(p));
});

// ---------- skills in this project ----------

/** The library, and which desks have each skill in this project. */
project.get('/skills', (_req, res) => {
  res.json(projectSkills(P(res)));
});

/** Turn a skill on for these desks here. An empty list turns it off in this project. */
project.put('/skills/:id', jsonOnly, (req, res) => {
  const p = P(res);
  const desks = (req.body as { desks?: unknown } | undefined)?.desks;
  if (!Array.isArray(desks) || desks.length > 50 || !desks.every((d) => typeof d === 'string')) return res.status(400).json({ error: 'desks must be a list of desk ids' });
  try {
    setSkillDesks(p, String(req.params.id), desks as string[]);
    res.json(projectSkills(p));
  } catch (e) {
    skillFailed(res, e, 'Could not change that skill');
  }
});

/** Give several skills to desks, or take them off, keeping each skill's other desks: "All desks", or a whole repo. */
project.patch('/skills', jsonOnly, (req, res) => {
  const p = P(res);
  const body = (req.body ?? {}) as { skills?: unknown; add?: unknown; remove?: unknown };
  const list = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max && v.every((d) => typeof d === 'string') ? (v as string[]) : null);
  const ids = list(body.skills, 500);
  const add = body.add === undefined ? [] : list(body.add, 50);
  const remove = body.remove === undefined ? [] : list(body.remove, 50);
  if (!ids?.length || !add || !remove || !(add.length + remove.length)) {
    return res.status(400).json({ error: 'Send skills, and the desks to add or remove' });
  }
  try {
    changeSkillDesks(p, ids, add, remove);
    res.json(projectSkills(p));
  } catch (e) {
    skillFailed(res, e, 'Could not change those skills');
  }
});

// ---------- attachments (images you paste) ----------

/**
 * Upload one image as the raw request body. The type is read from the bytes, never trusted from the header.
 * Only image or octet-stream bodies are read, so a plain form on another site cannot post one.
 */
project.post('/attachments', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '4mb' }), (req, res) => {
  const p = P(res);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    res.status(201).json(saveUpload(p.id, body, 'you'));
  } catch (e) {
    if (e instanceof AttachmentError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

const IMAGE_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

project.get('/attachments/:file', (req, res) => {
  const p = P(res);
  const abs = resolveAttachment(p.id, String(req.params.file));
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'image not found' });
  const type = IMAGE_TYPE[abs.slice(abs.lastIndexOf('.') + 1)];
  if (!type) return res.status(404).json({ error: 'image not found' });
  res.set({
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    // Names are random and never reused, so the browser can keep them.
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  });
  res.send(fs.readFileSync(abs));
});

/** A report's title from the start of the file only. */
function reportTitle(abs: string): string | null {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return reportTitleFrom(buf.subarray(0, n).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** One report link's row. Another project's link, a path outside reports/ or a file that cannot be read shows as missing. */
function reportInfo(pid: string, link: { label: string; url: string }, parts: ReportUrlParts): ReportInfo {
  const { agent, file } = parts;
  const info: ReportInfo = { url: link.url, label: link.label, agent, file, name: file.split('/').pop() || file, title: null, size: 0, updatedAt: null, exists: false };
  const abs = parts.pid === pid ? resolveReport(pid, agent, file) : null;
  if (!abs) return { ...info, agent: '', file: '', name: link.label };
  try {
    if (!fs.existsSync(abs)) return info;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return info;
    return { ...info, exists: true, size: stat.size, updatedAt: stat.mtime.toISOString(), title: reportTitle(abs) };
  } catch {
    return info;
  }
}

/** The ticket's reports, for the list: title, desk, size and when each last changed. One row per report link. */
project.get('/items/:id/reports', (req, res) => {
  const p = P(res);
  const item = p.state.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const out: ReportInfo[] = [];
  for (const link of item.links) {
    const parts = parseReportUrl(link.url);
    // Not a report link: the ticket lists it under Links.
    if (!parts || out.some((r) => r.url === link.url)) continue;
    out.push(reportInfo(p.id, link, parts));
  }
  res.json(out);
});

/** Markdown an agent wrote under workspaces/<project>/<agent>/reports/. */
project.get('/workspaces/:agent/report', (req, res) => {
  const p = P(res);
  const file = typeof req.query.file === 'string' ? req.query.file : '';
  const agentId = String(req.params.agent);
  if (!/^[a-z0-9_-]+$/i.test(agentId) || !file) return res.status(400).json({ error: 'bad request' });
  const abs = resolveReport(p.id, agentId, file);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'report not found' });
  res.type('text/markdown; charset=utf-8').send(fs.readFileSync(abs, 'utf8'));
});

project.post('/reset', (req, res) => {
  const p = P(res);
  if (p.state.agents.some((a) => a.running)) return res.status(409).json({ error: 'Agents are still running' });
  const empty = req.query.empty === '1' || (req.query.empty === undefined && isLive());
  res.json(resetProject(p.id, empty));
});
