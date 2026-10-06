/**
 * HQ-wide settings: the effort level for every desk run.
 * Runs in a scratch folder: data/settings.json is written there, never in your real data/.
 *   npm run test:settings
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Meta } from '../shared/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-settings-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';

const { parseSettings, settings, setEffort } = await import('./settings');
const { router, readSettingsPatch } = await import('./routes');
const { meta } = await import('./runner/index');
const { EFFORT_LEVELS, isEffortLevel } = await import('../shared/types');

const FILE = path.join(root, 'data', 'settings.json');
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

/** Call the API in-process, as the server does once it has parsed the JSON body. */
function api(method: string, url: string, body: unknown, type = 'application/json'): Promise<{ status: number; body: unknown }> {
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
    const headers: Record<string, string> = { 'content-type': type };
    const req = { method, url, body, headers, query: {}, get: (h: string) => headers[h.toLowerCase()] };
    const handle = router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    handle(req, res, (err) => reject(err ?? new Error(`no route for ${method} ${url}`)));
  });
}

test('levels: the five the Agent SDK takes, and nothing else', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const bad of ['', 'High', 'adaptive', 'none', null, undefined, 3, ['low']]) assert.equal(isEffortLevel(bad), false, String(bad));
});

test('file: none yet means the model default, and nothing is written by reading', () => {
  assert.deepEqual(settings(), {});
  assert.equal(meta().effort, null);
  assert.equal(fs.existsSync(FILE), false);
});

test('file: a hand-edited file keeps only a valid effort', () => {
  assert.deepEqual(parseSettings({ effort: 'medium' }), { effort: 'medium' });
  assert.deepEqual(parseSettings({ effort: 'turbo', extra: 1 }), {});
  assert.deepEqual(parseSettings({ effort: 'HIGH' }), {});
  for (const raw of [null, 'high', 42, []]) assert.deepEqual(parseSettings(raw), {});
});

test('file: Pause and a usage hold survive a hand edit only when well formed', () => {
  const at = '2026-10-06T08:00:00.000Z';
  assert.deepEqual(parseSettings({ paused: { at } }), { paused: { at } });
  assert.deepEqual(parseSettings({ paused: true }), {}, 'paused needs a time');
  assert.deepEqual(parseSettings({ paused: { at: 'soon' } }), {});
  const hold = { kind: 'usage', at, text: "Claude's 5-hour limit reached.", until: '2026-10-06T09:00:00.000Z' };
  assert.deepEqual(parseSettings({ usageHold: hold }), { usageHold: hold });
  assert.deepEqual(parseSettings({ usageHold: { ...hold, until: 'later' } }), { usageHold: { kind: 'usage', at, text: hold.text } }, 'a bad reset time is dropped, the hold kept');
  for (const bad of [{ ...hold, kind: 'quota' }, { ...hold, text: 3 }, { ...hold, at: undefined }, 'usage']) assert.deepEqual(parseSettings({ usageHold: bad }), {}, JSON.stringify(bad));
});

test('file: the Claude login yes survives a hand edit only with a time', () => {
  const at = '2026-10-06T08:00:00.000Z';
  assert.deepEqual(parseSettings({ claudeLogin: { at } }), { claudeLogin: { at } });
  assert.deepEqual(parseSettings({ claudeLogin: { at, token: 'x' } }), { claudeLogin: { at } }, 'nothing else is kept');
  for (const bad of [true, 'yes', { at: 'soon' }, {}, null]) assert.deepEqual(parseSettings({ claudeLogin: bad }), {}, JSON.stringify(bad));
});

test('save: a level is written, read back and shown in meta; null goes back to the default', () => {
  setEffort('low');
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), { effort: 'low' });
  assert.equal(settings().effort, 'low');
  assert.equal(meta().effort, 'low');
  setEffort(null);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), {});
  assert.equal(meta().effort, null);
  assert.equal(fs.existsSync(`${FILE}.tmp`), false, 'no temp file left behind');
});

test('body: effort must be a level or null', () => {
  assert.deepEqual(readSettingsPatch({ effort: 'xhigh' }), { effort: 'xhigh' });
  assert.deepEqual(readSettingsPatch({ effort: null }), { effort: null });
  assert.match(String(readSettingsPatch({}).error), /Nothing to change/);
  for (const bad of ['', 'turbo', 'High', 1, true, undefined]) assert.match(String(readSettingsPatch({ effort: bad }).error), /effort must be low, medium, high, xhigh or max, or null/, String(bad));
});

test('route: PATCH /settings saves and answers with the new meta; a bad value changes nothing', async () => {
  const ok = await api('PATCH', '/settings', { effort: 'medium' });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as Meta).effort, 'medium');
  assert.equal(settings().effort, 'medium');

  const bad = await api('PATCH', '/settings', { effort: 'turbo' });
  assert.equal(bad.status, 400);
  assert.equal(settings().effort, 'medium');

  for (const body of [[], 'medium', null]) assert.equal((await api('PATCH', '/settings', body)).status, 400, JSON.stringify(body));

  const notJson = await api('PATCH', '/settings', { effort: 'low' }, 'text/plain');
  assert.equal(notJson.status, 415, 'only JSON bodies');
  assert.equal(settings().effort, 'medium');

  const back = await api('PATCH', '/settings', { effort: null });
  assert.equal(back.status, 200);
  assert.equal((back.body as Meta).effort, null);

  const got = await api('GET', '/meta', undefined);
  assert.equal((got.body as Meta).effort, null);
});

let passed = 0;
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
process.chdir(os.tmpdir());
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
} catch (e) {
  console.warn(`could not remove ${root}: ${e instanceof Error ? e.message : String(e)}`);
}
assert.equal(failed, 0, `${failed} settings case(s) failed`);
console.log(`\nall ${passed} settings cases pass`);
