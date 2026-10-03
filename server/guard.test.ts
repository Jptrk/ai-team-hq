/**
 * Checks the file guard that fences agents in. Run: npm run test:guard
 * Builds throwaway folders under the OS temp dir; touches nothing else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentsDir } from './attachments';
import type { Agent, ItemStatus, ProjectConnection, RunReason } from '../shared/types';
import { updateConnection, type AllowedServer } from './connections';
import { claudeEnv, HQ_ROOT } from './paths';
import { z } from 'zod';
import {
  coldBudget,
  doneRefusal,
  dropSession,
  freshStartReason,
  guard,
  logAutoChanges,
  logUnfinishedAutoChanges,
  rememberSession,
  retryBlocked,
  retryRefusal,
  runCost,
  SDK_VERSION,
  sessionKeyOf,
  targetOf,
  toolsetPrint,
  turnUsageOf,
  type AutoChange,
  type GuardContext,
  type RetryState,
  type SessionParts,
  type TurnUsage,
} from './runner/claude';
import { charge } from './runner/index';
import { inputSaysDelete, isDestructiveTool, isReadOnlyTool } from './mcp';
import type { Project } from './store';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-guard-'));
const repo = path.join(root, 'repo');
const ws = path.join(root, 'ws', 'leo');
fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
fs.mkdirSync(ws, { recursive: true });

// The guard reads the saved connections again on every MCP call: by default, each one given is on for leo.
const saved = (servers: AllowedServer[]): ProjectConnection[] => servers.map((c) => ({ name: c.name, source: 'user', enabled: true, desks: ['leo'], mode: c.mode }));
const fakeProject = (access: 'read' | 'write', connections: ProjectConnection[] = []) =>
  ({ id: 'guard-test', meta: { path: repo, access }, state: { connections } }) as unknown as Project;
const leo = { id: 'leo' } as Agent;
// Only paths are computed; nothing is created there.
const images = attachmentsDir('guard-test');
const otherImages = attachmentsDir('another-project');

async function decide(access: 'read' | 'write', tool: string, input: Record<string, unknown>) {
  const result = await guard({ project: fakeProject(access), dir: ws })(tool, input);
  return result.behavior;
}

const cases: [string, 'read' | 'write', string, Record<string, unknown>, 'allow' | 'deny'][] = [
  ['read own workspace', 'read', 'Read', { file_path: path.join(ws, 'memory.md') }, 'allow'],
  ['relative read resolves to workspace', 'read', 'Read', { file_path: 'ROLE.md' }, 'allow'],
  ['read project file', 'read', 'Read', { file_path: path.join(repo, 'apps', 'web', 'page.tsx') }, 'allow'],
  ['read project file, other casing', 'read', 'Read', { file_path: path.join(repo, 'APPS', 'web', 'page.tsx').toUpperCase() }, process.platform === 'win32' ? 'allow' : 'deny'],
  ['read outside everything', 'read', 'Read', { file_path: path.join(root, 'secret.txt') }, 'deny'],
  ['escape with ..', 'read', 'Read', { file_path: path.join(ws, '..', '..', 'secret.txt') }, 'deny'],
  ['grep project folder', 'read', 'Grep', { pattern: 'paypal', path: repo }, 'allow'],
  ['grep outside', 'read', 'Grep', { pattern: 'x', path: root }, 'deny'],
  ['glob absolute inside project', 'read', 'Glob', { pattern: path.join(repo, 'apps', '**', '*.tsx') }, 'allow'],
  ['glob absolute outside', 'read', 'Glob', { pattern: path.join(root, '**', '*') }, 'deny'],
  ['write own workspace', 'read', 'Write', { file_path: path.join(ws, 'reports', 'plan.md'), content: '' }, 'allow'],
  ['write project, read-only project', 'read', 'Edit', { file_path: path.join(repo, 'apps', 'web', 'page.tsx') }, 'deny'],
  ['write project, writable project', 'write', 'Edit', { file_path: path.join(repo, 'apps', 'web', 'page.tsx') }, 'allow'],
  ['write .env, writable project', 'write', 'Write', { file_path: path.join(repo, '.env.local'), content: '' }, 'deny'],
  ['write .git, writable project', 'write', 'Write', { file_path: path.join(repo, '.git', 'config'), content: '' }, 'deny'],
  ['write node_modules, writable project', 'write', 'Write', { file_path: path.join(repo, 'node_modules', 'x', 'i.js'), content: '' }, 'deny'],
  ['write key file, writable project', 'write', 'Write', { file_path: path.join(repo, 'certs', 'server.pem'), content: '' }, 'deny'],
  ['bash never', 'write', 'Bash', { command: 'ls' }, 'deny'],
  ['read a pasted image', 'read', 'Read', { file_path: path.join(images, 'att_0123456789ab.png') }, 'allow'],
  ['glob the pasted images', 'read', 'Glob', { pattern: path.join(images, '*.png') }, 'allow'],
  ['write into the pasted images', 'write', 'Write', { file_path: path.join(images, 'att_0123456789ab.png'), content: '' }, 'deny'],
  ['edit a pasted image', 'write', 'Edit', { file_path: path.join(images, 'att_0123456789ab.png') }, 'deny'],
  ["read another project's images", 'read', 'Read', { file_path: path.join(otherImages, 'att_0123456789ab.png') }, 'deny'],
  ['hq tools always', 'read', 'mcp__hq__report_done', { summary: 'done' }, 'allow'],
];

let failed = 0;
for (const [label, access, tool, input, want] of cases) {
  const got = await decide(access, tool, input);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}

// ---------- a link inside the project folder that points outside ----------
const outside = path.join(root, 'outside');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
const link = path.join(repo, 'linked');
let linked = true;
try {
  fs.symlinkSync(outside, link, 'junction');
} catch (e) {
  linked = false;
  console.log(`skip link cases: ${e instanceof Error ? e.message : String(e)}`);
}
const linkCases: typeof cases = linked
  ? [
      ['read through a link to outside', 'read', 'Read', { file_path: path.join(link, 'secret.txt') }, 'deny'],
      ['grep through a link to outside', 'read', 'Grep', { pattern: 'x', path: link }, 'deny'],
      ['glob through a link to outside', 'read', 'Glob', { pattern: path.join(link, '**', '*') }, 'deny'],
      ['new file through a link, writable project', 'write', 'Write', { file_path: path.join(link, 'new.txt'), content: '' }, 'deny'],
      ['real project files still read', 'read', 'Read', { file_path: path.join(repo, 'apps', 'web', 'page.tsx') }, 'allow'],
    ]
  : [];
for (const [label, access, tool, input, want] of linkCases) {
  const got = await decide(access, tool, input);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} link: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}

// ---------- a linked folder that contains HQ itself ----------
const aroundHq = { id: 'guard-test', meta: { path: path.dirname(HQ_ROOT), access: 'write' } } as unknown as Project;
const aroundCases: [string, string, Record<string, unknown>, 'allow' | 'deny'][] = [
  ["HQ's own data stays out of reach", 'Read', { file_path: path.join(HQ_ROOT, 'data', 'projects.json') }, 'deny'],
  ["another project's data stays out of reach", 'Grep', { pattern: 'x', path: path.join(HQ_ROOT, 'data', 'projects', 'another-project') }, 'deny'],
  ['HQ code is never written', 'Write', { file_path: path.join(HQ_ROOT, 'server', 'x.ts'), content: '' }, 'deny'],
  ["this project's pasted images still read", 'Read', { file_path: path.join(images, 'att_0123456789ab.png') }, 'allow'],
  ['the rest of that folder still reads', 'Read', { file_path: path.join(path.dirname(HQ_ROOT), 'elsewhere', 'notes.md') }, 'allow'],
];
for (const [label, tool, input, want] of aroundCases) {
  const got = (await guard({ project: aroundHq, dir: ws })(tool, input)).behavior;
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} around HQ: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}
// ---------- MCP connections ----------
const github: AllowedServer = {
  name: 'github',
  key: 'github',
  mode: 'ask',
  tools: {
    pull_request_read: { name: 'pull_request_read', readOnly: true, reads: true },
    add_issue_comment: { name: 'add_issue_comment', reads: false },
    run_secret_scanning: { name: 'run_secret_scanning', readOnly: true, reads: false },
  },
};
const jira: AllowedServer = { name: 'atlassian', key: 'atlassian', mode: 'read', tools: {} };
const docs: AllowedServer = { name: 'claude.ai Claude Docs', key: 'claude_ai_Claude_Docs', mode: 'ask', tools: {} };
// Auto: changes run on their own, deletes still ask.
const figma: AllowedServer = {
  name: 'figma',
  key: 'figma',
  mode: 'auto',
  tools: {
    get_file: { name: 'get_file', readOnly: true, reads: true },
    post_comment: { name: 'post_comment', reads: false },
    archive_file: { name: 'archive_file', destructive: true, reads: false },
  },
};

async function mcp(tool: string, reason: 'instruction' | 'approved' | 'message' | 'handoff', connections: AllowedServer[], input: Record<string, unknown> = {}) {
  return (await guard({ project: fakeProject('read', saved(connections)), dir: ws, agent: leo, reason, connections })(tool, input)).behavior;
}

const mcpCases: [string, string, 'instruction' | 'approved' | 'message' | 'handoff', AllowedServer[], 'allow' | 'deny'][] = [
  ['chat: send_message is always allowed', 'mcp__hq__send_message', 'message', [], 'allow'],
  ['chat: hand_off is always allowed', 'mcp__hq__hand_off', 'instruction', [], 'allow'],
  ['chat: a teammate message cannot unlock a github write', 'mcp__github__add_issue_comment', 'message', [github], 'deny'],
  ['chat: a hand-off run cannot unlock a github write', 'mcp__github__add_issue_comment', 'handoff', [github], 'deny'],
  ['chat: github reads still work in a message run', 'mcp__github__pull_request_read', 'message', [github], 'allow'],
  ['github read', 'mcp__github__pull_request_read', 'instruction', [github], 'allow'],
  ['github read, tool not seen by a check', 'mcp__github__list_commits', 'instruction', [github], 'allow'],
  ['github comment before approval', 'mcp__github__add_issue_comment', 'instruction', [github], 'deny'],
  ['github comment after approval', 'mcp__github__add_issue_comment', 'approved', [github], 'allow'],
  ['read-only hint cannot beat a write name', 'mcp__github__run_secret_scanning', 'instruction', [github], 'deny'],
  ['unknown github tool counts as a change', 'mcp__github__frobnicate', 'instruction', [github], 'deny'],
  ['github not connected for this desk', 'mcp__github__pull_request_read', 'instruction', [], 'deny'],
  ['read-only jira read', 'mcp__atlassian__getJiraIssue', 'instruction', [jira], 'allow'],
  ['read-only jira write, even approved', 'mcp__atlassian__createJiraIssue', 'approved', [jira], 'deny'],
  ['camelCase jira comment counts as a change', 'mcp__atlassian__addCommentToJiraIssue', 'approved', [jira], 'deny'],
  ['claude.ai connector read', 'mcp__claude_ai_Claude_Docs__read', 'instruction', [docs], 'allow'],
  ['claude.ai connector write before approval', 'mcp__claude_ai_Claude_Docs__update', 'instruction', [docs], 'deny'],
  ['claude.ai connector not turned on', 'mcp__claude_ai_Figma__get_screenshot', 'instruction', [github, docs], 'deny'],
  ['prefix trick: github vs github_evil', 'mcp__github_evil__pull_request_read', 'instruction', [github], 'deny'],
  ['auto: read', 'mcp__figma__get_file', 'instruction', [figma], 'allow'],
  ['auto: a change runs without approval', 'mcp__figma__post_comment', 'instruction', [figma], 'allow'],
  ['auto: a change in a message run', 'mcp__figma__create_frame', 'message', [figma], 'allow'],
  ['auto: a delete still needs approval', 'mcp__figma__delete_node', 'instruction', [figma], 'deny'],
  ['auto: camelCase remove still needs approval', 'mcp__figma__removeComment', 'message', [figma], 'deny'],
  ['auto: a tool the server marks destructive still needs approval', 'mcp__figma__archive_file', 'instruction', [figma], 'deny'],
  ['auto: a delete after approval', 'mcp__figma__delete_node', 'approved', [figma], 'allow'],
  ['auto on one server does not open another', 'mcp__github__add_issue_comment', 'instruction', [github, figma], 'deny'],
];
for (const [label, tool, reason, conns, want] of mcpCases) {
  const got = await mcp(tool, reason, conns);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}

// Auto never reaches huddles or QA checks: those only read.
let extra = 0;
for (const mode of ['huddle', 'qa'] as const) {
  const got = (await guard({ project: fakeProject('read', saved([figma])), dir: ws, agent: leo, reason: mode, mode, connections: [figma] })('mcp__figma__post_comment', {})).behavior;
  const ok = got === 'deny';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp: auto stays read-only in a ${mode}: ${got}`);
}
extra += 2;

// Auto looks inside the input for a delete the tool's name does not show.
const inputCases: [string, string, 'instruction' | 'approved', Record<string, unknown>, 'allow' | 'deny'][] = [
  ['a *_write tool with method remove', 'mcp__figma__sub_issue_write', 'instruction', { method: 'remove', sub_issue_id: 7 }, 'deny'],
  ['a *_write tool with method delete_pending', 'mcp__figma__pull_request_review_write', 'instruction', { method: 'delete_pending', pullNumber: 4 }, 'deny'],
  ['an HTTP DELETE', 'mcp__figma__http_request', 'instruction', { httpMethod: 'DELETE', url: 'https://api.example.com/x/1' }, 'deny'],
  ['a batch with one delete', 'mcp__figma__batch', 'instruction', { batch: [{ op: 'insert', text: 'Hi' }, { op: 'delete', id: 'b2' }] }, 'deny'],
  ['a list of ops', 'mcp__figma__apply', 'instruction', { ops: ['insert', 'removeBlock'] }, 'deny'],
  ['an operation named by its key', 'mcp__figma__batch_update', 'instruction', { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 9 } } }] }, 'deny'],
  ['force: true', 'mcp__figma__push_files', 'instruction', { branch: 'main', force: true }, 'deny'],
  ['archived: true', 'mcp__figma__patch_page', 'instruction', { page_id: 'p1', archived: true }, 'deny'],
  ['code that removes a node', 'mcp__figma__use_figma', 'instruction', { code: 'figma.currentPage.findOne((n) => n.name === "Old").remove()' }, 'deny'],
  ['SQL that deletes', 'mcp__figma__execute_sql', 'instruction', { query: 'DELETE FROM users WHERE id = 1' }, 'deny'],
  ['SQL that drops a table', 'mcp__figma__execute_sql', 'instruction', { sql: 'drop table if exists old_orders' }, 'deny'],
  ['a shell rm', 'mcp__figma__run_script', 'instruction', { command: 'rm -rf build && npm run build && echo done' }, 'deny'],
  ['a delete inside the input, after approval', 'mcp__figma__sub_issue_write', 'approved', { method: 'remove' }, 'allow'],
  ['a *_write tool with method update', 'mcp__figma__issue_write', 'instruction', { method: 'update', issue_number: 5, state: 'closed' }, 'allow'],
  ['a comment body that mentions deleting', 'mcp__figma__issue_write', 'instruction', { method: 'create', body: 'Please delete from the backlog and truncate the old logs. Call cache.delete(key).' }, 'allow'],
  ['a page that mentions deleting', 'mcp__figma__update_page', 'instruction', { title: 'Cleanup', content: 'We should delete the old pages and drop table x later.' }, 'allow'],
  ['the word delete under a plain key', 'mcp__figma__post_comment', 'instruction', { message: 'delete' }, 'allow'],
  ['force: false', 'mcp__figma__push_files', 'instruction', { branch: 'main', force: false }, 'allow'],
  ['code that only creates', 'mcp__figma__use_figma', 'instruction', { code: 'const f = figma.createFrame(); f.name = "Hero"; f.resize(1440, 900);' }, 'allow'],
  ['SQL that updates', 'mcp__figma__execute_sql', 'instruction', { query: "UPDATE users SET name = 'Ana' WHERE id = 1" }, 'allow'],
  ['a long action value is not an action', 'mcp__figma__post_comment', 'instruction', { type: 'Notes on what to remove from the plan next week' }, 'allow'],
];
for (const [label, tool, reason, input, want] of inputCases) {
  const got = await mcp(tool, reason, [figma], input);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp input: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}
extra += inputCases.length;
{
  // Too deep or too many values: best effort, so it lets them through, as documented.
  const deep = { a: { b: { c: { d: { e: { method: 'delete' } } } } } };
  const many = { items: [...Array.from({ length: 600 }, (_, i) => ({ op: `insert_${i}` })), { op: 'delete' }] };
  const ok = inputSaysDelete({ a: { b: { method: 'delete' } } }) && !inputSaysDelete(deep) && !inputSaysDelete(many);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp input: looks 4 levels deep and at 500 values at most`);
  extra += 1;
}

// Which tool names count as deletes.
const destructiveCases: [string, boolean][] = [
  ['delete_node', true],
  ['deleteIssue', true],
  ['remove-label', true],
  ['purge_cache', true],
  ['revoke_token', true],
  ['rm_file', true],
  ['del_key', true],
  ['unlink_account', true],
  ['detach_policy', true],
  ['disconnect_integration', true],
  ['archive_project', true],
  ['discard_draft', true],
  ['prune_branches', true],
  ['flush_queue', true],
  ['kill_process', true],
  ['terminate_instance', true],
  ['reset_password', true],
  ['overwrite_file', true],
  ['force_push', true],
  ['removes_member', true],
  ['clears_cache', true],
  ['trashes_note', true],
  ['deleteall', true],
  ['batchdelete', true],
  ['batchDelete', true],
  ['HTTPDelete', true],
  ['file-batchdelete', true],
  ['files.delete', true],
  ['update_file', false],
  ['create_comment', false],
  ['undelete_note', false],
  ['get_removed_items', false],
  ['get_deleted_items', false],
  ['close_issue', false],
  ['cancel_job', false],
  ['dismiss_alert', false],
  ['revert_commit', false],
  ['unassign_user', false],
  ['disable_rule', false],
  ['rename_frame', false],
  ['enforce_policy', false],
  ['list_dropdowns', false],
  ['getJiraIssueRemoteIssueLinks', false],
];
for (const [tool, want] of destructiveCases) {
  const ok = isDestructiveTool(tool) === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} delete check: ${tool}: ${!want ? 'not ' : ''}a delete`);
}
extra += destructiveCases.length;

// A name that says delete never reads, whatever the hint or the prefix.
const readCases: [string, { readOnly?: boolean } | undefined, boolean][] = [
  ['purge_cache', { readOnly: true }, false],
  ['get_and_purge', undefined, false],
  ['get_and_purge', { readOnly: true }, false],
  ['listAndDeleteAll', { readOnly: true }, false],
  ['get_removed_items', undefined, true],
  ['get_deleted_items', { readOnly: true }, true],
  ['get_file', undefined, true],
  ['pull_request_read', { readOnly: true }, true],
  ['getJiraIssue', undefined, true],
  ['resolve-library-id', undefined, true],
  ['take_screenshot', undefined, true],
];
for (const [tool, hint, want] of readCases) {
  const ok = isReadOnlyTool(tool, hint) === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} read check: ${tool}${hint?.readOnly ? ' (marked read-only)' : ''}: ${want ? 'reads' : 'not a read'}`);
}
extra += readCases.length;

// The saved connection is read again on every call: a change mid-run counts at once, but only toward stricter.
{
  const run = (live: ProjectConnection[], captured: AllowedServer, reason: RunReason = 'instruction') => {
    const g = guard({ project: fakeProject('read', live), dir: ws, agent: leo, reason, connections: [captured] });
    return async (tool: string) => (await g(`mcp__figma__${tool}`, {})).behavior;
  };
  const on = saved([figma])[0];
  const askFigma: AllowedServer = { ...figma, mode: 'ask' };
  const liveCases: [string, ProjectConnection[], AllowedServer, string, RunReason, 'allow' | 'deny'][] = [
    ['turned off mid-run: reads stop too', [{ ...on, enabled: false }], figma, 'get_file', 'instruction', 'deny'],
    ['turned off mid-run: changes stop', [{ ...on, enabled: false }], figma, 'post_comment', 'instruction', 'deny'],
    ['this desk dropped mid-run', [{ ...on, desks: ['nora'] }], figma, 'get_file', 'instruction', 'deny'],
    ['gone from the saved list', [], figma, 'get_file', 'instruction', 'deny'],
    ['auto switched to ask mid-run: a change waits', [{ ...on, mode: 'ask' }], figma, 'post_comment', 'instruction', 'deny'],
    ['auto switched to read mid-run: even approved', [{ ...on, mode: 'read' }], figma, 'post_comment', 'approved', 'deny'],
    ['ask switched to auto mid-run: still ask', [{ ...on, mode: 'auto' }], askFigma, 'post_comment', 'instruction', 'deny'],
    ['unchanged auto still runs', [on], figma, 'post_comment', 'instruction', 'allow'],
  ];
  for (const [label, live, captured, tool, reason, want] of liveCases) {
    const got = await run(live, captured, reason)(tool);
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} mcp live: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
  }
  extra += liveCases.length;

  // Turning a connection off puts Auto back on Ask, so turning it on again never skips the confirm.
  // A claude.ai connector found by a check, so it is set up (one that is gone can't be turned back on).
  const conn: ProjectConnection = { name: 'hq-guard-test-auto', source: 'claude-ai', enabled: true, desks: ['leo'], mode: 'auto' };
  const info = { name: conn.name, source: 'claude-ai', transport: 'claude-ai', target: 'claude.ai connector', auth: 'oauth' };
  const logged: string[] = [];
  const p = {
    meta: { path: null },
    state: { connections: [conn], checks: { [conn.name]: { state: 'connected', checkedAt: '2026-01-01T00:00:00.000Z', tools: [], info } }, agents: [{ id: 'leo', isHuman: false }] },
    log: (_id: string, text: string) => logged.push(text),
    commit: () => undefined,
  } as unknown as Project;
  updateConnection(p, conn.name, { enabled: false });
  const off = conn.mode === 'ask' && /Auto back to Ask/.test(logged[0] ?? '');
  updateConnection(p, conn.name, { enabled: true });
  const ok = off && conn.enabled && conn.mode === 'ask';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} connections: turning off puts Auto back on Ask: ${conn.mode} ${JSON.stringify(logged)}`);
  extra += 1;
}

// An auto change is logged once it worked, and only then.
const result = (id: string, isError: boolean) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });
{
  const autoChanges = new Map<string, AutoChange>();
  const autoAllowed: string[] = [];
  const logged: string[] = [];
  const project = { ticket: () => 'GA-3', log: (_id: string, text: string) => logged.push(text) } as unknown as Project;
  const g = guard({ project: fakeProject('read', saved([figma])), dir: ws, agent: leo, reason: 'instruction', connections: [figma], autoChanges, autoAllowed });
  await g('mcp__figma__post_comment', {}, { toolUseID: 'tu_ok' });
  await g('mcp__figma__rename_frame', {}, { toolUseID: 'tu_err' });
  await g('mcp__figma__delete_node', {}, { toolUseID: 'tu_del' });
  const ctx = { autoChanges, project, agent: leo, item: { id: 'wi_1', number: 3 } } as never;
  logAutoChanges(ctx, result('tu_ok', false));
  logAutoChanges(ctx, result('tu_err', true));
  logAutoChanges(ctx, result('tu_del', false));
  const ok = logged.length === 1 && /figma with post_comment for GA-3 \(auto, as you\)/.test(logged[0]) && autoChanges.size === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp: auto changes are logged once they worked: ${JSON.stringify(logged)}`);
  // The count of allowed changes outlives the log, for the retry check.
  const counted = autoAllowed.length === 2 && autoAllowed.every((s) => s === 'figma');
  if (!counted) failed++;
  console.log(`${counted ? 'ok  ' : 'FAIL'} mcp: allowed auto changes are counted, deletes not: ${JSON.stringify(autoAllowed)}`);
  extra += 2;
}

// The log line says what it touched, and a run that stopped early still logs what may have gone through.
{
  const autoChanges = new Map<string, AutoChange>();
  const logged: string[] = [];
  const project = { ticket: () => 'GA-4', log: (_id: string, text: string) => logged.push(text) } as unknown as Project;
  const ctx: GuardContext = { project: fakeProject('read', saved([figma])), dir: ws, agent: leo, reason: 'instruction', connections: [figma], autoChanges, autoAllowed: [] };
  const g = guard(ctx);
  await g('mcp__figma__post_comment', { issue_number: 42, body: 'x' }, { toolUseID: 'tu_a' });
  await g('mcp__figma__rename_frame', { title: `Line one\nline two ${'x'.repeat(80)}` }, { toolUseID: 'tu_b' });
  const logCtx = { autoChanges, project, agent: leo, item: { id: 'wi_2', number: 4 } } as never;
  logAutoChanges(logCtx, result('tu_a', false));
  logUnfinishedAutoChanges(logCtx);
  const ok =
    logged.length === 2 &&
    /^Changed something on figma with post_comment \(issue_number: 42\) for GA-4 \(auto, as you\)$/.test(logged[0]) &&
    /^May have changed something on figma with rename_frame \(title: Line one line two x+…\) for GA-4 \(auto, as you\): the run stopped before the result came back$/.test(logged[1]) &&
    !/\n/.test(logged[1]) &&
    autoChanges.size === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp: log lines name the target, and unfinished changes are logged: ${JSON.stringify(logged)}`);
  const targets: [Record<string, unknown>, string | undefined][] = [
    [{ url: 'https://example.com/pages/1?token=secret', title: 'T' }, 'url: example.com/pages/1'],
    [{ fileKey: 'abc123', name: 'Hero' }, 'name: Hero'],
    [{ id: '  ', key: 'GA-9' }, 'key: GA-9'],
    [{ body: 'only text' }, undefined],
  ];
  const targetsOk = targets.every(([input, want]) => targetOf(input) === want) && (targetOf({ title: 'y'.repeat(100) }) ?? '').length <= 'title: '.length + 60;
  if (!targetsOk) failed++;
  console.log(`${targetsOk ? 'ok  ' : 'FAIL'} mcp: the target is short, one line, and never a query string`);
  extra += 2;
}

// A run that already made an auto change is not retried in a fresh session.
{
  const none = retryRefusal([]);
  const why = retryRefusal(['figma', 'github', 'figma']);
  const ok = none === null && why === 'Stopped instead of retrying: it already changed things on figma, github automatically, and a retry could repeat them.';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} retry: no fresh-session retry after an auto change: ${why}`);
  extra += 1;
}

// ---------- resuming a desk's session ----------
// A cold, big session starts fresh: re-reading it at full price would cost more than a chat reply's budget.
{
  const now = Date.parse('2026-10-02T12:00:00Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const limits = { cacheMin: 55, tokens: 40_000 };
  const cases: [string, Parameters<typeof freshStartReason>[0], string, boolean][] = [
    ['no session yet', {}, 'k1', false],
    ['big but warm, same instructions', { sessionId: 's', sessionAt: ago(10), sessionTokens: 120_000, sessionKey: 'k1' }, 'k1', false],
    ['big and idle past the cache', { sessionId: 's', sessionAt: ago(70), sessionTokens: 120_000, sessionKey: 'k1' }, 'k1', true],
    ['big, warm, but the instructions changed', { sessionId: 's', sessionAt: ago(2), sessionTokens: 120_000, sessionKey: 'k0' }, 'k1', true],
    ['small and cold is cheap to resume', { sessionId: 's', sessionAt: ago(300), sessionTokens: 12_000, sessionKey: 'k0' }, 'k1', false],
    ['from before HQ counted tokens: judged by cost so far', { sessionId: 's', sessionTotalUsd: 16.4 }, 'k1', true],
    ['from before, cheap so far', { sessionId: 's', sessionTotalUsd: 0.8 }, 'k1', false],
    // The base (system prompt, tools, first prompt) comes with any fresh session too, so only what grew past it counts.
    ['cold, but only grown 25k past its base', { sessionId: 's', sessionAt: ago(70), sessionTokens: 60_000, sessionBaseTokens: 35_000, sessionKey: 'k1' }, 'k1', false],
    ['cold and grown 45k past its base', { sessionId: 's', sessionAt: ago(70), sessionTokens: 80_000, sessionBaseTokens: 35_000, sessionKey: 'k1' }, 'k1', true],
    ['cold, base unknown: judged by its whole size', { sessionId: 's', sessionAt: ago(70), sessionTokens: 60_000, sessionKey: 'k1' }, 'k1', true],
  ];
  for (const [label, agent, key, want] of cases) {
    const got = Boolean(freshStartReason(agent, key, now, limits));
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} session: ${label}: ${got ? 'fresh' : 'resume'}`);
  }
  extra += cases.length;
  const legacy = freshStartReason({ sessionId: 's', sessionTotalUsd: 16.4 }, 'k1', now, limits);
  const changed = freshStartReason({ sessionId: 's', sessionAt: ago(2), sessionTokens: 120_000, sessionKey: 'k0' }, 'k1', now, limits);
  const textOk = legacy === "its session predates HQ's cache tracking (about $16.40 so far)" && changed === 'its session (about 120k tokens) was cached with different instructions or tools';
  if (!textOk) failed++;
  console.log(`${textOk ? 'ok  ' : 'FAIL'} session: the log says why: ${legacy} / ${changed}`);
  extra += 1;
}

// A retry runs the whole task again: only when the failed attempt has done nothing yet.
{
  const idle = (): RetryState => ({
    autoAllowed: [],
    comments: 0,
    commented: false,
    sends: 0,
    sentToThread: false,
    awaiting: [],
    raised: false,
    finished: false,
    changed: new Set(),
    pendingWrites: new Map(),
  });
  const cases: [string, Partial<RetryState>, RegExp | null][] = [
    ['nothing done yet', {}, null],
    ['commented on another ticket', { comments: 1 }, /commented on a ticket/],
    ['messaged another thread', { sends: 1 }, /sent a message/],
    ['asked a teammate', { awaiting: ['nora'] }, /sent a message/],
    ['changed a project file', { changed: new Set(['app/x.ts']) }, /changed project files/],
    ['a write still waiting on its result', { pendingWrites: new Map([['tu_1', ['app/x.ts']]]) }, /changed project files/],
    ['raised a decision', { raised: true, commented: true }, /raised a decision/],
    ['an auto change', { autoAllowed: ['figma'], comments: 1 }, /changed things on figma automatically/],
  ];
  for (const [label, state, want] of cases) {
    const why = retryBlocked({ ...idle(), ...state });
    const ok = want === null ? why === null : Boolean(why && want.test(why) && why.startsWith('Stopped instead of retrying: it already'));
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} retry: ${label}: ${why ?? 'may retry'}`);
  }
  extra += cases.length;
}

// A budget failure is a cold cache only when the first turn missed it: it wrote the session to the cache instead of reading it.
{
  const budget = 'error_max_budget_usd: Reached maximum budget ($1)';
  const cases: [string, string, number, TurnUsage | undefined, boolean][] = [
    ['first turn wrote the session to the cache', budget, 1, { context: 90_000, cacheWrite: 85_000, cacheRead: 3_000 }, true],
    ['first turn read nothing from the cache', budget, 2, { context: 90_000, cacheWrite: 0, cacheRead: 0 }, true],
    ['first turn read the session from the cache', budget, 1, { context: 90_000, cacheWrite: 500, cacheRead: 88_000 }, false],
    ['no usage seen', budget, 1, undefined, false],
    ['too many turns in', budget, 5, { context: 90_000, cacheWrite: 85_000, cacheRead: 0 }, false],
    ['not a budget failure', 'error_max_turns', 1, { context: 90_000, cacheWrite: 85_000, cacheRead: 0 }, false],
  ];
  for (const [label, message, turns, first, want] of cases) {
    const got = coldBudget(message, turns, first);
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} retry: ${label}: ${got ? 'cold, retry' : 'not cold'}`);
  }
  extra += cases.length;
}

// A retried run is charged for both attempts: the failed one's share is worked out before its session is dropped.
{
  const agent: Pick<Agent, 'sessionId' | 'sessionTotalUsd' | 'spentUsd'> = { sessionId: 's1', sessionTotalUsd: 4, spentUsd: 10 };
  const first = dropSession(agent, { sessionId: 's1', costUsd: 4.9 });
  const dropped = agent.sessionId === undefined && agent.sessionTotalUsd === undefined;
  // The retry's fresh session: all of its total is this run's, and it becomes the session's new total.
  const cost = charge(agent, 's2', 0.3, first);
  const otherSession = dropSession({ sessionId: 's1', sessionTotalUsd: 4 }, { sessionId: 's9', costUsd: 0.7 });
  const unknown = dropSession({ sessionId: 's1', sessionTotalUsd: 4 }, null);
  const failedRetry = charge({ spentUsd: 1 }, undefined, undefined, 0.5);
  const ok =
    Math.abs(first - 0.9) < 1e-9 &&
    dropped &&
    cost === 1.2 &&
    agent.spentUsd === 11.2 &&
    agent.sessionId === 's2' &&
    agent.sessionTotalUsd === 0.3 &&
    Math.abs(otherSession - 0.7) < 1e-9 &&
    unknown === 0 &&
    failedRetry === 0.5 &&
    runCost({ sessionId: 's1', sessionTotalUsd: 4 }, 's1', 3) === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} retry: both attempts are charged: first ${first.toFixed(2)}, run ${cost}, spent ${agent.spentUsd}`);
  extra += 1;
}

// Token counts: synthetic messages carry zeros and do not count; a run that never reached Claude leaves the session's time and key alone.
{
  const zero = turnUsageOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  const real = turnUsageOf({ input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 1_000, cache_read_input_tokens: null });
  const usageOk = zero === null && turnUsageOf(undefined) === null && real?.context === 1_210 && real.cacheWrite === 1_000 && real.cacheRead === 0;
  if (!usageOk) failed++;
  console.log(`${usageOk ? 'ok  ' : 'FAIL'} session: zero usage does not count as a turn: ${JSON.stringify(real)}`);

  const old = { sessionAt: '2026-10-02T09:00:00.000Z', sessionKey: 'k0', sessionTokens: 120_000, sessionBaseTokens: 30_000 };
  const at = '2026-10-02T12:00:00.000Z';
  const turn = { context: 22_000, cacheWrite: 21_000, cacheRead: 0 };
  // Resumed, nothing reached Claude: everything stays.
  const a = { ...old };
  rememberSession(a, { key: 'k1', fresh: false, contextTokens: 0 }, at);
  // Resumed and used: time, key and size move on; the base stays the session's own.
  const b = { ...old };
  rememberSession(b, { key: 'k1', fresh: false, contextTokens: 130_000, firstTurn: { context: 125_000, cacheWrite: 500, cacheRead: 124_000 } }, at);
  // Fresh (a cold start or a retry) that failed before any reply: the old big size and base do not carry over.
  const c = { ...old };
  rememberSession(c, { key: 'k1', fresh: true, contextTokens: 0 }, at);
  // Fresh and used: its first turn is the new base.
  const d = { ...old };
  rememberSession(d, { key: 'k1', fresh: true, contextTokens: 25_000, firstTurn: turn }, at);
  const ok =
    JSON.stringify(a) === JSON.stringify(old) &&
    b.sessionAt === at && b.sessionKey === 'k1' && b.sessionTokens === 130_000 && b.sessionBaseTokens === 30_000 &&
    c.sessionAt === old.sessionAt && c.sessionKey === 'k0' && c.sessionTokens === 0 && c.sessionBaseTokens === undefined &&
    d.sessionAt === at && d.sessionKey === 'k1' && d.sessionTokens === 25_000 && d.sessionBaseTokens === 22_000;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} session: what a run remembers: ${JSON.stringify({ a, b, c, d })}`);
  extra += 2;
}

// The session key changes with anything cached ahead of the messages: hq tools, connection tools, the SDK.
{
  const tool = (name: string, description: string, shape: z.ZodRawShape) => ({ name, description, inputSchema: shape });
  const hqPrint = (description = 'Post a status line.', max = 200) =>
    toolsetPrint({ instructions: 'HQ tools: post_update at the start.', tools: [tool('post_update', description, { text: z.string().max(max) })] });
  const figma = (tools: string[]): Pick<AllowedServer, 'key' | 'tools'> => ({ key: 'figma', tools: Object.fromEntries(tools.map((t) => [t, { name: t, reads: true }])) });
  const parts = (over: Partial<SessionParts> = {}): SessionParts => ({
    systemPrompt: 'You are Leo.',
    servers: { figma: {} },
    builtins: ['Read', 'Write'],
    hq: hqPrint(),
    connections: [figma(['get_file', 'get_screenshot'])],
    ...over,
  });
  const base = sessionKeyOf(parts(), '1.0.0');
  const same = sessionKeyOf(parts({ connections: [figma(['get_screenshot', 'get_file'])] }), '1.0.0');
  const differs = [
    sessionKeyOf(parts({ hq: hqPrint('Post a one-line status.') }), '1.0.0'),
    sessionKeyOf(parts({ hq: hqPrint(undefined, 300) }), '1.0.0'),
    sessionKeyOf(parts({ connections: [figma(['get_file', 'get_screenshot', 'post_comment'])] }), '1.0.0'),
    sessionKeyOf(parts(), '1.0.1'),
    sessionKeyOf(parts({ builtins: ['Read', 'Write', 'WebSearch'] }), '1.0.0'),
  ];
  const ok = same === base && differs.every((k) => k !== base) && new Set(differs).size === differs.length && SDK_VERSION !== 'unknown';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} session: the key sees hq tools, connection tools and the SDK (${SDK_VERSION})`);
  extra += 1;
}

// ---------- the environment Claude Code starts with ----------
// Git must not look above a desk's workspace into HQ's own repo: its `git status` reads server/ files,
// which made `node --watch` restart HQ and kill the run that had just started.
{
  const env = claudeEnv({ EXTRA: '1' }, { PATH: 'x', GIT_CEILING_DIRECTORIES: 'D:\\slow-share' });
  const ceilings = (env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter);
  const ok =
    ceilings.includes(HQ_ROOT) && ceilings.includes('D:\\slow-share') && env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS === '1' && env.EXTRA === '1' && env.PATH === 'x';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} env: git stops at HQ's folder and Claude Code's git context is off`);
  extra += 1;
}

// ---------- report_done on comment runs ----------
const doneCases: [string, RunReason, ItemStatus, 'refuse' | 'allow'][] = [
  ['comment run cannot close a ticket waiting on your decision', 'comment', 'needs-you', 'refuse'],
  ['comment run cannot close a held ticket', 'comment', 'held', 'refuse'],
  ['comment run may finish an in-progress ticket when asked', 'comment', 'in-progress', 'allow'],
  ['approved run finalizes as usual', 'approved', 'approved', 'allow'],
  ['instruction run finishes as usual', 'instruction', 'in-progress', 'allow'],
];
for (const [label, reason, status, want] of doneCases) {
  const why = doneRefusal(reason, status);
  const got = why ? 'refuse' : 'allow';
  const ok = got === want && (!why || /comment_on_ticket/.test(why));
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} report_done: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}

if (linked) fs.unlinkSync(link);
fs.rmSync(root, { recursive: true, force: true });
assert.equal(failed, 0, `${failed} guard case(s) failed`);
console.log(`\nall ${cases.length + linkCases.length + aroundCases.length + mcpCases.length + extra + doneCases.length} guard cases pass`);
