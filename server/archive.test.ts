/**
 * Removing a project: archived to data/archive or deleted for good, the Removed projects list, and deleting from it.
 * The linked folder is never touched, and links inside a workspace are removed, never followed. A folder another
 * program holds open is only tried on Windows, where it can't be moved or deleted.
 * Run: npm run test:archive. Works in a throwaway folder under the OS temp dir; makes no Claude calls.
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Huddle, RemovedProject, WorkItem } from '../shared/types';

// The store reads data/ and workspaces/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-archive-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';
// The project folder sits outside HQ, as a real one does.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-archive-repo-'));
const repo = path.join(outside, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export {}');

const store = await import('./store');
const { trashRoot } = await import('./trash');
const { router } = await import('./routes');
const { locked } = await import('./connections');
const auth = await import('./mcpAuth');

store.initStore({ emptySeed: true });

let passed = 0;
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

const archiveDir = path.join(root, 'data', 'archive');
const wsOf = (id: string) => path.join(root, 'workspaces', id);
const dataOf = (id: string) => path.join(root, 'data', 'projects', id);

/** A project with something in every place it keeps files: board, attachments, trash, and a desk's workspace. */
function project(name: string, key: string) {
  const p = store.createProject({ name, key, path: repo, access: 'write', template: 'dev' });
  const desk = path.join(wsOf(p.id), 'leo');
  fs.mkdirSync(path.join(desk, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(desk, 'ROLE.md'), 'Frontend.');
  fs.writeFileSync(path.join(desk, 'memory.md'), '# Memory');
  fs.writeFileSync(path.join(desk, 'reports', 'plan.md'), '# Plan');
  fs.mkdirSync(path.join(dataOf(p.id), 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(dataOf(p.id), 'attachments', 'a.png'), 'png');
  const trashed = path.join(trashRoot(p.id), '2026-10-07T09-15-02-417Z-leo', 'project', 'src', 'old.ts');
  fs.mkdirSync(path.dirname(trashed), { recursive: true });
  fs.writeFileSync(trashed, 'old');
  return p;
}

/** Call the API in-process, as the server does once it has parsed the JSON body. */
function call(method: string, url: string, query: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      locals: {},
      status(code: number) {
        status = code;
        return res;
      },
      json(out: unknown) {
        resolve({ status, body: out });
        return res;
      },
    };
    const handle = router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    const qs = new URLSearchParams(query).toString();
    handle({ method, url: qs ? `${url}?${qs}` : url, body: {}, headers: {}, query }, res, (err) => reject(err ?? new Error(`no route for ${method} ${url}`)));
  });
}

const removed = async () => (await call('GET', '/archive')).body as RemovedProject[];
const repoIntact = () => {
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8'), 'export {}', 'the linked folder is untouched');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (out: { body: unknown }) => (out.body as { error: string }).error;

/** Another program working in `dir`, as a terminal or editor would: Windows won't move or delete it until it stops. */
async function holdOpen(dir: string): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { cwd: dir, stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  return async () => {
    child.kill();
    await exited;
  };
}

const marker = (): WorkItem => ({
  id: 'itm_marker',
  kind: 'fyi',
  title: 'Still here',
  summary: '',
  status: 'todo',
  from: 'you',
  assignee: 'leo',
  dated: store.today(),
  links: [],
  history: [],
});

const heldOnly = (name: string) => {
  if (process.platform === 'win32') return false;
  console.log(`skip ${name}: only Windows refuses to move or delete a folder another program has open`);
  return true;
};

test('archive: board, attachments, trash and workspaces move to data/archive and show under Removed projects', async () => {
  const p = project('Shop app', 'SA');
  const out = await call('DELETE', `/projects/${p.id}`);
  assert.equal(out.status, 200);
  assert.equal(store.getProject(p.id), null);
  assert.equal(fs.existsSync(dataOf(p.id)), false);
  assert.equal(fs.existsSync(wsOf(p.id)), false);
  const folder = path.basename((out.body as { archivedTo: string }).archivedTo);
  const kept = path.join(archiveDir, folder);
  for (const f of ['project.json', 'data/db.json', 'data/attachments/a.png', 'workspaces/leo/reports/plan.md']) assert.ok(fs.existsSync(path.join(kept, f)), f);
  assert.ok(fs.readdirSync(path.join(kept, 'data', 'trash')).length === 1);
  repoIntact();

  const row = (await removed()).find((r) => r.folder === folder)!;
  assert.equal(row.name, 'Shop app');
  assert.equal(row.key, 'SA');
  assert.match(row.color ?? '', /^#[0-9a-f]{6}$/);
  assert.ok(Math.abs(Date.parse(row.removedAt) - Date.now()) < 60_000, 'removed just now, read from the folder name');
  assert.ok(row.bytes > 0);
});

test('delete for good: nothing of the project is left in HQ, and nothing in data/archive', async () => {
  const p = project('Blog', 'BL');
  const before = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
  const out = await call('DELETE', `/projects/${p.id}`, { forGood: '1' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, deleted: true, left: [] });
  assert.equal(store.getProject(p.id), null);
  assert.ok(!store.listMeta().some((m) => m.id === p.id));
  assert.equal(fs.existsSync(dataOf(p.id)), false);
  assert.equal(fs.existsSync(wsOf(p.id)), false);
  assert.deepEqual(fs.readdirSync(archiveDir), before);
  repoIntact();
});

test('delete for good: a link in a workspace goes, the folder it points to stays', async () => {
  const p = project('Docs', 'DO');
  // A junction needs no admin rights on Windows; elsewhere it is a plain directory link.
  fs.symlinkSync(repo, path.join(wsOf(p.id), 'leo', 'repo-link'), 'junction');
  const out = await call('DELETE', `/projects/${p.id}`, { forGood: '1' });
  assert.deepEqual((out.body as { left: string[] }).left, []);
  assert.equal(fs.existsSync(wsOf(p.id)), false);
  repoIntact();
});

test('Removed projects: sizes count a link as itself, never what it points to', async () => {
  const p = project('Linked', 'LI');
  fs.writeFileSync(path.join(repo, 'big.bin'), Buffer.alloc(1024 * 1024));
  fs.symlinkSync(repo, path.join(wsOf(p.id), 'leo', 'repo-link'), 'junction');
  const folder = path.basename(((await call('DELETE', `/projects/${p.id}`)).body as { archivedTo: string }).archivedTo);
  const row = (await removed()).find((r) => r.folder === folder)!;
  assert.ok(row.bytes < 512 * 1024, `${row.bytes} bytes`);
  fs.rmSync(path.join(repo, 'big.bin'));
  // Deleting it from the list takes the link, not the linked folder.
  assert.equal((await call('DELETE', `/archive/${encodeURIComponent(folder)}`)).status, 200);
  assert.equal(fs.existsSync(path.join(archiveDir, folder)), false);
  repoIntact();
});

test('Removed projects: newest first; a folder without project.json shows by its id', async () => {
  fs.mkdirSync(path.join(archiveDir, 'old-thing-2026-01-02T03-04-05-678Z', 'data'), { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'old-thing-2026-01-02T03-04-05-678Z', 'data', 'db.json'), '{}');
  const list = await removed();
  const old = list.find((r) => r.folder === 'old-thing-2026-01-02T03-04-05-678Z')!;
  assert.deepEqual({ name: old.name, key: old.key, color: old.color, removedAt: old.removedAt, bytes: old.bytes }, {
    name: 'old-thing',
    key: null,
    color: null,
    removedAt: '2026-01-02T03:04:05.678Z',
    bytes: 2,
  });
  assert.equal(list.at(-1)!.folder, old.folder);
  assert.deepEqual(
    list.map((r) => r.removedAt),
    [...list.map((r) => r.removedAt)].sort().reverse(),
  );
});

test('delete from Removed projects: only a folder in data/archive by its exact name', async () => {
  const name = 'old-thing-2026-01-02T03-04-05-678Z';
  // HQ's own folders and paths that climb out are never a removed project.
  for (const bad of ['..', '.', 'projects', '../projects', `${name}/..`, `${name}/data`, path.join(root, 'data'), 'nope']) {
    assert.equal(await store.deleteRemoved(bad), 'not-found', bad);
  }
  assert.ok(fs.existsSync(path.join(root, 'data', 'projects')));
  assert.equal((await call('DELETE', `/archive/${encodeURIComponent('..')}`)).status, 404);
  assert.equal((await call('DELETE', '/archive/nope')).status, 404);
  assert.equal((await call('DELETE', `/archive/${name}`)).status, 200);
  assert.equal(fs.existsSync(path.join(archiveDir, name)), false);
  assert.ok(!(await removed()).some((r) => r.folder === name));
  assert.equal(await store.deleteRemoved(name), 'not-found', 'already gone');
});

test('archive: refused while another program has a file open; nothing moves and the board stays', async () => {
  if (heldOnly('archive of a held folder')) return;
  const p = project('Held', 'HE');
  p.state.items.push(marker());
  p.commit();
  const before = fs.readdirSync(archiveDir);
  const stop = await holdOpen(path.join(wsOf(p.id), 'leo'));
  try {
    const out = await call('DELETE', `/projects/${p.id}`);
    assert.equal(out.status, 409);
    assert.match(errorOf(out), /Another program has a file of this project open/);
    assert.ok(store.listMeta().some((m) => m.id === p.id), 'still registered');
    assert.equal(store.getProject(p.id), p, 'the same project, not an empty new team');
    assert.ok(p.state.items.some((i) => i.id === 'itm_marker'));
    assert.ok(fs.existsSync(path.join(wsOf(p.id), 'leo', 'reports', 'plan.md')), 'workspaces back in place');
    assert.ok(fs.existsSync(path.join(dataOf(p.id), 'attachments', 'a.png')), 'data back in place');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataOf(p.id), 'db.json'), 'utf8')) as { items: WorkItem[] };
    assert.ok(onDisk.items.some((i) => i.id === 'itm_marker'), 'saved before the move');
    assert.deepEqual(fs.readdirSync(archiveDir), before, 'nothing new in data/archive');
    // It still works, and saves where it is.
    p.log('you', 'after the refused archive');
    p.flush();
    assert.ok(fs.readFileSync(path.join(dataOf(p.id), 'db.json'), 'utf8').includes('after the refused archive'));
  } finally {
    await stop();
  }
  // Once the other program lets go, archiving works.
  assert.equal((await call('DELETE', `/projects/${p.id}`)).status, 200);
  assert.equal(fs.existsSync(wsOf(p.id)), false);
});

test('delete for good: a folder another program holds stays, is named, and is never taken over', async () => {
  if (heldOnly('delete of a held folder')) return;
  const p = project('Pinned', 'PI');
  const stop = await holdOpen(path.join(wsOf(p.id), 'leo'));
  try {
    const before = fs.readdirSync(archiveDir);
    const out = await call('DELETE', `/projects/${p.id}`, { forGood: '1' });
    assert.equal(out.status, 200);
    assert.deepEqual((out.body as { left: string[] }).left, [`workspaces/${p.id}`]);
    assert.ok(!store.listMeta().some((m) => m.id === p.id));
    assert.equal(store.getProject(p.id), null);
    assert.equal(fs.existsSync(dataOf(p.id)), false);
    assert.ok(fs.existsSync(wsOf(p.id)), 'the held folder stays');
    assert.deepEqual(fs.readdirSync(archiveDir), before, 'deleted where it was, never archived first');
    const again = store.createProject({ name: 'Pinned', key: 'PJ', path: repo, access: 'write', template: 'dev' });
    assert.notEqual(again.id, p.id, 'a new project by the same name gets its own folders');
  } finally {
    await stop();
  }
});

test('a removed project never writes again, also into a new project that took its id', async () => {
  // Deleted for good with a save still waiting.
  const p = project('Ghost', 'GH');
  p.log('you', 'waiting to save');
  assert.equal((await call('DELETE', `/projects/${p.id}`, { forGood: '1' })).status, 200);
  p.log('leo', 'a check that ended late');
  p.commit();
  p.flush();
  p.save();
  await sleep(300);
  assert.equal(fs.existsSync(dataOf(p.id)), false);
  assert.throws(() => p.meta, /no longer exists/);

  // A new project takes the id (nothing was left); the old object still writes nothing, and isn't the new one.
  const again = store.createProject({ name: 'Ghost', key: 'GI', path: repo, access: 'write', template: 'dev' });
  assert.equal(again.id, p.id);
  const file = path.join(dataOf(p.id), 'db.json');
  const saved = fs.readFileSync(file, 'utf8');
  p.state.items.push(marker());
  p.log('leo', 'a sign-in that ended late');
  p.flush();
  p.save();
  await sleep(300);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.throws(() => p.meta, /no longer exists/);
  assert.equal(store.getProject(p.id), again);

  // Archived: the same.
  const q = project('Shade', 'SH');
  const folder = ((await call('DELETE', `/projects/${q.id}`)).body as { archivedTo: string }).archivedTo;
  const archived = fs.readFileSync(path.join(folder, 'data', 'db.json'), 'utf8');
  q.log('leo', 'a huddle that ended late');
  q.flush();
  await sleep(300);
  assert.equal(fs.existsSync(dataOf(q.id)), false);
  assert.equal(fs.readFileSync(path.join(folder, 'data', 'db.json'), 'utf8'), archived);
});

test('remove waits while a connection check or a sign-in runs', async () => {
  const p = project('Wired', 'WI');
  let release!: () => void;
  const checking = locked(p, 'check', () => new Promise<void>((r) => (release = r)));
  for (const query of [{}, { forGood: '1' }] as Record<string, string>[]) {
    const out = await call('DELETE', `/projects/${p.id}`, query);
    assert.equal(out.status, 409);
    assert.match(errorOf(out), /connection check or sign-in is running/);
  }
  release();
  await checking;

  // A sign-in that waits for its server, as one does for your browser.
  const never = () => new Promise<never>(() => undefined);
  const q = { mcpServerStatus: never, mcpAuthenticate: never } as unknown as Query;
  auth.setLoginTestHooks({ open: () => ({ q, close: async () => undefined }), firstStatusMs: 5000, loginMs: 5000 });
  try {
    auth.startLogin(p, 'fake-login', { type: 'http', url: 'https://mcp.example.com/mcp' }, { onConnected: () => undefined });
    const out = await call('DELETE', `/projects/${p.id}`, { forGood: '1' });
    assert.equal(out.status, 409);
    assert.match(errorOf(out), /connection check or sign-in is running/);
    assert.ok(auth.cancelLogin(p.id, 'fake-login'));
  } finally {
    auth.setLoginTestHooks();
  }
  assert.ok(fs.existsSync(dataOf(p.id)) && fs.existsSync(wsOf(p.id)));
  // With nothing running, it goes.
  assert.equal((await call('DELETE', `/projects/${p.id}`, { forGood: '1' })).status, 200);
});

test('remove is refused while a desk runs, a huddle goes on, or it is the only project', async () => {
  const p = project('Busy', 'BU');
  const other = project('Other', 'OT');
  const desk = p.state.agents.find((a) => !a.isHuman)!;
  desk.running = true;
  for (const query of [{}, { forGood: '1' }] as Record<string, string>[]) {
    const out = await call('DELETE', `/projects/${p.id}`, query);
    assert.equal(out.status, 409);
    assert.match((out.body as { error: string }).error, /still working/);
  }
  desk.running = false;
  p.state.huddles.push({ id: 'hud_x', status: 'running' } as Huddle);
  const huddling = await call('DELETE', `/projects/${p.id}`, { forGood: '1' });
  assert.equal(huddling.status, 409);
  assert.match((huddling.body as { error: string }).error, /huddle is still going/);
  p.state.huddles = [];
  assert.ok(fs.existsSync(dataOf(p.id)) && fs.existsSync(wsOf(p.id)));

  for (const m of store.listMeta().filter((m) => m.id !== p.id && m.id !== other.id)) await store.deleteProject(m.id);
  assert.equal((await call('DELETE', `/projects/${other.id}`, { forGood: '1' })).status, 200);
  const only = await call('DELETE', `/projects/${p.id}`, { forGood: '1' });
  assert.equal(only.status, 409);
  assert.match((only.body as { error: string }).error, /only project/);
  assert.ok(store.getProject(p.id));
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
store.flushAll();
process.chdir(os.tmpdir());
for (const d of [root, outside]) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (e) {
    console.warn(`could not remove ${d}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
assert.equal(failed, 0, `${failed} archive case(s) failed`);
console.log(`\nall ${passed} archive cases pass`);
