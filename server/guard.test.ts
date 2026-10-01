/**
 * Checks the file guard that fences agents in. Run: npm run test:guard
 * Builds throwaway folders under the OS temp dir; touches nothing else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentsDir } from './attachments';
import type { ItemStatus, RunReason } from '../shared/types';
import type { AllowedServer } from './connections';
import { HQ_ROOT } from './paths';
import { doneRefusal, guard } from './runner/claude';
import type { Project } from './store';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-guard-'));
const repo = path.join(root, 'repo');
const ws = path.join(root, 'ws', 'leo');
fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
fs.mkdirSync(ws, { recursive: true });

const fakeProject = (access: 'read' | 'write') => ({ id: 'guard-test', meta: { path: repo, access } }) as unknown as Project;
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

async function mcp(tool: string, reason: 'instruction' | 'approved' | 'message' | 'handoff', connections: AllowedServer[]) {
  return (await guard({ project: fakeProject('read'), dir: ws, reason, connections })(tool, {})).behavior;
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
];
for (const [label, tool, reason, conns, want] of mcpCases) {
  const got = await mcp(tool, reason, conns);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} mcp: ${label}: ${got}${ok ? '' : ` (wanted ${want})`}`);
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
console.log(`\nall ${cases.length + linkCases.length + aroundCases.length + mcpCases.length + doneCases.length} guard cases pass`);
