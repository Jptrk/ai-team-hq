/**
 * delete_file: desks delete into HQ's trash, only where they may write, never protected files.
 * Run: npm run test:delete. Works in throwaway folders under the OS temp dir; makes no Claude calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkItem } from '../shared/types';

// HQ reads data/ and workspaces/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-delete-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';
// The project folder sits outside HQ, as a real one does.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-delete-repo-'));
const repo = path.join(outside, 'repo');

const store = await import('./store');
const claude = await import('./runner/claude');
const { moveToTrash, trashRoot } = await import('./trash');

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Shop app', key: 'SA', path: null, access: 'write', template: 'dev' });
const leo = p.state.agents.find((a) => a.id === 'leo')!;
const dir = claude.workspaceFor(p.id, 'leo');

/** A fresh workspace and project folder for each case, and a run context for Leo's ticket run. */
function setup(access: 'read' | 'write' = 'write') {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(trashRoot(p.id), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ROLE.md'), 'Frontend.');
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory');
  fs.writeFileSync(path.join(dir, 'scratch.md'), 'old notes');
  fs.mkdirSync(path.join(repo, 'src', 'legacy'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'old.ts'), 'export {}');
  fs.writeFileSync(path.join(repo, 'src', 'legacy', 'a.ts'), 'a');
  fs.writeFileSync(path.join(repo, 'src', 'legacy', 'b.ts'), 'b');
  fs.writeFileSync(path.join(repo, 'config', '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: main');
  fs.writeFileSync(path.join(repo, 'server.key'), 'key');
  store.updateProject(p.id, { path: repo, access });
  const item: WorkItem = { id: 'wi_del', number: 1, kind: 'fyi', status: 'in-progress', title: 'Clean up', summary: '', from: 'you', assignee: 'leo', dated: '2026-10-07', links: [], history: [] };
  p.state.items = [item];
  p.state.activity = [];
  const ctx = { project: p, dir, mode: 'ticket' as const, reason: 'manual' as const, agent: leo, changed: new Set<string>(), item, deletes: 0 };
  return { ctx, item };
}

const trashed = () => {
  const out: string[] = [];
  const walk = (at: string) => {
    if (!fs.existsSync(at)) return;
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(trashRoot(p.id), full).split(path.sep).slice(1).join('/'));
    }
  };
  walk(trashRoot(p.id));
  return out.sort();
};

let passed = 0;
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

test('workspace: a file goes to the trash, not away; the activity feed says so; it is no project change', async () => {
  const { ctx } = setup();
  const out = await claude.deleteForDesk(ctx, 'scratch.md', 'superseded by the report');
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /^Moved scratch\.md to HQ's trash \(.+\)\. Patrick can get it back from there\.$/);
  assert.equal(fs.existsSync(path.join(dir, 'scratch.md')), false);
  assert.deepEqual(trashed(), ['workspace/scratch.md']);
  assert.equal(fs.readFileSync(path.join(trashRoot(p.id), fs.readdirSync(trashRoot(p.id))[0], 'workspace', 'scratch.md'), 'utf8'), 'old notes');
  assert.equal(p.state.activity[0].text, 'Deleted scratch.md from its workspace (superseded by the report). It is in the trash.');
  assert.equal(ctx.changed.size, 0);
  assert.equal(ctx.deletes, 1);
});

test('project: a file and a folder go to the trash, count as changed for QA, and the ticket says so', async () => {
  const { ctx, item } = setup();
  assert.equal((await claude.deleteForDesk(ctx, path.join(repo, 'src', 'old.ts'), 'unused')).ok, true);
  assert.equal((await claude.deleteForDesk(ctx, path.join(repo, 'src', 'legacy'), 'replaced by the new cart')).ok, true);
  assert.deepEqual(trashed(), ['project/src/legacy/a.ts', 'project/src/legacy/b.ts', 'project/src/old.ts']);
  assert.deepEqual([...ctx.changed], ['src/old.ts', 'src/legacy/']);
  assert.equal(item.history[0].text, "Deleted src/old.ts from the project folder (unused). It is in HQ's trash.");
  assert.equal(fs.existsSync(path.join(repo, 'src', 'legacy')), false);
});

test('refused: what a desk may not write, it may not delete either, and some things always stay', async () => {
  const { ctx } = setup();
  const refused = async (target: string) => (await claude.deleteForDesk(ctx, target, 'cleanup')).text;
  assert.match(await refused('ROLE.md'), /That one stays/);
  assert.match(await refused('memory.md'), /That one stays/);
  assert.match(await refused('reports'), /That one stays/);
  assert.match(await refused('.'), /That one stays/);
  assert.match(await refused(repo), /That one stays/);
  assert.match(await refused(path.join(repo, 'config', '.env')), /Never delete \.env files or keys/);
  assert.match(await refused(path.join(repo, 'server.key')), /Never delete \.env files or keys/);
  assert.match(await refused(path.join(repo, '.git', 'HEAD')), /Never delete inside \.git/);
  assert.match(await refused(path.join(repo, 'config')), /That folder holds \.env\. Never delete \.env files or keys/);
  assert.match(await refused(path.join(outside, 'elsewhere.txt')), /^Stay inside/);
  assert.match(await refused(path.join(root, 'data', 'projects.json')), /^(Stay inside|That path is inside AI Team HQ)/);
  assert.match(await refused(path.join(repo, 'src', 'nothing.ts')), /There is nothing at that path/);
  assert.equal(ctx.deletes, 0, 'nothing counted');
  assert.deepEqual(trashed(), [], 'nothing moved');
  assert.ok(fs.existsSync(path.join(repo, 'config', '.env')));
});

test('odd names: Windows forms of a protected file, hidden streams, device and network paths are refused', async () => {
  const { ctx } = setup();
  const refused = async (target: string) => (await claude.deleteForDesk(ctx, target, 'cleanup')).text;
  for (const name of ['memory.md.', 'memory.md ', 'MEMORY.MD', 'Role.md', 'scratch.md:hidden']) {
    assert.match(await refused(name), /plain name|That one stays/, name);
  }
  assert.match(await refused(path.join(repo, 'config', '.ENV')), /Never delete \.env/);
  assert.match(await refused(`\\\\?\\${path.join(dir, 'scratch.md')}`), /plain path/);
  assert.match(await refused('\\\\server\\share\\x.txt'), /plain path/);
  assert.ok(fs.existsSync(path.join(dir, 'memory.md')) && fs.existsSync(path.join(dir, 'scratch.md')), 'nothing moved');
  assert.deepEqual(trashed(), []);
});

test('links: a folder holding a link is refused; a link on its own moves without touching what it points to', async () => {
  const { ctx } = setup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-delete-target-'));
  fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');
  const holder = path.join(dir, 'holder');
  fs.mkdirSync(holder);
  fs.symlinkSync(target, path.join(holder, 'link'), 'junction');
  assert.match((await claude.deleteForDesk(ctx, 'holder', 'old')).text, /holds a link \(link\)/);
  assert.match((await claude.deleteForDesk(ctx, path.join('holder', 'link'), 'old')).text, /^Stay inside/, 'it points outside: refused like a write');
  assert.equal(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8'), 'keep me');
  fs.rmSync(path.join(holder, 'link'));
  fs.rmSync(target, { recursive: true, force: true });
});

test('retries: a run that deleted anything, even only in its workspace, is not started over', () => {
  const base = { autoAllowed: [], comments: 0, commented: false, sends: 0, sentToThread: false, awaiting: [], raised: false, finished: false, changed: new Set<string>(), pendingWrites: new Map(), scripts: 0 };
  assert.equal(claude.retryBlocked({ ...base, deletes: 0 }), null);
  assert.match(String(claude.retryBlocked({ ...base, deletes: 1 })), /it already deleted files/);
});

test('read-only project: the project folder is refused, the workspace still works', async () => {
  const { ctx } = setup('read');
  assert.match((await claude.deleteForDesk(ctx, path.join(repo, 'src', 'old.ts'), 'unused')).text, /^Stay inside your workspace .*the project folder is read-only/);
  assert.equal((await claude.deleteForDesk(ctx, 'scratch.md', 'old')).ok, true);
});

test('limits: at most 50 per run; a folder too big goes in parts', async () => {
  const { ctx } = setup();
  ctx.deletes = claude.MAX_DELETES_PER_RUN;
  assert.match((await claude.deleteForDesk(ctx, 'scratch.md', 'old')).text, /You already deleted 50 things this run/);
  ctx.deletes = 0;
  const big = path.join(repo, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
  assert.match((await claude.deleteForDesk(ctx, big, 'generated')).text, /holds more than 2000 files/);
});

test('trash: nothing is overwritten there, and a deleted project file says so in the QA prompt', () => {
  const { item } = setup();
  const dest = path.join(trashRoot(p.id), 'x', 'a.txt');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'kept');
  assert.throws(() => moveToTrash(path.join(dir, 'scratch.md'), dest), /already has that path/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'kept');
  item.changedFiles = ['src/old.ts', 'src/gone.ts'];
  item.status = 'qa';
  const prompt = claude.qaPrompt({ project: p, item });
  assert.match(prompt, /src[\\/]old\.ts\n/);
  assert.match(prompt, /src[\\/]gone\.ts \(deleted\)/);
});

test('prompt: ticket runs and chat replies are told how to delete; nothing else is', () => {
  setup();
  const system = claude.systemPromptFor(p, leo, dir, [], 'ticket', false);
  assert.match(system, /use delete_file: it moves it to HQ's trash\. There is no other way to delete\./);
  for (const mode of ['qa', 'huddle', 'plan'] as const) assert.doesNotMatch(claude.systemPromptFor(p, leo, dir, [], mode, false), /delete_file/, mode);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}
p.flush();
process.chdir(os.tmpdir());
for (const d of [root, outside]) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (e) {
    console.warn(`could not remove ${d}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
assert.equal(failed, 0, `${failed} delete case(s) failed`);
console.log(`\nall ${passed} delete cases pass`);
