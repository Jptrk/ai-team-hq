/**
 * Desks' shell: when a desk gets Bash, what HQ refuses before a command runs, and HQ's own Bash tool for GPT desks.
 * Run: npm run test:shell. Works in throwaway folders under the OS temp dir; makes no Claude or GPT calls. Where this
 * PC has bash (Git Bash on Windows), a few commands really run, in a scratch workspace.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// HQ reads data/ and workspaces/ from the working directory, so move into a scratch folder first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-shell-'));
process.chdir(root);
process.env.HQ_RUNNER = 'sim';
// The project folder sits outside HQ, as a real one does.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-shell-repo-'));
const repo = path.join(outside, 'repo');

const store = await import('./store');
const claude = await import('./runner/claude');
const codex = await import('./runner/codex');
const shell = await import('./runner/shell');
const { readProjectPatch } = await import('./routes');
const { HQ_ROOT } = await import('./paths');
type GuardContext = import('./runner/claude').GuardContext;
type RunMode = import('./runner/claude').RunMode;

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Shop app', key: 'SA', path: null, access: 'write', template: 'dev' });
const leo = p.state.agents.find((a) => a.id === 'leo')!;
const dir = claude.ensureWorkspace(p, leo);
fs.mkdirSync(path.join(repo, 'src', 'legacy'), { recursive: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
fs.writeFileSync(path.join(repo, 'config', '.env'), 'SECRET=1');
fs.writeFileSync(path.join(repo, 'server.key'), 'key');
fs.mkdirSync(path.join(repo, 'certs'), { recursive: true });
fs.writeFileSync(path.join(repo, 'certs', 'dev.pem'), 'key');
fs.mkdirSync(path.join(repo, 'vendor', 'lib', '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, 'node_modules', 'pkg', 'test'), { recursive: true });
fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'test', 'fixture.pem'), 'not a secret');
fs.writeFileSync(path.join(dir, 'reports', 'old.md'), 'old');

/** The project as a case needs it: folder access and the shell switch. */
function setProject(access: 'read' | 'write' = 'write', on = true) {
  store.updateProject(p.id, { path: repo, access, shell: on });
}

async function decide(command: string, opts: { access?: 'read' | 'write'; mode?: RunMode; on?: boolean; input?: Record<string, unknown> } = {}) {
  setProject(opts.access, opts.on);
  const ctx: GuardContext = { project: p, dir, mode: opts.mode ?? 'ticket' };
  return claude.guard(ctx)('Bash', { command, ...opts.input });
}

let passed = 0;
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);

const q = (p: string) => `'${p}'`;
const commands: [string, string, 'allow' | 'deny', ('read' | 'write')?][] = [
  ['a plain command', 'npm test', 'allow'],
  ['git that reads', 'git status && git diff --stat', 'allow'],
  ['a commit message that says push', 'git commit -m "push the fix later"', 'allow'],
  ['git push', 'git push', 'deny'],
  ['git push with options first', 'git -C app -c core.editor=true push origin main', 'deny'],
  ['git push inside bash -c', 'bash -c "git push --force"', 'deny'],
  ['git push after cd', `cd ${q(repo)} && git push`, 'deny'],
  ['a .env file', 'cat .env', 'deny'],
  ['a .env file in a flag', 'node --env-file=.env server.js', 'deny'],
  ['a .env file by full path', `cat ${q(path.join(repo, 'config', '.env.local'))}`, 'deny'],
  ['process.env is not a .env file', 'node -e "console.log(process.env.HOME)" && echo $NODE_ENV', 'allow'],
  ['delete in the workspace', 'rm -rf dist && rm scratch.md', 'allow'],
  ['delete node_modules in the workspace', 'rm -rf node_modules && npm ci', 'allow'],
  ['delete above the workspace', 'rm -rf ..', 'deny'],
  ['delete the root', 'rm -rf /', 'deny'],
  ['delete with ~', 'rm -rf ~/Documents', 'deny'],
  ['delete with a variable', 'rm -rf "$HOME"', 'deny'],
  ['delete with command output', 'rm -rf $(pwd)', 'deny'],
  ["delete the desk's ROLE.md", 'rm ROLE.md', 'deny'],
  ["delete the desk's reports", 'rm -rf reports', 'deny'],
  ['delete a report', 'rm reports/old.md', 'allow'],
  ['delete every report', 'rm -rf reports/*', 'allow'],
  ['delete everything in the workspace', 'rm -rf *', 'deny'],
  ['delete everything in the workspace, ./*', 'rm -rf ./*', 'deny'],
  ['delete by an extension', 'rm -f *.tmp', 'allow'],
  ['delete dot files by pattern', 'rm -rf .*', 'deny'],
  ['delete in the project, Read & write', `rm -rf ${q(path.join(repo, 'src', 'legacy'))}`, 'allow', 'write'],
  ['delete in the project, Read only', `rm -rf ${q(path.join(repo, 'src', 'legacy'))}`, 'deny', 'read'],
  ['delete in the project after cd', `cd ${q(repo)} && rm -rf src/legacy`, 'allow', 'write'],
  ['delete the project folder', `rm -rf ${q(repo)}`, 'deny', 'write'],
  ['delete .git', `rm -rf ${q(path.join(repo, '.git'))}`, 'deny', 'write'],
  ['delete inside .git', `rm -rf ${q(path.join(repo, '.git', 'hooks'))}`, 'deny', 'write'],
  ['delete a key', `rm ${q(path.join(repo, 'server.key'))}`, 'deny', 'write'],
  ['delete node_modules in the project', `rm -rf ${q(path.join(repo, 'node_modules'))}`, 'allow', 'write'],
  ['delete beside the project', `rm -rf ${q(path.join(outside, 'elsewhere'))}`, 'deny', 'write'],
  ['delete inside HQ', `rm -rf ${q(path.join(HQ_ROOT, 'data'))}`, 'deny', 'write'],
  ['delete a Git Bash drive path', 'rm -rf /c/Windows/Temp/hq-x', 'deny'],
  ['find deleting by name', 'find . -name "*.pyc" -delete', 'allow'],
  ['find deleting everything', 'find . -delete', 'deny'],
  ['find deleting in the project, .git included', `find ${q(repo)} -type f -delete`, 'deny', 'write'],
  ['find running rm by name', `find ${q(path.join(repo, 'src'))} -name '*.bak' -exec rm {} \\;`, 'allow', 'write'],
  ['xargs rm', 'ls | xargs rm -f', 'deny'],
  ['git clean', `cd ${q(repo)} && git clean -fd`, 'allow', 'write'],
  ['git clean of ignored files too', `cd ${q(repo)} && git clean -fdx`, 'deny', 'write'],
  ['git rm in the project', `git -C ${q(repo)} rm -r src/legacy`, 'allow', 'write'],
  ['git rm above the project', `git -C ${q(repo)} rm -rf ..`, 'deny', 'write'],
  ['PowerShell Remove-Item outside', `powershell -Command "Remove-Item -Recurse -Force ${q(outside)}"`, 'deny', 'write'],
  ['an encoded PowerShell command', 'powershell -enc SQBFAFgA', 'deny'],
  ['cmd rd outside', `cmd /c rd /s /q "${outside}"`, 'deny', 'write'],
  ['rm inside sh -c', "sh -c 'rm -rf ../..'", 'deny'],
  ['a redirect is not a delete', 'echo hi > out.txt 2>&1', 'allow'],
  // bash keywords come before the command they run.
  ['rm after if ... then', 'if [ -d ../x ]; then rm -rf ../x; fi', 'deny'],
  ['git push in braces', '{ git push; }', 'deny'],
  ['git push after if !', 'if ! git push; then echo x; fi', 'deny'],
  ['a loop that only reads', 'for f in a b; do echo $f; done', 'allow'],
  // A folder, or what a pattern reaches, holding .git, a .env file or a key.
  ['delete a folder holding a .env file', `rm -rf ${q(path.join(repo, 'config'))}`, 'deny', 'write'],
  ['delete a folder holding a key', `rm -rf ${q(path.join(repo, 'certs'))}`, 'deny', 'write'],
  ['delete a folder holding a nested .git', `rm -rf ${q(path.join(repo, 'vendor'))}`, 'deny', 'write'],
  ['delete keys by pattern', `cd ${q(repo)} && rm -f *.key`, 'deny', 'write'],
  ['a pattern reaching a .env file below', `cd ${q(repo)} && rm -rf con*`, 'deny', 'write'],
  // Windows forms.
  ['cmd //c, as Git Bash needs it', `cmd //c rd /s /q "${path.join(repo, '.git')}"`, 'deny', 'write'],
  ['powershell with options and no -Command', `powershell -NoProfile -ExecutionPolicy Bypass Remove-Item -Recurse -Force ${q(path.join(repo, '.git'))}`, 'deny', 'write'],
  ['powershell running a script file', 'powershell -NoProfile -File build.ps1', 'allow'],
  // The working folder HQ tracks.
  ['cd -- then a relative delete', 'cd -- /c/Users && rm -rf patri', 'deny'],
  ['popd then a relative delete', `pushd /c/Users && pushd ${q(dir)} && popd && rm -rf patri`, 'deny'],
  // Background commands outlive the run.
  ['a lone &', 'npm run dev &', 'deny'],
  ['nohup with &', 'nohup node server.js > log.txt 2>&1 &', 'deny'],
  ['&& and &> are not background', 'npm test &> out.txt && echo done', 'allow'],
  ['a quoted & is not background', 'git commit -m "fix a & b"', 'allow'],
  // More git push forms.
  ['a git subcommand from output', 'git $(echo push)', 'deny'],
  ['an env option before git push', 'env -u FOO git push', 'deny'],
  ['env -i before git status', 'env -i git status', 'allow'],
];

for (const [name, command, want, access] of commands) {
  test(`${want}: ${name}`, async () => {
    const d = await decide(command, { access });
    assert.equal(d.behavior, want, `${command} -> ${'message' in d ? d.message : 'allowed'}`);
  });
}

test('Bash needs the shell on, and never in a huddle or a plan; a QA check gets it, with the project read-only', async () => {
  const off = await decide('npm test', { on: false });
  assert.equal(off.behavior, 'deny');
  assert.match('message' in off ? off.message : '', /Project settings, under Shell/);
  for (const mode of ['huddle', 'plan'] as const) assert.equal((await decide('npm test', { mode })).behavior, 'deny', mode);
  assert.equal((await decide('npm test', { mode: 'qa' })).behavior, 'allow');
  assert.equal((await decide(`rm -rf ${q(path.join(repo, 'src', 'legacy'))}`, { mode: 'qa', access: 'write' })).behavior, 'deny', 'a QA check deletes nothing in the project');
  assert.equal((await decide('npm test', { input: { run_in_background: true } })).behavior, 'deny');
  assert.equal((await decide('   ')).behavior, 'deny');
});

test('each command counts once, the first 20 of a run go in the activity feed, and a run that ran one is not retried', async () => {
  setProject();
  p.state.activity = [];
  const ctx: GuardContext = { project: p, dir, mode: 'ticket', agent: leo };
  const check = claude.guard(ctx);
  for (let i = 1; i <= 22; i++) assert.equal((await check('Bash', { command: `echo ${i}` }, { toolUseID: `t${i}` })).behavior, 'allow');
  // The hook and canUseTool can both ask about the same call.
  await check('Bash', { command: 'echo 22' }, { toolUseID: 't22' });
  assert.equal((await check('Bash', { command: 'git push' }, { toolUseID: 'tp' })).behavior, 'deny');
  assert.equal(ctx.commands, 22);
  const lines = p.state.activity.map((a) => a.text);
  assert.equal(lines.filter((t) => t.startsWith('Ran a shell command: ')).length, 20);
  assert.ok(lines.includes('Ran a shell command: echo 1'));
  assert.equal(lines.filter((t) => t.startsWith('Ran more shell commands')).length, 1);
  const state = { autoAllowed: [], comments: 0, commented: false, sends: 0, sentToThread: false, awaiting: [], raised: false, finished: false, changed: new Set<string>(), pendingWrites: new Map(), commands: 1 };
  assert.match(claude.retryBlocked(state) ?? '', /ran a shell command/);
  assert.equal(claude.retryBlocked({ ...state, commands: 0 }), null);
});

test('the Bash hook: every Claude command goes through the guard before it runs', async () => {
  setProject();
  const hook = claude.bashHook(claude.guard({ project: p, dir, mode: 'ticket' }));
  const ask = (tool: string, command: string) =>
    hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'h1', session_id: 's', transcript_path: '', cwd: dir } as never, 'h1', {
      signal: new AbortController().signal,
    });
  const pushed = (await ask('Bash', 'git push')) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(pushed.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(pushed.hookSpecificOutput?.permissionDecisionReason ?? '', /refuses git push/);
  const ok = (await ask('Bash', 'npm test')) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(ok.hookSpecificOutput?.permissionDecision, 'allow');
  assert.deepEqual(await ask('Read', 'x'), {}, 'other tools are left to canUseTool');
});

test('tools and prompts: Bash only with the shell on, and desks are told what it does and what HQ refuses', () => {
  assert.ok(claude.builtinTools('ticket', true).includes('Bash'));
  assert.ok(!claude.builtinTools('ticket').includes('Bash'));
  assert.equal(shell.shellFor({ shell: true }, 'huddle'), false);
  assert.equal(shell.shellFor({ shell: true }, 'plan'), false);
  assert.equal(shell.shellFor({ shell: true }, 'qa'), true);
  assert.equal(shell.shellFor({}, 'ticket'), false);
  const hq = { instructions: 'HQ tools.', tools: [] } as unknown as import('./runner/claude').HqTools;
  assert.ok(codex.toolSpecs(['Read'], hq, true).some((t) => t.name === 'Bash'));
  assert.ok(!codex.toolSpecs(['Read'], hq).some((t) => t.name === 'Bash'));
  assert.match(codex.developerPrompt('', hq, ['Read'], { shell: true }), /Bash runs a shell command/);
  assert.match(codex.developerPrompt('', hq, ['Read'], {}), /You have no shell/);

  setProject('write', true);
  const ticket = claude.systemPromptFor(p, leo, dir, [], 'ticket', false);
  assert.match(ticket, /## Shell/);
  assert.match(ticket, /HQ refuses git push/);
  assert.match(ticket, /Do not commit unless you are asked to/);
  assert.doesNotMatch(ticket, /You have no shell/);
  assert.equal(claude.systemPromptFor(p, leo, dir, [], 'message', false), ticket, 'ticket runs and chat replies share one prompt');
  assert.match(claude.systemPromptFor(p, leo, dir, [], 'qa', false), /You may run the tests, the build or the app with Bash/);
  assert.doesNotMatch(claude.systemPromptFor(p, leo, dir, [], 'huddle', false), /## Shell/);
  setProject('read', true);
  assert.match(claude.systemPromptFor(p, leo, dir, [], 'ticket', false), /change nothing in it with a command either/);
  setProject('write', false);
  const off = claude.systemPromptFor(p, leo, dir, [], 'ticket', false);
  assert.match(off, /You have no shell/);
  assert.doesNotMatch(off, /## Shell/);
});

test('the setting: true or false only, written down only when on', () => {
  assert.match(readProjectPatch({ shell: 'yes' }).error ?? '', /shell must be true or false/);
  assert.equal(readProjectPatch({ shell: true }).patch.shell, true);
  assert.equal(store.updateProject(p.id, { shell: true }).shell, true);
  assert.equal('shell' in store.updateProject(p.id, { shell: false }), false);
});

test("HQ's Bash for GPT desks: bash by Git for Windows' layout, an environment without HQ's logins, the reply", () => {
  if (process.platform === 'win32') {
    assert.equal(shell.bashPath({ PATH: '', PATHEXT: '.EXE', ProgramFiles: root }, 'win32'), null, 'no Git for Windows, no bash');
    // Found through this PC's Git for Windows (a fake bash.exe would be held by the virus scanner).
    const real = shell.bashPath();
    if (real && /[\\/]Git[\\/]bin[\\/]bash\.exe$/i.test(real)) {
      const programFiles = path.resolve(real, '..', '..', '..');
      assert.equal(shell.bashPath({ PATH: '', PATHEXT: '.EXE', ProgramFiles: programFiles }, 'win32'), real, 'in Program Files');
      assert.equal(shell.bashPath({ PATH: path.join(programFiles, 'Git', 'cmd'), PATHEXT: '.EXE', ProgramFiles: root }, 'win32'), real, 'next to git');
      const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      assert.equal(shell.bashPath({ PATH: system32, PATHEXT: '.EXE', ProgramFiles: root }, 'win32'), null, "never WSL's bash in System32");
    }
  }
  const env = shell.shellEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'o', CODEX_HOME: 'c', GITHUB_TOKEN: 'g' });
  assert.equal(env.PATH, 'x');
  assert.equal(env.GITHUB_TOKEN, 'g');
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME']) assert.equal(env[k], undefined, k);
  assert.ok(env.GIT_CEILING_DIRECTORIES?.includes(HQ_ROOT), 'git never climbs into HQ');
  const ok = shell.bashReply({ code: 0, out: '\x1b[32mgreen\x1b[0m\n', err: '', timedOut: false, truncated: false }, 120_000);
  assert.deepEqual(ok, { ok: true, text: 'Exit code 0.\n\n--- stdout ---\ngreen' });
  const failed = shell.bashReply({ code: 2, out: '', err: 'nope', timedOut: false, truncated: false }, 120_000);
  assert.equal(failed.ok, false);
  assert.match(failed.text, /Exit code 2\.[\s\S]*--- stderr ---\nnope/);
  assert.match(shell.bashReply({ code: null, out: '', err: '', timedOut: true, truncated: false }, 1000).text, /^Stopped after 1 second:/);
  const long = shell.bashReply({ code: 0, out: 'x'.repeat(50_000), err: '', timedOut: false, truncated: false }, 1000, 1000);
  assert.ok(long.text.length <= 1000 && /characters cut/.test(long.text));
});

const bash = shell.bashPath();
test(`HQ's Bash runs a command in the workspace, refuses before running, stops on time${bash ? '' : ' (skipped: no bash here)'}`, async () => {
  if (!bash) return;
  setProject();
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-for-commands';
  try {
    const ctx = { dir, guard: claude.guard({ project: p, dir, mode: 'ticket' }) };
    const r = await shell.runBashTool({ command: 'echo hello-from-bash && pwd && echo "key=$ANTHROPIC_API_KEY"' }, ctx, 'b1');
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /hello-from-bash/);
    assert.match(r.text, new RegExp(`/${path.basename(dir)}\\n`), 'it starts in the workspace');
    assert.match(r.text, /key=\n|key=$/m, "HQ's login is not in its environment");
    const code = await shell.runBashTool({ command: 'exit 3' }, ctx, 'b2');
    assert.equal(code.ok, false);
    assert.match(code.text, /^Exit code 3\./);
    const refused = await shell.runBashTool({ command: 'rm -rf ..' }, ctx, 'b3');
    assert.equal(refused.ok, false);
    assert.match(refused.text, /^HQ refused rm/);
    assert.ok(fs.existsSync(dir), 'a refused command never ran');
    const slow = await shell.runBashTool({ command: 'sleep 20', timeout: 1000 }, ctx, 'b4');
    assert.equal(slow.ok, false);
    assert.match(slow.text, /^Stopped after 1 second/);
    assert.match((await shell.runBashTool({ command: 'echo x', timeout: 5 }, ctx, 'b5')).text, /timeout must be/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
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
    // The folder of a command killed on its timeout comes free only once the event loop runs again: retry without blocking.
    await fs.promises.rm(d, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  } catch (e) {
    console.warn(`could not remove ${d}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
assert.equal(failed, 0, `${failed} shell case(s) failed`);
console.log(`\nall ${passed} shell cases pass`);
