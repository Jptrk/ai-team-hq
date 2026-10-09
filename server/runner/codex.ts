import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gptReady, noteRateLimits, windowsOf } from '../codexAuth';
import type { McpToolInfo } from '../../shared/types';
import { codexMcp } from '../codexMcp';
import { gptToolHints } from '../codexMcpAuth';
import { codexEnv, DESK_CONFIG, openAppServer, type AppServer } from '../codexServer';
import { runtimeServers, type AllowedServer } from '../connections';
import { settings } from '../settings';
import { now } from '../store';
import {
  builtinTools,
  closedOut,
  ensureWorkspace,
  failRun,
  finishRun,
  freshStartReason,
  guard,
  hqTools,
  huddlePrompt,
  imagesFor,
  logAutoChanges,
  logUnfinishedAutoChanges,
  messagePrompt,
  newRunContext,
  owns,
  planPrompt,
  projectDirOf,
  qaPrompt,
  rememberSession,
  runNotes,
  systemPromptFor,
  ticketPrompt,
  type HqTools,
  type RunContext,
} from './claude';
import { ALL_FILE_TOOLS, FILE_TOOL_SPECS, READ_ONLY_TOOLS, runFileTool, type FileToolName, type ToolReply } from './codexTools';
import { attachmentPath, imageMarker, splitImages } from './content';
import { setLastTool, toolKind } from './liveTools';
import { isCaptureTool, keepLinkedShots, keepShots, toolImageLinksIn, toolImagesIn, toolResultIdsIn } from './screenshots';
import type { AgentRunner, RunInput, RunOutcome } from './types';
import { limitsFromEnv, mcpToolTimeoutFromEnv, RunWatch, stopText, type UsageLimit } from './watch';

/**
 * GPT desks: each run is a turn of a Codex thread (codex app-server, see codexServer.ts) on your ChatGPT login.
 *
 * The desk gets what a Claude desk gets, through the same code in claude.ts: the same prompts, HQ's own tools, the
 * same fence (guard), the same close-out. What differs:
 *   - Codex's own tools are switched off (DESK_CONFIG). The desk reads and writes with HQ's file tools
 *     (codexTools.ts), named like Claude Code's. Codex's apply_patch stays, but the thread is read-only, so every
 *     patch asks HQ first and HQ answers with the guard's verdict. Deletes go through delete_file only.
 *   - Connections (MCP) are the desk's own, from the same list as for Claude (codexMcp.ts). Every tool call asks
 *     HQ first, and HQ answers with the same rules (mcpDecision in claude.ts); a refusal reaches the model with
 *     HQ's reason (turn/steer). Auto acts as Ask on a server HQ knows no tools of (no hints for its delete check).
 *     Screenshots and auto changes are kept and logged as for Claude.
 *   - Web search with HQ_WEB=1, in ticket runs and chat replies only, as for Claude: Codex's own web tool.
 *   - No dollar cost: the run spends your ChatGPT plan's usage. HQ caps a run by tool calls instead of dollars.
 *   - The desk's thread is resumed by id with this run's instructions, as long as its tools are unchanged.
 * Codex keeps threads in HQ's Codex home (data/.codex/sessions).
 */

const WATCH = limitsFromEnv();
const MAX_CALLS = Number(process.env.HQ_GPT_MAX_TOOL_CALLS ?? 80);
const MSG_MAX_CALLS = Number(process.env.HQ_GPT_MSG_MAX_TOOL_CALLS ?? 24);
const PLAN_MAX_CALLS = Number(process.env.HQ_GPT_PLAN_MAX_TOOL_CALLS ?? 40);
/** How long Codex gets to wind a turn down after HQ asked it to stop, before HQ ends it. */
const STOP_GRACE_MS = 15_000;
const WEB = process.env.HQ_WEB === '1';
// A tool call that never answers fails after this, as for Claude desks (HQ_MCP_TOOL_TIMEOUT_MS).
const MCP_TOOL_TIMEOUT_MS = mcpToolTimeoutFromEnv(process.env.HQ_MCP_TOOL_TIMEOUT_MS);

export const NO_GPT_LOGIN =
  "HQ has no ChatGPT login for GPT desks. On HQ's Accounts page, sign in to ChatGPT and turn on Run GPT desks on my ChatGPT login.";

type DynamicTool = { type: 'function'; name: string; description: string; inputSchema: Record<string, unknown> };

/** A zod raw shape as JSON Schema, for Codex. */
function schemaOf(shape: unknown): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape as z.ZodRawShape)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** The tools a GPT desk gets this run: HQ's file tools for its mode, then HQ's own tools. Exported for tests. */
export function toolSpecs(files: FileToolName[], hq: HqTools): DynamicTool[] {
  return [
    ...files.map((name) => ({ type: 'function' as const, name, ...FILE_TOOL_SPECS[name] })),
    ...hq.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: schemaOf(t.inputSchema) })),
  ];
}

/** The file tools for a mode: a huddle turn and a plan only read. The same split as Claude's built-in tools. */
function fileToolsFor(mode: RunContext['mode']): FileToolName[] {
  const builtins = new Set(builtinTools(mode));
  return (builtins.has('Write') ? ALL_FILE_TOOLS : READ_ONLY_TOOLS).filter((t) => builtins.has(t));
}

/** What else a GPT desk has this run: the web, its connections, connections it can't use here, and ones on Auto that act as Ask. */
export interface DeskExtras {
  web?: boolean;
  connections?: boolean;
  skipped?: { name: string; why: string }[];
  askOnly?: string[];
}

/** What a GPT desk is told on top of the usual system prompt: which tools do what, and what it does not have. Exported for tests. */
export function developerPrompt(systemPrompt: string, hq: HqTools, files: FileToolName[], extras: DeskExtras = {}): string {
  const writes = files.includes('Write');
  const lines = [
    systemPrompt,
    '',
    '## Your tools',
    writes
      ? '- Read, Glob and Grep read files; Write and Edit change them, where you may write. Use them, not apply_patch: a patch to a place you may not write is refused without a reason.'
      : '- Read, Glob and Grep read files. Nothing gets written in this run.',
    extras.web ? '- You have no shell and no sub-agents. You can search the web with your web tool.' : '- You have no shell, no web and no sub-agents.',
    ...(extras.connections
      ? [
          "- Your connections' tools are named mcp__<connection>__<tool>. HQ checks every call against the rules under Connections. A call it refuses comes back rejected, and HQ then tells you why: follow that.",
          // HQ's note may never come (turn/steer can fail): the rule stands on its own.
          "- A rejected connection call that would change something needs approval: put exactly what you would do in a report under reports/, call raise_for_decision, and stop, unless HQ's note says otherwise.",
          ...(extras.askOnly ?? []).map((name) => `- Auto acts as Ask on ${name} until HQ knows its tools (press Check on the Connections page).`),
        ]
      : []),
    ...(extras.skipped?.length ? [`- Not available to you here: ${extras.skipped.map((x) => `${x.name} (${x.why})`).join('; ')}.`] : []),
    `- ${hq.instructions}`,
    '- Your last message is your reply: keep it to what was asked.',
  ];
  return lines.join('\n');
}

/** Fingerprint of what a desk's thread was started with: its tools and the model. New ones start a new thread. Exported for tests. */
export function gptSessionKey(parts: { tools: DynamicTool[]; model?: string }): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([parts.model ?? '', parts.tools.map((t) => [t.name, t.description, t.inputSchema])]))
    .digest('hex')
    .slice(0, 16);
  return `gpt:${hash}`;
}

/** A session id from the other model can't be resumed here: the desk switched from Claude. */
export function isGptSession(agent: { sessionKey?: string }): boolean {
  return Boolean(agent.sessionKey?.startsWith('gpt:'));
}

/** "15:00" in this machine's time, or "Mon 09:00" when it is not today. */
function clock(iso: string, nowMs = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date(nowMs).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * The limit or account problem behind a failed turn, or null. A usage limit says which window ran out and when it
 * resets, from the plan's latest rate-limit snapshot. Plain throttling (rateLimitExceeded) is not a limit. Exported for tests.
 */
export function gptLimitOf(error: { codexErrorInfo?: unknown } | null | undefined, rates: unknown, nowMs = Date.now()): UsageLimit | null {
  const info = error?.codexErrorInfo;
  if (info === 'unauthorized') return { kind: 'account', text: "ChatGPT login failed. Sign in again on HQ's Accounts page, then press Resume." };
  if (info !== 'usageLimitExceeded') return null;
  const windows = windowsOf(rates).filter((w) => w.resetsAt && Date.parse(w.resetsAt) > nowMs);
  const full = windows.filter((w) => w.usedPercent >= 100);
  // The window that ran out; with none at 100%, the one that resets last.
  const w = (full.length ? full : windows).sort((a, b) => Date.parse(b.resetsAt!) - Date.parse(a.resetsAt!))[0];
  if (!w) return { kind: 'usage', text: "ChatGPT's usage limit reached." };
  return { kind: 'usage', until: w.resetsAt, text: `ChatGPT's ${w.label} limit reached. It resets at ${clock(w.resetsAt!, nowMs)}.` };
}

const textItem = (text: string) => ({ type: 'inputText' as const, text });
type ToolResult = { success: boolean; contentItems: ({ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string })[] };

function fromReply(r: ToolReply): ToolResult {
  return { success: r.ok, contentItems: [textItem(r.text), ...(r.image ? [{ type: 'inputImage' as const, imageUrl: `data:${r.image.mime};base64,${r.image.base64}` }] : [])] };
}

type McpContent = { type?: string; text?: string; data?: string; mimeType?: string };

/** An HQ tool's MCP-shaped result as Codex's tool result. */
function fromMcp(res: { content?: McpContent[]; isError?: boolean }): ToolResult {
  const items: ToolResult['contentItems'] = [];
  for (const c of res.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') items.push(textItem(c.text));
    else if (c.type === 'image' && c.data && c.mimeType) items.push({ type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` });
  }
  return { success: !res.isError, contentItems: items.length ? items : [textItem(res.isError ? 'Failed.' : 'Done.')] };
}

/** The prompt as Codex input: the text, then the founder's newest images as files Codex reads itself. */
function promptInput(text: string, projectId: string, images: ReturnType<typeof imagesFor>): unknown[] {
  const { inline, rest } = splitImages(images);
  const lines = [text];
  if (inline.length) lines.push('', `The founder attached ${inline.length} image${inline.length === 1 ? '' : 's'}, shown below.`);
  if (rest.length) lines.push(`More images are on disk; open them with Read if you need them:${imageMarker(projectId, rest)}`);
  return [{ type: 'text', text: lines.join('\n'), text_elements: [] }, ...inline.map((a) => ({ type: 'localImage', path: attachmentPath(projectId, a) }))];
}

/** A connection tool call's result in the shape the Claude helpers read (a user message with one tool_result), for screenshots and auto-change logs. Exported for tests. */
export function asToolResult(item: { id: string; status?: string; result?: { content?: McpContent[]; isError?: boolean } | null }): unknown {
  const content = (item.result?.content ?? []).map((c) =>
    c.type === 'image' && typeof c.data === 'string' ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : c,
  );
  const failed = item.status !== 'completed' || item.result?.isError === true;
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: failed, content }] } };
}

/** A connection tool call as Codex reports it (item/started). */
export type McpCallItem = { id: string; type?: string; status?: string; server?: string; tool?: string; arguments?: unknown };

/** Two JSON values with the same content, whatever the order of their keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameJson(v, (b as unknown[])[i]));
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => Object.prototype.hasOwnProperty.call(y, k) && sameJson(x[k], y[k]));
}

/**
 * The call a connection's approval request is about. Codex's request names no call, so HQ never guesses: of one
 * server's calls still running and not yet answered (oldest first), the ones whose arguments are the request's
 * tool_params, then, when it is one of their tool names (it may be a title), the tool the message quotes. One left,
 * or several that are the very same call, is the answer (the oldest); anything else is null. Exported for tests.
 */
export function mcpCallFor(calls: McpCallItem[], params: unknown, quoted: string | undefined): McpCallItem | null {
  let left = calls;
  if (params !== undefined && params !== null) left = left.filter((c) => sameJson(c.arguments ?? {}, params));
  if (quoted && left.some((c) => c.tool === quoted)) left = left.filter((c) => c.tool === quoted);
  const first = left[0];
  if (!first) return null;
  return left.every((c) => c.tool === first.tool && sameJson(c.arguments ?? {}, first.arguments ?? {})) ? first : null;
}

/**
 * The servers as this run uses them. Auto's delete check reads each tool's hints: a server Claude's check listed no
 * tools for gets the ones Codex gave (hintsOf: a GPT check or sign-in). One HQ still knows no tools of runs as Ask
 * this run, since Auto couldn't tell its deletes; blind names those. Exported for tests.
 */
export function withToolHints(allowed: AllowedServer[], hintsOf: (name: string) => Record<string, McpToolInfo> | undefined): { allowed: AllowedServer[]; blind: string[] } {
  const blind: string[] = [];
  const out = allowed.map((a): AllowedServer => {
    if (Object.keys(a.tools).length) return a;
    const tools = hintsOf(a.name);
    if (tools && Object.keys(tools).length) return { ...a, tools };
    if (a.mode !== 'auto') return a;
    blind.push(a.name);
    return { ...a, mode: 'ask' };
  });
  return { allowed: out, blind };
}

interface Attempt {
  developer: string;
  tools: DynamicTool[];
  /** This run's connections as Codex settings, and the variables their secrets travel in. */
  config: string[];
  env: Record<string, string>;
  /** HQ's own tools for this run, built once: what tools lists, and what runs when the model calls one. */
  hq: HqTools;
  resume?: string;
  model?: string;
  effort?: string;
  maxCalls: number;
}

/** dropThread: the thread grew past what the model takes, so the desk's next run starts a new one. */
type Failure = Error & { outcome?: RunOutcome; usage?: UsageLimit; dropThread?: boolean };
/** A turn as Codex reports its end (turn/completed). */
type TurnEnd = { id?: string; status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null };

/** One turn of the desk's thread. Resolves with the outcome, or rejects with a Failure carrying it. */
async function runTurn(input: RunInput, ctx: RunContext, a: Attempt, signal: AbortSignal, deadline: number, onThread: (id: string, fresh: boolean) => void): Promise<RunOutcome> {
  const freshSession = ctx.mode === 'huddle' || ctx.mode === 'qa' || ctx.mode === 'plan';
  const projectDir = projectDirOf(ctx.project);
  // For the Office's Coding: only a run the guard lets write the project folder can be coding there.
  const codeDir = projectDir && ctx.project.meta.access === 'write' && ctx.mode !== 'qa' && ctx.mode !== 'huddle' && ctx.mode !== 'plan' ? projectDir : null;
  const check = guard(ctx);
  const hq = new Map(a.hq.tools.map((t) => [t.name, t]));
  const files = new Set<string>(a.tools.filter((t) => t.name in FILE_TOOL_SPECS).map((t) => t.name));
  const controller = new AbortController();
  // HQ's own tools see this attempt's signal: a skill script stops with the run.
  ctx.signal = controller.signal;

  let threadId: string | undefined;
  let turnId: string | undefined;
  let calls = 0;
  let reply = '';
  let rates: unknown;
  let limit: UsageLimit | undefined;
  /** Codex said the thread no longer fits the model's context window. */
  let full = false;
  let stopping: 'you' | 'watch' | 'cap' | null = null;
  const items = new Map<
    string,
    { id: string; type?: string; status?: string; server?: string; tool?: string; arguments?: unknown; changes?: { path: string; kind?: { type?: string; move_path?: string | null } }[] }
  >();
  /** Connection tool calls by item id, as mcp__<key>__<tool>: for screenshots and auto-change logs. */
  const toolById = new Map<string, string>();
  /** Connection tool calls HQ already answered, so an approval request is never matched to one twice. */
  const answered = new Set<string>();
  /** Guard keys of the writes each approved patch may make, by item id. They count once the patch completes. */
  const patchKeys = new Map<string, string[]>();
  let server: AppServer | null = null;
  let finished: (turn: TurnEnd) => void = () => undefined;
  const done = new Promise<TurnEnd>((r) => (finished = r));
  /** Turn ends Codex reported before HQ knew this turn's id: the one with its id ends the turn once the id is known. */
  const early: TurnEnd[] = [];

  /** Ask Codex to wind this turn down. Needs the turn's id: without it, learnTurn sends this once the id comes. */
  const interrupt = () => {
    if (server && threadId && turnId) void server.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => undefined);
  };
  const stop = (why: 'you' | 'watch' | 'cap') => {
    if (stopping) return;
    stopping = why;
    controller.abort();
    interrupt();
    // Codex winds the turn down and reports it; if it doesn't, the program goes.
    setTimeout(() => void server?.close(), STOP_GRACE_MS).unref?.();
  };
  /**
   * This turn's id, from turn/start's answer or the turn/started notice, whichever comes first. A stop that came
   * before it is sent now, so Stop never waits for Codex to answer turn/start; and an end already reported counts.
   */
  const learnTurn = (id: unknown) => {
    if (turnId || typeof id !== 'string' || !id) return;
    turnId = id;
    if (stopping) interrupt();
    const ended = early.find((t) => t.id === id);
    if (ended) finished(ended);
  };
  const watch = new RunWatch(WATCH, deadline - Date.now(), () => stop('watch'));
  const onAbort = () => stop('you');
  signal.addEventListener('abort', onAbort, { once: true });

  /** The guard for HQ's file tools: once the run is stopping, a call already under way writes nothing either. */
  const fence: typeof check = async (toolName, toolInput, opts) => {
    const d = await check(toolName, toolInput, opts);
    if (!stopping || d.behavior !== 'allow') return d;
    if (opts?.toolUseID) ctx.pendingWrites.delete(opts.toolUseID);
    return { behavior: 'deny', message: 'This run was stopped. Do nothing more.' };
  };

  const capText = `This run reached its limit of ${a.maxCalls} tool calls. Stop now.`;
  /** Counts one tool call or patch toward the run's cap. Why it may not go ahead (the run is stopping, or past the cap), or null. */
  const nextCall = (): string | null => {
    if (stopping) return stopping === 'cap' ? capText : 'This run was stopped. Do nothing more.';
    calls++;
    if (calls <= a.maxCalls) return null;
    stop('cap');
    return capText;
  };

  const callTool = async (p: { tool?: string; arguments?: unknown; callId?: string }): Promise<ToolResult> => {
    const name = String(p.tool ?? '');
    const id = String(p.callId ?? `call-${calls}`);
    const refused = nextCall();
    if (refused) return { success: false, contentItems: [textItem(refused)] };
    const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
    watch.touch([id]);
    try {
      if (files.has(name)) {
        setLastTool(input.run.id, toolKind(name, { file_path: args.file_path }, codeDir, ctx.dir));
        return fromReply(await runFileTool(name as FileToolName, args, { dir: ctx.dir, guard: fence, pendingWrites: ctx.pendingWrites, changed: ctx.changed }, id));
      }
      const t = hq.get(name);
      if (!t) return { success: false, contentItems: [textItem(`${name} is not available on this desk.`)] };
      setLastTool(input.run.id, 'other');
      const parsed = z.object(t.inputSchema).safeParse(args);
      if (!parsed.success) return { success: false, contentItems: [textItem(`Invalid input for ${name}: ${z.prettifyError(parsed.error).slice(0, 800)}`)] };
      return fromMcp((await t.handler(parsed.data as never, {})) as { content?: McpContent[]; isError?: boolean });
    } catch (e) {
      return { success: false, contentItems: [textItem(e instanceof Error ? e.message.slice(0, 500) : 'The tool failed.')] };
    } finally {
      watch.touch([], [id]);
    }
  };

  /**
   * A patch asks first: HQ answers with the guard's verdict for every file it touches. Deletes go through delete_file.
   * Each patch counts toward the cap like a tool call, and none goes through once the run is stopping.
   */
  const approvePatch = async (itemId: string): Promise<'accept' | 'decline'> => {
    if (nextCall()) return 'decline';
    const changes = items.get(itemId)?.changes ?? [];
    if (!changes.length || ctx.mode === 'huddle' || ctx.mode === 'plan') return 'decline';
    const keys: string[] = [];
    const refuse = (): 'decline' => {
      for (const k of keys) ctx.pendingWrites.delete(k);
      return 'decline';
    };
    for (const c of changes) {
      const kind = c.kind?.type;
      if (kind === 'delete' || typeof c.path !== 'string') return refuse();
      const targets = [c.path, ...(kind === 'update' && typeof c.kind?.move_path === 'string' && c.kind.move_path ? [c.kind.move_path] : [])];
      for (const target of targets) {
        const key = `${itemId}:${keys.length}`;
        keys.push(key);
        const d = await check(kind === 'add' ? 'Write' : 'Edit', { file_path: target }, { toolUseID: key });
        if (d.behavior !== 'allow') return refuse();
      }
    }
    // Stopped while the guard looked: nothing more gets written.
    if (stopping) return refuse();
    patchKeys.set(itemId, keys);
    setLastTool(input.run.id, toolKind('Write', { file_path: changes[0].path }, codeDir, ctx.dir));
    return 'accept';
  };

  let steerFailed = false;
  /** Tell the model why HQ refused something, as a note in its turn: Codex's own refusal says only "rejected". */
  const steer = (text: string) => {
    if (server && threadId && turnId && !stopping) {
      void server.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] }, 10_000).catch((e: unknown) => {
        // The desk still has the prompt's rule for a refusal; said once a run, so a log doesn't fill up.
        if (steerFailed) return;
        steerFailed = true;
        console.info(`[hq] ${ctx.project.meta.key} ${ctx.agent.name}: HQ could not tell the desk why it refused a connection call (${e instanceof Error ? e.message.slice(0, 120) : 'error'}).`);
      });
    }
  };

  /**
   * A connection's tool call asks first: HQ answers with the same rules as for a Claude desk (mode, reads, deletes,
   * the run's kind), counts it toward the cap, and never lets one through once the run is stopping. HQ judges the
   * call the request is about by that call's own tool and arguments (mcpCallFor); one it can't tie to exactly one
   * call gets no. Anything else a server asks for (a form, a page to open) gets no, and so does a server named hq.
   */
  const approveMcp = async (p: { serverName?: unknown; message?: unknown; _meta?: { codex_approval_kind?: unknown; tool_params?: unknown } | null }) => {
    const no = { action: 'decline', content: null, _meta: null };
    if (p?._meta?.codex_approval_kind !== 'mcp_tool_call') return no;
    const key = String(p.serverName ?? '');
    // HQ's own tools are mcp__hq__*, which the guard lets through: a connection by that name gets nothing.
    if (!key || key === 'hq') return no;
    const name = ctx.connections.find((c) => c.key === key)?.name ?? key;
    const running = [...items.values()].filter((i) => i.type === 'mcpToolCall' && i.server === key && i.status === 'inProgress' && typeof i.tool === 'string' && !answered.has(i.id));
    const item = mcpCallFor(running, p._meta?.tool_params, /run tool "([^"]+)"/.exec(String(p.message ?? ''))?.[1]);
    if (!item?.tool) {
      if (running.length) steer(`HQ refused a call on ${name}: it could not tell which of your calls running there Codex asked about. Make one call at a time on ${name}.`);
      return no;
    }
    const tool = item.tool;
    answered.add(item.id);
    if (nextCall()) return no;
    const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? (item.arguments as Record<string, unknown>) : {};
    const d = await check(`mcp__${key}__${tool}`, args, { toolUseID: item.id });
    if (stopping) {
      ctx.autoChanges.delete(item.id);
      return no;
    }
    if (d.behavior === 'allow') return { action: 'accept', content: null, _meta: null };
    steer(`HQ refused ${tool} on ${name}: ${'message' in d ? d.message : 'not allowed'}`);
    return no;
  };

  /** A connection's tool call ended: its auto change is logged, and its pictures (or picture links) are kept for attaching. */
  const settleMcp = (item: { id: string; status?: string; result?: { content?: McpContent[]; isError?: boolean } | null }) => {
    const msg = asToolResult(item);
    logAutoChanges(ctx, msg);
    keepShots(ctx.shots, toolImagesIn(msg, toolById));
    const links = toolImageLinksIn(msg, toolById);
    const fetching = new Set(links.map((l) => l.id));
    for (const id of toolResultIdsIn(msg)) if (!fetching.has(id)) ctx.shots.pending.delete(id);
    if (links.length) void keepLinkedShots(ctx.shots, links);
  };

  const settlePatch = (itemId: string, ok: boolean) => {
    for (const key of patchKeys.get(itemId) ?? []) {
      const changed = ctx.pendingWrites.get(key);
      ctx.pendingWrites.delete(key);
      if (ok && changed) for (const f of changed) ctx.changed.add(f);
    }
    patchKeys.delete(itemId);
  };

  try {
    server = await openAppServer({ cwd: ctx.dir, config: [...DESK_CONFIG, ...a.config], env: a.env });
    const s = server;
    s.onRequest(async (method, params) => {
      watch.touch();
      switch (method) {
        case 'item/tool/call':
          return callTool(params ?? {});
        case 'item/fileChange/requestApproval':
          return { decision: await approvePatch(String(params?.itemId ?? '')) };
        case 'item/commandExecution/requestApproval':
          return { decision: 'decline' };
        case 'item/permissions/requestApproval':
          // More file or network access for the turn: never. The answer grants nothing.
          return { permissions: {}, scope: 'turn' };
        case 'applyPatchApproval':
        case 'execCommandApproval':
          // The older approval requests answer with a ReviewDecision: denied, with the reason the model sees.
          return { decision: { denied: { rejection: 'HQ allows no patch or command through this request.' } } };
        case 'mcpServer/elicitation/request':
          return approveMcp(params ?? {});
        case 'item/tool/requestUserInput':
          return { answers: {} };
        case 'currentTime/read':
          return { currentTimeAt: Math.floor(Date.now() / 1000) };
        default:
          return undefined;
      }
    });
    s.onNotification((method, params) => {
      if (method === 'item/started' || method === 'item/completed') {
        const item = params?.item;
        if (!item?.id) return;
        items.set(item.id, item);
        const tool = item.type === 'dynamicToolCall' || item.type === 'fileChange' || item.type === 'mcpToolCall';
        watch.touch(tool && method === 'item/started' ? [item.id] : [], tool && method === 'item/completed' ? [item.id] : []);
        if (item.type === 'mcpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string' && !toolById.has(item.id)) {
          const name = `mcp__${item.server}__${item.tool}`;
          toolById.set(item.id, name);
          setLastTool(input.run.id, 'other');
          // An HQ tool in the same turn waits for this picture before it attaches the latest one.
          if (isCaptureTool(name)) ctx.shots.pending.add(item.id);
        }
        if (method !== 'item/completed') return;
        if (item.type === 'mcpToolCall') settleMcp(item);
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) reply = item.text;
        if (item.type === 'fileChange') settlePatch(item.id, item.status === 'completed');
        return;
      }
      watch.touch();
      if (method === 'thread/tokenUsage/updated') {
        const last = params?.tokenUsage?.last;
        if (last && typeof last.totalTokens === 'number' && last.totalTokens > 0) {
          ctx.contextTokens = last.totalTokens;
          ctx.firstTurn ??= { context: last.totalTokens, cacheWrite: 0, cacheRead: typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : 0 };
        }
      } else if (method === 'account/rateLimits/updated') {
        rates = params?.rateLimits;
        noteRateLimits(rates);
      } else if (method === 'error' && params?.willRetry !== true) {
        limit = gptLimitOf(params?.error, rates) ?? limit;
        if (params?.error?.codexErrorInfo === 'contextWindowExceeded') full = true;
      } else if (method === 'turn/started') {
        learnTurn(params?.turn?.id);
      } else if (method === 'turn/completed') {
        // Only this turn's end counts. One reported before its id is known waits for the id.
        const turn: TurnEnd = params?.turn ?? {};
        if (!turnId) early.push(turn);
        else if (turn.id === turnId) finished(turn);
      }
    });

    const common = {
      cwd: ctx.dir,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      developerInstructions: a.developer,
      ...(a.model ? { model: a.model } : {}),
    };
    let thread: { thread?: { id?: string } } | null = null;
    if (a.resume) {
      try {
        thread = await s.request('thread/resume', { threadId: a.resume, ...common });
      } catch (e) {
        console.info(`[hq] ${ctx.project.meta.key} ${ctx.agent.name} starts a new GPT thread: resuming failed (${e instanceof Error ? e.message.slice(0, 120) : 'error'}).`);
      }
    }
    const fresh = !thread?.thread?.id;
    // Only a new thread takes allowProviderModelFallback (thread/resume has no such field).
    if (fresh) thread = await s.request('thread/start', { ...common, allowProviderModelFallback: true, dynamicTools: a.tools });
    threadId = thread!.thread!.id!;
    onThread(threadId, fresh);
    if (signal.aborted) stop('you');
    if (stopping) throw new Error('stopped');

    const turn = await s.request<{ turn?: { id?: string } }>('turn/start', { threadId, input: promptInput(ctxPrompt(input, ctx, !a.resume || fresh), ctx.project.id, imagesFor(input)), ...(a.effort ? { effort: a.effort } : {}) });
    learnTurn(turn?.turn?.id);
    if (!turnId) throw new Error('Codex started the turn without an id.');
    const ended = await Promise.race([done, s.exited.then(() => null)]);
    const outcome: RunOutcome = { summary: reply, costUsd: 0, turns: calls, sessionId: freshSession ? undefined : threadId };
    if (ended?.status === 'completed' && !stopping) return limit ? { ...outcome, usage: limit } : outcome;
    full ||= ended?.error?.codexErrorInfo === 'contextWindowExceeded';
    // A thread too long for the model can't go on: the run hands back no thread, and the desk's next run starts a new one.
    if (full) outcome.sessionId = undefined;

    const why =
      stopping === 'you'
        ? stopText.you
        : stopping === 'watch'
          ? (watch.why ?? 'Stopped by HQ.')
          : stopping === 'cap'
            ? `Stopped after ${a.maxCalls} tool calls, the most one run may make (HQ_GPT_MAX_TOOL_CALLS)`
            : null;
    limit = gptLimitOf(ended?.error, rates) ?? limit;
    const said = ended ? (ended.error?.message?.slice(0, 400) ?? `The turn ended ${ended.status ?? 'without a result'}.`) : 'Codex stopped before the turn finished.';
    const text = why ?? limit?.text ?? (full ? `${said} The conversation is too long for the model: the desk's next run starts a new one.` : said);
    throw Object.assign(new Error(text), { outcome, ...(limit && !why ? { usage: limit } : {}), ...(full ? { dropThread: true } : {}) });
  } catch (e) {
    const err = e as Failure;
    if (!err.outcome) {
      const why = stopping === 'you' ? stopText.you : stopping === 'watch' ? (watch.why ?? err.message) : err.message;
      throw Object.assign(new Error(why), { outcome: { summary: '', costUsd: 0, turns: calls, sessionId: freshSession ? undefined : threadId } });
    }
    throw err;
  } finally {
    watch.clear();
    signal.removeEventListener('abort', onAbort);
    // Writes still waiting for their result: they may not have gone through, so they never count.
    for (const id of [...patchKeys.keys()]) settlePatch(id, false);
    // Auto changes whose result never came back still show in the activity feed.
    logUnfinishedAutoChanges(ctx);
    await server?.close();
  }
}

/** This run's prompt, with the notes for this run at the end. fresh: no earlier conversation is loaded. */
function ctxPrompt(input: RunInput, ctx: RunContext, fresh: boolean): string {
  const mode = ctx.mode;
  const base =
    mode === 'plan'
      ? planPrompt(ctx)
      : mode === 'huddle'
        ? huddlePrompt(ctx)
        : mode === 'message'
          ? messagePrompt(input, owns(ctx))
          : mode === 'qa'
            ? qaPrompt(input)
            : ticketPrompt(input, { restarted: Boolean(input.run.restarts) });
  const notes = runNotes(ctx.project, ctx.agent, ctx.connections, ctx.reason, mode, owns(ctx), Boolean(input.includeNotes), fresh);
  return notes.length ? `${base}\n\n## For this run\n${notes.join('\n')}` : base;
}

export const codexRunner: AgentRunner = {
  name: 'gpt',
  async run(input, signal) {
    if (!gptReady()) throw new Error(NO_GPT_LOGIN);
    const p = input.project;
    const agent = input.agent;
    const dir = ensureWorkspace(p, agent);
    // The desk's connections, as for Claude, turned into Codex's settings: ones GPT can't use are left out and named.
    const { servers, allowed: found } = runtimeServers(p, agent.id);
    // Tool hints for Auto's delete check: Codex's fill in where Claude's check has none; with none at all, Auto acts as Ask.
    const hinted = withToolHints(found, (name) => gptToolHints(p.id, name, servers[name]));
    const mcp = codexMcp(servers, hinted.allowed, { toolTimeoutMs: MCP_TOOL_TIMEOUT_MS, base: codexEnv() });
    const askOnly = hinted.blind.filter((name) => mcp.allowed.some((a) => a.name === name));
    const ctx = newRunContext(input, dir, mcp.allowed, {});
    const mode = ctx.mode;
    // The web as for Claude: with HQ_WEB=1, never in a huddle, a QA check or a plan.
    const web = WEB && (mode === 'ticket' || mode === 'message');
    // A huddle turn, a QA check or a plan starts a thread of its own and leaves the desk's own one alone.
    const freshSession = mode === 'huddle' || mode === 'qa' || mode === 'plan';
    const s = settings();
    const files = fileToolsFor(mode);
    const hq = hqTools(ctx);
    const tools = toolSpecs(files, hq);
    const developer = developerPrompt(systemPromptFor(p, agent, dir, mcp.allowed, mode, Boolean(input.includeNotes)), hq, files, {
      web,
      connections: mcp.allowed.length > 0,
      skipped: mcp.skipped,
      askOnly,
    });
    const config = [...mcp.config, ...(web ? ['web_search="live"'] : [])];
    const key = freshSession ? '' : gptSessionKey({ tools, model: s.gptModel });
    let resume: string | undefined;
    if (!freshSession && agent.sessionId && isGptSession(agent)) {
      // New tools or a new model need a new thread; a big thread idle past the cache starts fresh too (see freshStartReason).
      const cold = agent.sessionKey !== key ? 'its tools or model changed' : freshStartReason(agent, key, Date.now());
      if (cold) console.info(`[hq] ${p.meta.key} ${agent.name} starts a new GPT thread: ${cold}.`);
      else resume = agent.sessionId;
    }
    if (!resume && !freshSession) {
      agent.sessionId = undefined;
      agent.sessionTotalUsd = undefined;
    }
    let fresh = !resume;
    const deadline = Date.now() + WATCH.capMs;
    const maxCalls = mode === 'message' ? MSG_MAX_CALLS : mode === 'plan' ? PLAN_MAX_CALLS : MAX_CALLS;
    let dropThread = false;
    const remember = () => {
      if (freshSession) return;
      if (dropThread) {
        // The thread no longer fits the model: forget it, so the next run starts a new one instead of failing again.
        agent.sessionId = agent.sessionKey = agent.sessionAt = undefined;
        agent.sessionTotalUsd = agent.sessionTokens = agent.sessionBaseTokens = undefined;
        return;
      }
      rememberSession(agent, { key, fresh, contextTokens: ctx.contextTokens, firstTurn: ctx.firstTurn }, now());
    };
    let outcome: RunOutcome;
    try {
      outcome = await runTurn(input, ctx, { developer, tools, config, env: mcp.env, hq, resume, model: s.gptModel, effort: s.gptEffort, maxCalls }, signal, deadline, (id, isFresh) => {
        fresh = isFresh;
        if (freshSession) return;
        // The thread's id goes with its key at once, so a desk never pairs a GPT thread with a Claude session's key.
        agent.sessionId = id;
        agent.sessionKey = key;
      });
    } catch (e) {
      const err = e as Failure;
      dropThread = Boolean(err.dropThread);
      if (closedOut(ctx)) {
        // The desk already closed out (or replied, or asked a teammate): a cap or stop after that is not a failure.
        outcome = { ...(err.outcome ?? { costUsd: 0, turns: 0 }), summary: `Closed out, then stopped: ${err.message}`, ...(err.usage ? { usage: err.usage } : {}) };
      } else {
        remember();
        failRun(ctx, freshSession);
        throw e;
      }
    }
    remember();
    return finishRun(ctx, outcome, freshSession);
  },
};
