import express, { Router, type Response } from 'express';
import fs from 'node:fs';
import type { Attachment, Decision, ItemStatus, ProjectAccess, ProjectMeta, ProjectSummary, StateResponse, TeamTemplate, ThreadResponse } from '../shared/types';
import { canEditDescription, MAX_ATTACHMENTS, MAX_DESCRIPTION } from '../shared/types';
import { acceptInstruction, addAgent, parseSkills, refreshStatuses, removeAgent, settleInstructions } from './agents';
import { AttachmentError, pickAttachments, resolveAttachment, saveUpload } from './attachments';
import {
  ChatError,
  closeThread,
  createThread,
  findThread,
  HOP_LIMIT,
  messagesOf,
  postFounderMessage,
  resumeThread,
  threadForItem,
} from './chat';
import { titleFrom } from '../shared/plainText';
import { addComment } from './comments';
import { checkConnections, listConnections, updateConnection, type ConnectionPatch } from './connections';
import { checkFolder, folderExists, KEY_PATTERN, suggestKey } from './paths';
import { resolveReport } from './runner/claude';
import { cancelRun, deliver, isLive, kickoff, meta } from './runner';
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

const ITEM_STATUSES: ItemStatus[] = ['todo', 'in-progress', 'needs-you', 'approved', 'held', 'sent-back', 'done'];
const DECISIONS: Decision[] = ['approve', 'hold', 'send-back', 'instruct'];
const TEMPLATES: TeamTemplate[] = ['business', 'dev', 'blank'];
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
    openItems: s.items.filter((i) => i.status !== 'done' && i.status !== 'approved').length,
    // Paused chat threads wait on Patrick too.
    needsYou: s.items.filter((i) => i.status === 'needs-you').length + s.threads.filter((t) => t.status === 'paused').length,
    running: s.agents.filter((a) => a.running).length,
    pathOk: p.meta.path ? folderExists(p.meta.path) : true,
  };
}

type ProjectPatch = Partial<Pick<ProjectMeta, 'name' | 'key' | 'path' | 'access'>>;

/** Validate the editable project fields present in `body`. */
function readProjectPatch(body: Record<string, unknown>, exceptId?: string): { patch: ProjectPatch; error?: string } {
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
  return { patch };
}

// ---------- global ----------

router.get('/meta', (_req, res) => {
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
  });
  res.status(201).json(summary(p));
});

// ---------- one project ----------

const project = Router({ mergeParams: true });
const P = (res: Response) => res.locals.project as Project;

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
  updateProject(p.id, patch);
  res.json(summary(p));
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
  // Messages stay out of the 3-second poll; a thread's messages load when it opens.
  const { messages: _messages, ...rest } = p.state;
  const body: StateResponse = { ...rest, meta: meta(), project: p.meta };
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
  p.commit();
  res.json(agent);
});

project.delete('/agents/:id', (req, res) => {
  const p = P(res);
  const error = removeAgent(p, String(req.params.id));
  if (error) return res.status(error === 'agent not found' ? 404 : 409).json({ error });
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
  const run = kickoff(p, result.item.id, 'instruction', undefined, attachments);
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

  switch (decision) {
    case 'approve':
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
      item.status = 'sent-back';
      item.history.push({ ts: now(), text: note ? `Sent back to ${name}: ${note}` : `Sent back to ${name}` });
      p.log(item.assignee, `${ref} "${item.title}" came back for another pass`);
      if (agent) agent.currentTask = `Reworking: ${item.title}`;
      break;
    case 'instruct':
      if (!note && !images.length) return res.status(400).json({ error: 'instruct needs a note' });
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
  let run = null;
  if (decision === 'approve') run = kickoff(p, item.id, 'approved', note || undefined, images);
  else if (decision === 'send-back') run = kickoff(p, item.id, 'send-back', note || undefined, images);
  else if (decision === 'instruct') run = kickoff(p, item.id, 'instruct', note, images);

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
  if (nextStatus !== undefined && nextStatus !== item.status) {
    item.status = nextStatus;
    item.history.push({ ts: now(), text: `Moved to ${nextStatus} by you` });
  }
  settleInstructions(s);
  refreshStatuses(s);
  p.commit();
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
  const run = agent && agent.status !== 'off' ? kickoff(p, item.id, 'comment', text || undefined, attachments) : null;
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
  const agent = p.state.agents.find((a) => a.id === item.assignee);
  if (!agent || agent.isHuman) return res.status(400).json({ error: 'no agent owns this ticket' });
  if (agent.running) return res.status(409).json({ error: `${agent.name} is already running` });
  const run = kickoff(p, item.id, 'manual');
  if (!run) return res.status(500).json({ error: 'could not queue the run' });
  res.status(202).json(run);
});

project.post('/runs/:id/cancel', (req, res) => {
  const p = P(res);
  if (!p.state.runs.some((r) => r.id === req.params.id)) return res.status(404).json({ error: 'run not found' });
  if (!cancelRun(String(req.params.id))) return res.status(404).json({ error: 'that run is not running' });
  res.json({ ok: true });
});

// ---------- connections (MCP servers per project) ----------

project.get('/connections', (_req, res) => {
  res.json(listConnections(P(res)));
});

/** Connect to every server and list tools. Sends no prompt and calls no tool. */
project.post('/connections/check', async (_req, res) => {
  try {
    res.json(await checkConnections(P(res)));
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : 'Check failed' });
  }
});

project.put('/connections/:name', (req, res) => {
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
    if (body.mode !== 'ask' && body.mode !== 'read') return res.status(400).json({ error: 'mode must be ask or read' });
    patch.mode = body.mode;
  }
  const result = updateConnection(p, String(req.params.name), patch);
  if (typeof result === 'string') return res.status(404).json({ error: result });
  res.json(listConnections(p));
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
