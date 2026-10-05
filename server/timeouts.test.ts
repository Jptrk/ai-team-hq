/**
 * When a desk run is stopped, and the words it is stopped with: the idle watch, the cap, usage limits, MCP tool timeouts.
 *   npm run test:timeouts
 */
import assert from 'node:assert/strict';
import { runEnv } from './runner/claude';
import { duration, explainFailure, limitsFromEnv, limitsWarning, mcpToolTimeoutFromEnv, nextUsage, RunWatch, stopText, usageLimitOf, type UsageLimit } from './runner/watch';

const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Wide enough apart that Windows' coarse timer tick (about 16 ms) can't flip a case.
const LIMITS = { idleMs: 100, toolIdleMs: 300, capMs: 3000 };

/** A watch whose stop only records that it fired. */
function watching(limits = LIMITS, capMs = limits.capMs) {
  const fired: string[] = [];
  const watch = new RunWatch(limits, capMs, () => fired.push('stop'));
  return { watch, fired };
}

const rejected = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...info } });

test('idle: nothing from Claude for the idle window stops the run, saying why', async () => {
  const { watch, fired } = watching();
  await sleep(170);
  assert.deepEqual(fired, ['stop']);
  assert.equal(watch.why, stopText.idle(LIMITS.idleMs));
  watch.clear();
});

test('idle: every message starts the clock again, so a busy run is never stopped for taking long', async () => {
  const { watch, fired } = watching();
  for (let i = 0; i < 10; i++) {
    await sleep(25);
    watch.touch();
  }
  assert.deepEqual(fired, [], 'touched every 25 ms for 250 ms: still running');
  await sleep(170);
  assert.deepEqual(fired, ['stop'], 'then quiet: stopped');
  watch.clear();
});

test('tool: while a tool call waits for its result, the longer window applies; once answered, the short one again', async () => {
  const { watch, fired } = watching();
  watch.touch(['tool_1']);
  assert.equal(watch.waiting, 1);
  await sleep(180);
  assert.deepEqual(fired, [], 'past the idle window but a tool call is out');
  watch.touch([], ['tool_1']);
  assert.equal(watch.waiting, 0);
  await sleep(170);
  assert.deepEqual(fired, ['stop']);
  assert.equal(watch.why, stopText.idle(LIMITS.idleMs));
  watch.clear();
});

test('tool: a tool call that never answers is stopped after the tool window, saying so', async () => {
  const { watch, fired } = watching();
  watch.touch(['tool_1']);
  await sleep(400);
  assert.deepEqual(fired, ['stop']);
  assert.equal(watch.why, stopText.tool(LIMITS.toolIdleMs));
  watch.clear();
});

test('cap: the whole run stops at the cap however busy, and a retry gets only what is left', async () => {
  const { watch, fired } = watching({ ...LIMITS, capMs: 150 });
  for (let i = 0; i < 10; i++) {
    await sleep(25);
    watch.touch();
  }
  assert.deepEqual(fired, ['stop']);
  assert.equal(watch.why, stopText.cap(150));
  watch.clear();
  const left = watching(LIMITS, 30);
  await sleep(70);
  assert.deepEqual(left.fired, ['stop'], 'what was left of the cap, not a new full cap');
  assert.equal(left.watch.why, stopText.cap(LIMITS.capMs), 'stopped by the cap, not for going quiet');
  left.watch.clear();
});

test('clear: a finished attempt stops its clocks, and it fires at most once', async () => {
  const { watch, fired } = watching();
  watch.clear();
  await sleep(170);
  assert.deepEqual(fired, []);
  const again = watching({ ...LIMITS, capMs: 70 });
  await sleep(200);
  assert.equal(again.fired.length, 1, 'cap and idle both due: one stop');
  again.watch.touch();
  await sleep(150);
  assert.equal(again.fired.length, 1, 'a message after the stop does not start it again');
  again.watch.clear();
});

test('words: no stop text or limit text looks like a failure the runner retries in a fresh session', () => {
  // The retry checks in claudeRunner.run: out of budget, too large, stale session.
  const retries = [/maximum budget/i, /too large|too long|413|request_too_large|exceeds|image/i, /session/i];
  const texts = [
    stopText.idle(8 * 60_000),
    stopText.tool(20 * 60_000),
    stopText.cap(40 * 60_000),
    stopText.you,
    ...['five_hour', 'seven_day', 'seven_day_opus', 'overage', undefined].map((rateLimitType) => usageLimitOf(rejected({ rateLimitType, resetsAt: Date.now() / 1000 + 3600 }))!.text),
    ...['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error'].map((error) => usageLimitOf({ type: 'assistant', error })!.text),
  ];
  for (const t of texts) for (const r of retries) assert.equal(r.test(t), false, `${t} matches ${r}`);
  assert.equal(stopText.idle(8 * 60_000), 'Stopped: no progress for 8 minutes (HQ_RUN_IDLE_MS)');
  assert.equal(stopText.cap(40 * 60_000), 'Stopped after 40 minutes, the most one run may take (HQ_RUN_TIMEOUT_MS)');
});

test('usage: a rejected rate limit says which limit and when it resets (24-hour clock), in seconds or milliseconds', () => {
  const now = Date.parse('2026-10-06T06:00:00Z');
  const resets = Date.parse('2026-10-06T07:00:00Z');
  for (const resetsAt of [resets / 1000, resets]) {
    const got = usageLimitOf(rejected({ resetsAt, rateLimitType: 'five_hour' }), now)!;
    assert.equal(got.kind, 'usage');
    assert.equal(got.until, '2026-10-06T07:00:00.000Z');
    assert.match(got.text, /^Claude's 5-hour limit reached\. It resets at \d{2}:\d{2}\.$/);
  }
  const past = usageLimitOf(rejected({ resetsAt: now / 1000 - 60 }), now)!;
  assert.equal(past.until, undefined, 'a reset time in the past is no reset time');
  assert.equal(past.text, "Claude's usage limit reached.");
  for (const status of ['allowed', 'allowed_warning']) assert.equal(usageLimitOf({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: resets } }), null, status);
});

test('usage: a rejection that extra usage covers is no limit: Claude carries on', () => {
  assert.equal(usageLimitOf(rejected({ rateLimitType: 'five_hour', isUsingOverage: true })), null);
  assert.equal(usageLimitOf(rejected({ rateLimitType: 'five_hour', overageStatus: 'allowed' })), null);
  assert.equal(usageLimitOf(rejected({ rateLimitType: 'five_hour', overageStatus: 'allowed_warning' })), null);
  assert.equal(usageLimitOf(rejected({ rateLimitType: 'overage', overageStatus: 'rejected', isUsingOverage: false }))?.kind, 'usage', 'extra usage ran out too');
});

test('usage: account errors are an account problem; a bare rate_limit is throttling, not a limit', () => {
  assert.equal(usageLimitOf({ type: 'assistant', error: 'billing_error' })?.kind, 'account');
  assert.equal(usageLimitOf({ type: 'assistant', error: 'authentication_failed' })?.kind, 'account');
  for (const error of ['rate_limit', 'overloaded', 'server_error', 'max_output_tokens', 'unknown']) assert.equal(usageLimitOf({ type: 'assistant', error }), null, error);
  for (const junk of [null, undefined, 'rate_limit', 42, { type: 'user', error: 'billing_error' }, { type: 'rate_limit_event' }]) assert.equal(usageLimitOf(junk), null);
});

test('usage: the precise limit survives the generic error after it; a later allowed event clears it', () => {
  const now = Date.parse('2026-10-06T06:00:00Z');
  // The CLI's order on a 429: the quota event first, then an assistant message with error rate_limit.
  let u: UsageLimit | undefined;
  for (const msg of [{ type: 'assistant' }, rejected({ rateLimitType: 'five_hour', resetsAt: now / 1000 + 3600 }), { type: 'assistant', error: 'rate_limit' }, { type: 'user' }]) u = nextUsage(u, msg, now);
  assert.equal(u?.until, '2026-10-06T07:00:00.000Z');
  u = nextUsage(u, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, now);
  assert.equal(u, undefined, 'allowed again');
  u = nextUsage(undefined, { type: 'assistant', error: 'rate_limit' }, now);
  assert.equal(u, undefined, 'throttling alone explains nothing');
  u = nextUsage(undefined, { type: 'assistant', error: 'account_on_hold' }, now);
  assert.equal(u?.kind, 'account');
});

test('failure: the watch, your Stop, Claude’s limit, or the SDK’s own words when the budget or turns ran out', () => {
  const usage: UsageLimit = { kind: 'usage', text: "Claude's 5-hour limit reached.", until: '2026-10-06T07:00:00.000Z' };
  assert.deepEqual(explainFailure('Operation aborted', { watch: stopText.idle(480_000), stopped: false, usage }), { text: stopText.idle(480_000) });
  assert.deepEqual(explainFailure('Operation aborted', { watch: null, stopped: true, usage }), { text: 'Stopped by you' });
  assert.deepEqual(explainFailure('Claude Code returned an error result: API Error: 429', { watch: null, stopped: false, usage }), { text: usage.text, usage });
  for (const own of ['Claude Code returned an error result: Reached maximum budget ($3)', 'error_max_turns: Reached maximum number of turns (40)', 'error_max_budget_usd']) {
    assert.deepEqual(explainFailure(own, { watch: null, stopped: false, usage }), { text: own }, own);
  }
  assert.deepEqual(explainFailure('Prompt is too long', { watch: null, stopped: false }), { text: 'Prompt is too long' });
});

test('env: limits come from HQ_RUN_IDLE_MS, HQ_TOOL_IDLE_MS and HQ_RUN_TIMEOUT_MS; junk keeps the defaults', () => {
  assert.deepEqual(limitsFromEnv({}), { idleMs: 8 * 60_000, toolIdleMs: 20 * 60_000, capMs: 40 * 60_000 });
  assert.deepEqual(limitsFromEnv({ HQ_RUN_IDLE_MS: '300000', HQ_TOOL_IDLE_MS: '600000.4', HQ_RUN_TIMEOUT_MS: '3600000' }), { idleMs: 300_000, toolIdleMs: 600_000, capMs: 3_600_000 });
  assert.deepEqual(limitsFromEnv({ HQ_RUN_IDLE_MS: 'soon', HQ_TOOL_IDLE_MS: '-5', HQ_RUN_TIMEOUT_MS: '' }), { idleMs: 8 * 60_000, toolIdleMs: 20 * 60_000, capMs: 40 * 60_000 });
  assert.equal(duration(8 * 60_000), '8 minutes');
  assert.equal(duration(60_000), '1 minute');
  assert.equal(duration(45_000), '45 seconds');
  assert.equal(duration(1000), '1 second');
});

test('env: an old 10-minute HQ_RUN_TIMEOUT_MS, or a cap under the tool window, is warned about at startup', () => {
  assert.match(limitsWarning(limitsFromEnv({ HQ_RUN_TIMEOUT_MS: '600000' }))!, /^HQ_RUN_TIMEOUT_MS is 10 minutes: /);
  assert.match(limitsWarning(limitsFromEnv({ HQ_RUN_TIMEOUT_MS: '900000' }))!, /HQ_TOOL_IDLE_MS, 20 minutes/);
  assert.equal(limitsWarning(limitsFromEnv({ HQ_RUN_TIMEOUT_MS: '1800000' })), null, '30 minutes is fine');
  assert.equal(limitsWarning(limitsFromEnv({})), null);
});

test('env: MCP tool calls get a time limit, unless you set MCP_TOOL_TIMEOUT yourself', () => {
  assert.equal(runEnv(undefined, { PATH: 'x' }, 900_000).MCP_TOOL_TIMEOUT, '900000');
  assert.equal(runEnv(undefined, { PATH: 'x', MCP_TOOL_TIMEOUT: '120000' }, 900_000).MCP_TOOL_TIMEOUT, '120000');
  assert.equal(runEnv(undefined, { PATH: 'x' }, 0).MCP_TOOL_TIMEOUT, undefined, 'HQ_MCP_TOOL_TIMEOUT_MS=0 leaves it to Claude Code');
  assert.equal(mcpToolTimeoutFromEnv(undefined), 900_000);
  assert.equal(mcpToolTimeoutFromEnv(''), 900_000, 'empty is the default, not off');
  assert.equal(mcpToolTimeoutFromEnv('15m'), 900_000, 'junk is the default');
  assert.equal(mcpToolTimeoutFromEnv('0'), 0, 'an explicit 0 is off');
  assert.equal(mcpToolTimeoutFromEnv('120000.7'), 120_001, 'whole milliseconds, as Claude Code reads it');
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
assert.equal(failed, 0, `${failed} timeout case(s) failed`);
console.log(`\nall ${passed} timeout cases pass`);
