/**
 * Adding, removing and signing in to MCP servers from HQ.
 *   - The rules: names, URLs, local commands, presets, previews, scrubbing secrets, who may call the API.
 *   - The real `claude mcp` CLI (the one the Agent SDK ships) against a scratch Claude config:
 *     CLAUDE_CONFIG_DIR, HOME and USERPROFILE all point into a throwaway folder, and the test checks
 *     the MCP servers and sign-ins in your real Claude config are unchanged at the end. (Not the
 *     whole file: Claude Code sessions running on this PC write to it all the time.) Nothing is
 *     contacted: the dummy servers live on 127.0.0.1:9, which refuses connections.
 *   - HQ's side: new servers start off, a changed setup turns a connection off, targeted checks merge.
 * Run: npm run test:mcp. Works in a throwaway folder under the OS temp dir.
 */
import type { McpServerStatus as Status, Query } from '@anthropic-ai/claude-agent-sdk';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Your real config, before anything moves HOME: only the parts this feature could touch, the MCP
// servers (yours and per folder) and which servers have a saved sign-in. Never the tokens themselves.
const realClaudeJson = path.join(os.homedir(), '.claude.json');
const realCredentials = path.join(os.homedir(), '.claude', '.credentials.json');
function readJsonRetry(file: string): Record<string, unknown> | null {
  // Another Claude Code session may be halfway through writing it.
  for (let i = 0; i < 5; i++) {
    try {
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
    } catch {
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    }
  }
  throw new Error(`could not read ${file}`);
}
function mcpShape(): string {
  const cfg = readJsonRetry(realClaudeJson) ?? {};
  const projects = (cfg.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>;
  const perFolder = Object.fromEntries(Object.entries(projects).filter(([, v]) => v?.mcpServers && Object.keys(v.mcpServers).length > 0).map(([k, v]) => [k, v.mcpServers]));
  const signIns = Object.keys((readJsonRetry(realCredentials)?.mcpOAuth ?? {}) as Record<string, unknown>).sort();
  return crypto.createHash('sha256').update(JSON.stringify({ user: cfg.mcpServers ?? null, perFolder, signIns })).digest('hex');
}
const realHash = mcpShape();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-mcp-')));
const home = path.join(root, 'home');
const configDir = path.join(root, 'claude-config');
const proj = path.join(root, 'project');
for (const d of [home, configDir, proj]) fs.mkdirSync(d, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
delete process.env.HQ_CLAUDE_BIN;
// The store reads data/ from the working directory.
process.chdir(root);

const spec = await import('../shared/mcpSpec');
const presets = await import('../shared/mcpPresets');
const cli = await import('./mcpCli');
const http = await import('./http');
const mcp = await import('./mcp');
const store = await import('./store');
const conns = await import('./connections');
const auth = await import('./mcpAuth');

const DUMMY = 'http://127.0.0.1:9/mcp';
const SECRET = 'SECRET-xyz123456789';
const scratchJson = path.join(configDir, '.claude.json');

let passed = 0;
const cases: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push([name, fn]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- rules ----------

test('names: letters, numbers, - and _; no __, no hq, at most 40', () => {
  for (const ok of ['playwright', 'chrome-devtools', 'my_server', 'A1', 'x'.repeat(40)]) assert.equal(spec.nameProblem(ok), null, ok);
  for (const bad of ['', 'hq', 'HQ', '-s', '_x', 'a__b', 'my.server', 'with space', 'x'.repeat(41), 'é']) assert.ok(spec.nameProblem(bad), bad);
});

test('URLs: https, or http only on this PC; no logins or # in the URL', () => {
  for (const ok of ['https://mcp.sentry.dev/mcp', 'http://127.0.0.1:3845/mcp', 'http://localhost:8080/x?y=1', 'http://[::1]:9/mcp']) assert.equal(spec.urlProblem(ok), null, ok);
  for (const bad of ['', 'http://example.com/mcp', 'ftp://x/y', 'javascript:alert(1)', 'https://user:pw@x.com/mcp', 'https://x.com/mcp#frag', 'not a url', `https://x.com/${'a'.repeat(2050)}`]) {
    assert.ok(spec.urlProblem(bad), bad);
  }
});

test('sign-in links: only web pages', () => {
  assert.equal(spec.safeAuthUrl('https://accounts.example.com/auth?x=1'), 'https://accounts.example.com/auth?x=1');
  assert.equal(spec.safeAuthUrl('http://localhost:3000/cb'), 'http://localhost:3000/cb');
  for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'http://evil.com/x', 'vscode://x', '', undefined]) assert.equal(spec.safeAuthUrl(bad), null, String(bad));
});

test('local commands: one program, no shells; arguments without quotes or %', () => {
  for (const ok of ['npx', 'uvx', 'node', 'my-server.exe', 'C:\\Tools\\srv.exe', '/usr/bin/srv']) assert.equal(spec.commandProblem(ok), null, ok);
  for (const bad of ['', 'cmd', 'cmd.exe', 'powershell', 'PowerShell.exe', 'pwsh', 'bash', 'wsl', 'C:\\Windows\\System32\\cmd.exe', 'npx -y pkg', 'a&b', 'x"y']) {
    assert.ok(spec.commandProblem(bad), bad);
  }
  assert.equal(spec.argProblem('--url=https://a.com/?x=1&y=2'), null);
  for (const bad of ['a"b', '%PATH%', 'line\nbreak', 'x'.repeat(1001)]) assert.ok(spec.argProblem(bad), JSON.stringify(bad));
});

test('presets: the command comes from HQ, options only pick flags', () => {
  const pw = presets.presetById('playwright')!;
  assert.deepEqual(presets.presetArgs(pw, presets.presetDefaults(pw)), ['-y', '@playwright/mcp@latest', '--headless', '--isolated', '--browser', 'chrome']);
  assert.deepEqual(presets.presetArgs(pw, { headless: false, isolated: true, browser: 'msedge' }), ['-y', '@playwright/mcp@latest', '--isolated', '--browser', 'msedge']);
  // A value that is not one of the choices falls back to the default; unknown options are ignored.
  assert.deepEqual(presets.presetArgs(pw, { browser: 'evil; rm -rf', extra: true }), ['-y', '@playwright/mcp@latest', '--headless', '--isolated', '--browser', 'chrome']);
  const cd = presets.presetById('chrome-devtools')!;
  assert.deepEqual(presets.presetArgs(cd, presets.presetDefaults(cd)), ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated']);
  const built = spec.buildSpec({ preset: 'playwright', name: 'playwright', scope: 'project', values: { headless: false } });
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.deepEqual(built.config, { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--isolated', '--browser', 'chrome'] });
  assert.equal(built.scope, 'local');
  assert.equal(built.custom, false);
  assert.equal(built.runs, 'npx -y @playwright/mcp@latest --isolated --browser chrome');
  assert.ok('error' in spec.buildSpec({ preset: 'nope', name: 'x', scope: 'project' }));
});

test('custom HTTP: secret headers are saved but masked everywhere HQ shows them', () => {
  const built = spec.buildSpec({
    name: 'gh',
    scope: 'all',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [
      { name: 'Authorization', value: `Bearer ${SECRET}`, secret: true },
      { name: 'X-MCP-Readonly', value: 'true' },
    ],
  });
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.equal(built.scope, 'user');
  assert.deepEqual(built.config, { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${SECRET}`, 'X-MCP-Readonly': 'true' } });
  assert.ok(!built.preview.includes(SECRET));
  assert.match(built.preview, /header: Authorization: •••/);
  assert.match(built.preview, /header: X-MCP-Readonly: true/);
  // As typed and without its Bearer word, so the CLI's output is blanked either way.
  assert.deepEqual(built.secrets, [`Bearer ${SECRET}`, SECRET]);
  const dollar = spec.buildSpec({ name: 'x', scope: 'all', transport: 'http', url: 'https://a.com', headers: [{ name: 'A', value: '${HOME}', secret: true }] });
  assert.ok('error' in dollar);
  const dup = spec.buildSpec({ name: 'x', scope: 'all', transport: 'http', url: 'https://a.com', headers: [{ name: 'A', value: '1' }, { name: 'a', value: '2' }] });
  assert.ok('error' in dup);
  const badHeader = spec.buildSpec({ name: 'x', scope: 'all', transport: 'http', url: 'https://a.com', headers: [{ name: 'Bad Header', value: '1' }] });
  assert.ok('error' in badHeader);
});

test('custom local command: secret env and token-like arguments are masked; PATH and shells refused', () => {
  const built = spec.buildSpec({
    name: 'srv',
    scope: 'project',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'some-mcp', '--api-key=ghp_abcdefghijklmnop', 'plain'],
    env: [
      { name: 'API_TOKEN', value: SECRET, secret: true },
      { name: 'MODE', value: 'fast' },
    ],
    trustCommand: true,
  });
  assert.ok(!('error' in built));
  if ('error' in built) return;
  assert.equal(built.custom, true);
  assert.equal(built.runs, 'npx -y some-mcp --api-key=••• plain');
  assert.ok(!built.preview.includes(SECRET) && !built.preview.includes('ghp_'));
  assert.match(built.preview, /env: API_TOKEN=•••/);
  assert.match(built.preview, /env: MODE=fast/);
  assert.deepEqual(built.secrets.sort(), [SECRET, 'ghp_abcdefghijklmnop'].sort());
  assert.ok('error' in spec.buildSpec({ name: 'x', scope: 'project', transport: 'stdio', command: 'npx', env: [{ name: 'PATH', value: 'C:\\evil' }] }));
  assert.ok('error' in spec.buildSpec({ name: 'x', scope: 'project', transport: 'stdio', command: 'powershell', args: ['-c', 'x'] }));
  assert.ok('error' in spec.buildSpec({ name: 'x', scope: 'project', transport: 'stdio', command: 'npx', args: ['a"b'] }));
});

// Shapes a review found shown in full. Each goes through the one masker HQ uses everywhere.
const DOCKER = ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_shortish123', 'ghcr.io/github/github-mcp-server'];
const PG = 'postgresql://app:Hunter2pass@db.local/prod';
const ZAPIER = 'https://actions.zapier.com/mcp/sk-ak-abcdef123456/sse?api_key=QWERTY12345&mode=x';
const ARG_TOKENS = ['abc123def456', 'ghp_shortish123', 'Hunter2pass', 'hunter2', 'hunter3'];
const TOKEN_ARGS = ['srv.js', '--token=abc123def456', ...DOCKER.slice(3), PG, '--password=hunter2', '-p', 'hunter3'];

test('masking: flag values, NAME=value, URLs and the value after a secret flag; never just the next argument', () => {
  const shown = (args: string[]) => spec.maskArgs(args).shown.join(' ');
  assert.equal(shown(['--token=abc123def456']), '--token=•••');
  assert.equal(shown(['--password=hunter2', '-p', 'hunter3']), '--password=••• -p •••');
  // docker -e NAME=value: the value goes, the image after it stays.
  assert.equal(shown(DOCKER), 'run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN=••• ghcr.io/github/github-mcp-server');
  assert.equal(shown(['GITHUB_TOKEN', 'server.js']), 'GITHUB_TOKEN server.js');
  assert.equal(shown([PG]), 'postgresql://app:•••@db.local/prod');
  assert.equal(shown([ZAPIER]), 'https://actions.zapier.com/mcp/•••/sse?api_key=•••&mode=x');
  assert.equal(shown(['--url=https://u:pw123@x.com/a']), '--url=https://u:•••@x.com/a');
  assert.equal(shown(['--api-key', 'XYZ', '--port', '8080', '--no-auth', 'server.js']), '--api-key ••• --port 8080 --no-auth server.js');
  // After -p, a package or a port is not a password.
  assert.equal(shown(['-p', '@scope/pkg', '-p', '8080:80']), '-p @scope/pkg -p 8080:80');
  assert.equal(shown(['--header', 'Authorization: Bearer abc', 'Authorization: Bearer abc']), '--header ••• Authorization: •••');
  assert.equal(shown(['-y', '@playwright/mcp@latest', '--headless', '--browser', 'chrome', 'mcp-server-github-v2-0', `${'abcdef1234'.repeat(2)}`]), `-y @playwright/mcp@latest --headless --browser chrome mcp-server-github-v2-0 ${'abcdef1234'.repeat(2)}`);
  const m = spec.maskArgs(TOKEN_ARGS);
  for (const s of ARG_TOKENS) assert.ok(m.secrets.includes(s), s);
  assert.ok(!m.shown.join(' ').match(new RegExp(ARG_TOKENS.join('|'))), m.shown.join(' '));
  // Long random path parts are tokens; words with dashes are not.
  assert.equal(spec.maskPath('/v1/AbCdEfGhIjKlMnOpQrSt12/sse').shown, '/v1/•••/sse');
  assert.equal(spec.maskPath('/mcp/github-copilot-server/sse').shown, '/mcp/github-copilot-server/sse');
});

test('describe: the command or URL HQ shows has no token in it', () => {
  const d = (config: Parameters<typeof mcp.describe>[0]) => mcp.describe(config);
  assert.equal(d({ type: 'stdio', command: 'node', args: ['srv.js', '--token=abc123def456'] }).target, 'node srv.js --token=•••');
  assert.equal(d({ type: 'stdio', command: 'node', args: ['srv.js', '--token=abc123def456'] }).auth, 'token');
  assert.equal(d({ type: 'stdio', command: 'docker', args: DOCKER }).target, 'docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN=••• ghcr.io/github/github-mcp-server');
  assert.equal(d({ type: 'stdio', command: 'x', args: ['--password=hunter2', '-p', 'hunter3'] }).target, 'x --password=••• -p •••');
  assert.equal(d({ type: 'stdio', command: 'x', args: [PG] }).target, 'x postgresql://app:•••@db.local/prod');
  assert.equal(d({ type: 'stdio', command: 'x', args: ['plain'] }).auth, 'none');
  const zap = d({ type: 'sse', url: ZAPIER });
  assert.equal(zap.target, 'https://actions.zapier.com/mcp/•••/sse');
  assert.equal(zap.auth, 'token');
  assert.equal(d({ type: 'http', url: 'https://mcp.example.com/mcp?x=1' }).target, 'https://mcp.example.com/mcp');
  assert.equal(d({ type: 'http', url: 'https://mcp.example.com/mcp' }).auth, 'oauth');
  assert.equal(d({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': 'k' } }).auth, 'token');
  const all = JSON.stringify([d({ type: 'stdio', command: 'node', args: TOKEN_ARGS }), zap]);
  for (const s of [...ARG_TOKENS, 'sk-ak-abcdef123456', 'QWERTY12345']) assert.ok(!all.includes(s), s);
});

test('fingerprints: a new token keeps it, another server changes it', () => {
  const fp = mcp.fingerprintOf;
  const web = { type: 'http' as const, url: 'https://a.example.com/mcp', headers: { Authorization: 'Bearer one' } };
  assert.match(fp(web), /^[0-9a-f]{16}$/);
  assert.equal(fp(web), fp({ ...web, headers: { Authorization: 'Bearer two' } }));
  assert.notEqual(fp(web), fp({ ...web, url: 'https://b.example.com/mcp' }));
  assert.notEqual(fp(web), fp({ ...web, type: 'sse' }));
  assert.notEqual(fp(web), fp({ ...web, headers: { 'X-Other': 'one' } }));
  const local = { type: 'stdio' as const, command: 'npx', args: ['-y', 'pkg', '--token=abc123def456'], env: { API_TOKEN: 'x' } };
  assert.equal(fp(local), fp({ ...local, args: ['-y', 'pkg', '--token=zzz999'], env: { API_TOKEN: 'y' } }));
  assert.notEqual(fp(local), fp({ ...local, args: ['-y', 'other-pkg', '--token=abc123def456'] }));
  assert.notEqual(fp(local), fp({ ...local, env: { OTHER: 'x' } }));
});

test('errors: a server\'s own config values are blanked out of its error text', () => {
  const config = { type: 'stdio' as const, command: 'x', args: ['--password=hunter2', PG], env: { DB_NAME: 'prod-main-db', API: 'Token tok_short1' } };
  const out = cli.scrub('failed: hunter2 refused for prod-main-db (Hunter2pass) tok_short1 ok', mcp.configSecrets(config));
  for (const s of ['hunter2', 'prod-main-db', 'Hunter2pass', 'tok_short1']) assert.ok(!out.includes(s), out);
  assert.match(out, / ok$/);
  const web = mcp.configSecrets({ type: 'http', url: ZAPIER, headers: { 'X-Key': 'Bearer hdr-secret-1' } });
  for (const s of ['sk-ak-abcdef123456', 'QWERTY12345', 'hdr-secret-1']) assert.ok(web.includes(s), s);
});

test('add preview: tokens in a URL, arguments and secret-named rows are masked, and kept for scrubbing', () => {
  const web = spec.buildSpec({
    name: 'zap',
    scope: 'all',
    transport: 'sse',
    url: ZAPIER,
    // A second row, not ticked Secret: its name says it is one.
    headers: [
      { name: 'X-Mode', value: 'fast' },
      { name: 'Authorization', value: 'Token abc999secret' },
    ],
  });
  assert.ok(!('error' in web));
  if ('error' in web) return;
  assert.match(web.preview, /SSE: https:\/\/actions\.zapier\.com\/mcp\/•••\/sse\?api_key=•••&mode=x/);
  assert.match(web.preview, /header: Authorization: •••/);
  assert.match(web.preview, /header: X-Mode: fast/);
  for (const s of ['sk-ak-abcdef123456', 'QWERTY12345', 'Token abc999secret', 'abc999secret']) {
    assert.ok(web.secrets.includes(s), s);
    assert.ok(!web.preview.includes(s), s);
  }
  // A ${VAR} reference keeps the token off the command line: shown as typed, and only refused when ticked Secret.
  const ref = spec.buildSpec({ name: 'gh', scope: 'all', transport: 'http', url: 'https://api.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer ${GH_TOKEN}' }] });
  assert.ok(!('error' in ref) && ref.preview.includes('header: Authorization: Bearer ${GH_TOKEN}'));
  const ticked = spec.buildSpec({ name: 'gh', scope: 'all', transport: 'http', url: 'https://api.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer ${GH_TOKEN}', secret: true }] });
  assert.ok('error' in ticked && /untick Secret/.test(ticked.error));
  const local = spec.buildSpec({
    name: 'pg',
    scope: 'project',
    transport: 'stdio',
    command: 'docker',
    args: TOKEN_ARGS,
    env: [
      { name: 'DATABASE_URL', value: PG },
      { name: 'GITHUB_TOKEN', value: 'gh-env-secret' },
    ],
    trustCommand: true,
  });
  assert.ok(!('error' in local));
  if ('error' in local) return;
  assert.equal(local.runs, 'docker srv.js --token=••• -e GITHUB_PERSONAL_ACCESS_TOKEN=••• ghcr.io/github/github-mcp-server postgresql://app:•••@db.local/prod --password=••• -p •••');
  assert.match(local.preview, /env: DATABASE_URL=postgresql:\/\/app:•••@db\.local\/prod/);
  assert.match(local.preview, /env: GITHUB_TOKEN=•••/);
  for (const s of [...ARG_TOKENS, 'gh-env-secret']) {
    assert.ok(local.secrets.includes(s), s);
    assert.ok(!local.preview.includes(s), s);
  }
  assert.ok(spec.secretArgs(TOKEN_ARGS).length > 0);
});

test('add requests from a body: wrong shapes are refused', () => {
  assert.equal(typeof spec.parseAddRequest(null), 'string');
  assert.equal(typeof spec.parseAddRequest({ name: 'x', scope: 'everywhere' }), 'string');
  assert.equal(typeof spec.parseAddRequest({ name: 'x', scope: 'all', transport: 'ws' }), 'string');
  assert.equal(typeof spec.parseAddRequest({ name: 'x', scope: 'all', transport: 'stdio', args: [1] }), 'string');
  assert.equal(typeof spec.parseAddRequest({ name: 'x', scope: 'all', transport: 'http', headers: [{ name: 'a' }] }), 'string');
  assert.equal(typeof spec.parseAddRequest({ name: 'x', scope: 'all', preset: 'playwright', values: { headless: {} } }), 'string');
  const ok = spec.parseAddRequest({ name: 'x', scope: 'all', transport: 'http', url: 'https://a.com', headers: [{ name: 'A', value: '1', secret: 'yes' }], trustCommand: 'true' });
  assert.ok(typeof ok !== 'string');
  if (typeof ok === 'string') return;
  // Only a real true counts.
  assert.equal(ok.headers?.[0].secret, false);
  assert.equal(ok.trustCommand, false);
});

test('CLI arguments: the name after --, the config as one JSON argument, always a scope', () => {
  assert.deepEqual(cli.addArgs({ name: 'a', scope: 'local', config: { type: 'http', url: DUMMY } }), ['mcp', 'add-json', '--scope', 'local', '--', 'a', `{"type":"http","url":"${DUMMY}"}`]);
  assert.deepEqual(cli.removeArgs('a', 'user'), ['mcp', 'remove', '--scope', 'user', '--', 'a']);
  assert.deepEqual(cli.logoutArgs('a'), ['mcp', 'logout', '--', 'a']);
  assert.deepEqual(spec.SOURCE_TO_SCOPE, { folder: 'local', user: 'user', repo: 'project' });
  assert.equal(spec.SOURCE_TO_SCOPE['claude-ai'], undefined);
});

test('scrub: secrets as typed, JSON-escaped and URL-encoded, bearer tokens, token-like words, colours', () => {
  const s = 'p@ss"w\\rd 1';
  const text = `\x1b[31mfail\x1b[0m ${s} ${JSON.stringify(s)} ${encodeURIComponent(s)} Authorization: Bearer abc.def ghp_123456789 ${'A'.repeat(40)} ok`;
  const out = cli.scrub(text, [s]);
  assert.ok(!out.includes('\x1b'));
  assert.ok(!out.includes('p@ss'), out);
  assert.ok(!out.includes('abc.def'));
  assert.ok(!out.includes('ghp_123'));
  assert.ok(!out.includes('AAAA'));
  assert.match(out, /^fail /);
  assert.match(out, / ok$/);
  assert.equal(cli.scrub('x'.repeat(500)).length <= 300, true);
});

test('CLI messages: last lines of what it printed, or a fallback', () => {
  assert.equal(cli.cliMessage({ code: 1, out: '', err: 'one\n\ntwo\nthree\n', timedOut: false }, 'fb'), 'two three');
  assert.equal(cli.cliMessage({ code: 1, out: '', err: '', timedOut: false }, 'fb'), 'fb');
  assert.match(cli.cliMessage({ code: null, out: '', err: 'x', timedOut: true }, 'fb'), /did not answer/);
});

test('requests: only this PC\'s names; changes only from HQ\'s own page', () => {
  const none = new Set<string>();
  for (const ok of ['127.0.0.1:4747', 'localhost:5174', '[::1]:1', 'LOCALHOST', '127.0.0.1']) assert.ok(http.hostAllowed(ok, none), ok);
  for (const bad of [undefined, '', 'evil.com:4747', 'localhost.evil.com', '127.0.0.1.nip.io:4747', 'evil.com']) assert.ok(!http.hostAllowed(bad, none), String(bad));
  assert.ok(http.hostAllowed('my-pc:4747', new Set(['my-pc'])));
  const api = '127.0.0.1:4747';
  assert.ok(http.writeAllowed('GET', 'cross-site', 'https://evil.com', api, none));
  // The Vite dev proxy: Host is the API's port, Origin the page's, and the browser said same-origin.
  assert.ok(http.writeAllowed('POST', 'same-origin', 'http://localhost:5174', api, none));
  assert.ok(http.writeAllowed('POST', undefined, undefined, api, none));
  assert.ok(!http.writeAllowed('POST', 'same-site', 'http://localhost:3000', api, none));
  assert.ok(!http.writeAllowed('POST', 'cross-site', undefined, api, none));
  assert.ok(!http.writeAllowed('DELETE', undefined, 'https://evil.com', api, none));
  assert.ok(!http.writeAllowed('POST', undefined, 'null', api, none));
  // No Sec-Fetch-Site (older browsers): Origin must also be HQ's own port, since another app on this PC is another port.
  assert.ok(http.writeAllowed('POST', undefined, 'http://localhost:4747', api, none));
  assert.ok(!http.writeAllowed('POST', undefined, 'http://localhost:3000', api, none));
  assert.ok(!http.writeAllowed('POST', undefined, 'http://127.0.0.1', api, none));
  assert.ok(!http.writeAllowed('POST', undefined, 'http://localhost:4747', undefined, none));
  assert.ok(http.writeAllowed('POST', undefined, 'http://localhost', 'localhost', none));
});

test('request guard as middleware: the Vite dev proxy, an image upload, other sites and old browsers', () => {
  const call = (method: string, url: string, headers: Record<string, string>): number | 'next' => {
    let status = 0;
    let passed = false;
    const req = { method, path: url, get: (h: string) => headers[h.toLowerCase()] } as unknown as Parameters<typeof http.requestGuard>[0];
    const res = {
      status(s: number) {
        status = s;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Parameters<typeof http.requestGuard>[1];
    http.requestGuard(req, res, () => {
      passed = true;
    });
    return passed ? 'next' : status;
  };
  const api = { host: '127.0.0.1:4747' };
  assert.equal(call('POST', '/api/projects/x/connections', { ...api, origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }), 'next');
  // Images go up as a raw body, not JSON: the guard runs before any body is read.
  assert.equal(call('POST', '/api/projects/x/attachments', { ...api, origin: 'http://127.0.0.1:4747', 'sec-fetch-site': 'same-origin', 'content-type': 'image/png' }), 'next');
  assert.equal(call('POST', '/api/projects/x/attachments', { ...api, origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site', 'content-type': 'image/png' }), 403);
  assert.equal(call('POST', '/api/projects/x/attachments', { ...api, origin: 'http://localhost:3000', 'content-type': 'image/png' }), 403);
  assert.equal(call('POST', '/api/projects/x/attachments', { ...api, origin: 'http://localhost:4747', 'content-type': 'image/png' }), 'next');
  assert.equal(call('GET', '/api/projects', { host: 'evil.example:4747' }), 403);
  assert.equal(call('GET', '/api/projects', { ...api, origin: 'https://evil.com', 'sec-fetch-site': 'cross-site' }), 'next');
  // curl and tests: no browser headers.
  assert.equal(call('DELETE', '/api/projects/x/connections/y', api), 'next');
  // Express matches routes without case, so /API/... reaches the same routes: it is checked the same way.
  for (const url of ['/API/projects/x/reset', '/Api/projects/x/reset']) {
    const json = { ...api, 'content-type': 'application/json' };
    assert.equal(call('POST', url, { ...json, origin: 'https://evil.com', 'sec-fetch-site': 'cross-site' }), 403, `${url} cross-site`);
    assert.equal(call('POST', url, { ...json, origin: 'https://evil.com' }), 403, `${url} cross-site, old browser`);
    assert.equal(call('POST', url, { ...json, origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }), 403, `${url} another port`);
    assert.equal(call('POST', url, { ...json, origin: 'http://localhost:3000' }), 403, `${url} another port, old browser`);
    assert.equal(call('POST', url, { ...json, origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin' }), 'next', `${url} HQ's own page`);
  }
});

// ---------- the real CLI, scratch config ----------

const run = (args: string[], cwd = proj, secrets: string[] = []) => cli.runCli(args, { cwd, secrets, timeoutMs: 60_000 });
const named = (name: string, folder: string | null = proj) => mcp.discoverServers(folder).find((f) => f.info.name === name);

test('scratch: every Claude path points into the scratch folder', () => {
  assert.equal(cli.claudeJsonPath(), scratchJson);
  assert.equal(cli.claudeConfigDir(), configDir);
  assert.ok(fs.existsSync(cli.claudeBin()), 'the SDK ships claude.exe');
});

test('CLI: add-json to this project; HQ sees it as the folder\'s', async () => {
  const r = await run(cli.addArgs({ name: 'dummy-http', scope: 'local', config: { type: 'http', url: DUMMY } }));
  assert.equal(r.code, 0, r.err || r.out);
  const f = named('dummy-http');
  assert.equal(f?.info.source, 'folder');
  assert.equal(f?.info.target, DUMMY);
  assert.equal(f?.info.auth, 'oauth');
});

test('CLI: the same name in the same place is refused', async () => {
  const r = await run(cli.addArgs({ name: 'dummy-http', scope: 'local', config: { type: 'http', url: DUMMY } }));
  assert.notEqual(r.code, 0);
  assert.match(cli.cliMessage(r, ''), /already exists/i);
});

test('CLI: a secret header never shows in what the CLI prints', async () => {
  const r = await run(cli.addArgs({ name: 'with-token', scope: 'user', config: { type: 'http', url: DUMMY, headers: { Authorization: `Bearer ${SECRET}` } } }), proj, [`Bearer ${SECRET}`]);
  assert.equal(r.code, 0, r.err || r.out);
  assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET));
  const f = named('with-token');
  assert.equal(f?.info.source, 'user');
  assert.equal(f?.info.auth, 'token');
  assert.ok(!f?.info.target.includes(SECRET));
});

test('CLI: a local command with spaces, backslashes and env comes back exactly', async () => {
  const args = ['--root', 'C:\\Some Dir\\sub', 'two words', 'trailing\\', '{"json":true}', ''];
  const config = { type: 'stdio' as const, command: 'node', args, env: { MODE: 'a b', TOKEN: SECRET } };
  const r = await run(cli.addArgs({ name: 'local-cmd', scope: 'local', config }), proj, [SECRET]);
  assert.equal(r.code, 0, r.err || r.out);
  const f = named('local-cmd');
  assert.deepEqual(f?.config, config);
  assert.ok(!f?.info.target.includes(SECRET));
});

test('CLI: it checks names too', async () => {
  const r = await run(cli.addArgs({ name: 'bad.name', scope: 'local', config: { type: 'http', url: DUMMY } }));
  assert.notEqual(r.code, 0);
  assert.match(cli.cliMessage(r, ''), /Invalid name/i);
});

test('CLI: remove needs a scope when the name is in two places; with one it removes just that', async () => {
  for (const scope of ['local', 'user'] as const) {
    const r = await run(cli.addArgs({ name: 'dup', scope, config: { type: 'http', url: DUMMY } }));
    assert.equal(r.code, 0, r.err || r.out);
  }
  assert.equal(mcp.discoverAll(proj).hidden.find((f) => f.info.name === 'dup')?.info.source, 'user');
  const vague = await run(['mcp', 'remove', '--', 'dup']);
  assert.notEqual(vague.code, 0);
  assert.match(vague.err + vague.out, /multiple scopes/i);
  assert.equal((await run(cli.removeArgs('dup', 'local'))).code, 0);
  assert.equal(named('dup')?.info.source, 'user');
  assert.equal((await run(cli.removeArgs('dup', 'user'))).code, 0);
  assert.equal(named('dup'), undefined);
});

test('CLI: a folder inside a git repo uses the repo\'s settings', async () => {
  const repo = path.join(root, 'repo');
  const sub = path.join(repo, 'app');
  fs.mkdirSync(sub, { recursive: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  } catch {
    console.log('     (git not found: skipped)');
    return;
  }
  assert.equal(mcp.gitRoot(sub), repo);
  const r = await run(cli.addArgs({ name: 'in-repo', scope: 'local', config: { type: 'http', url: DUMMY } }), sub);
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(named('in-repo', sub)?.info.source, 'folder');
  assert.equal(named('in-repo', repo)?.info.source, 'folder');
});

test('CLI: logout on a server with no sign-in answers and does not hang', async () => {
  const r = await run(cli.logoutArgs('dummy-http'));
  assert.notEqual(r.timedOut, true);
});

test('SDK: a session has the sign-in call HQ uses', async () => {
  const s = mcp.openSession(path.join(root, 'probe'), { 'dummy-http': { type: 'http', url: DUMMY } }, false);
  try {
    assert.equal(typeof (s.q as unknown as { mcpAuthenticate?: unknown }).mcpAuthenticate, 'function');
  } finally {
    await s.close();
  }
});

// ---------- HQ's side ----------

store.initStore({ emptySeed: true });
const p = store.createProject({ name: 'Demo', key: 'DEMO', path: proj, access: 'read', template: 'dev' });
const pwReq = { preset: 'playwright', name: 'playwright', scope: 'project' as const };

test('add: preview shows where and what; a wrong confirm is refused', async () => {
  const pv = conns.previewAdd(p, pwReq);
  assert.match(pv.preview, /runs: npx -y @playwright\/mcp@latest --headless --isolated --browser chrome/);
  assert.ok(pv.location.startsWith(scratchJson));
  await assert.rejects(conns.addConnection(p, pwReq, 'something else'), (e: Error & { status?: number }) => e.status === 409);
});

test('add: saved through Claude Code, and off until you turn it on', async () => {
  const pv = conns.previewAdd(p, pwReq);
  const res = await conns.addConnection(p, pwReq, pv.preview);
  assert.equal(res.added, 'playwright');
  const row = res.rows.find((r) => r.name === 'playwright');
  assert.equal(row?.source, 'folder');
  assert.equal(row?.connection.enabled, false);
  assert.equal(named('playwright')?.config.type, 'stdio');
  // Already there: refused before running anything.
  assert.throws(() => conns.previewAdd(p, pwReq), /already set up/);
});

test('add: a custom local command needs "I trust this command"', async () => {
  const req = { name: 'mine', scope: 'project' as const, transport: 'stdio' as const, command: 'node', args: ['server.js'] };
  const pv = conns.previewAdd(p, req);
  await assert.rejects(conns.addConnection(p, req, pv.preview), /trust this command/);
  const ok = await conns.addConnection(p, { ...req, trustCommand: true }, pv.preview);
  assert.equal(ok.rows.find((r) => r.name === 'mine')?.connection.enabled, false);
});

test('add: a name too close to another server\'s tool names is refused', () => {
  p.state.checks['claude.ai Figma'] = { state: 'connected', checkedAt: store.now(), tools: [] };
  assert.throws(() => conns.previewAdd(p, { name: 'claude_ai_Figma', scope: 'all', transport: 'http', url: DUMMY }), /too close/);
  delete p.state.checks['claude.ai Figma'];
});

test('add: one that hides a turned-on server turns that one off', async () => {
  const shared = await run(cli.addArgs({ name: 'shared', scope: 'user', config: { type: 'http', url: DUMMY } }));
  assert.equal(shared.code, 0);
  conns.updateConnection(p, 'shared', { enabled: true });
  const req = { name: 'shared', scope: 'project' as const, transport: 'http' as const, url: 'http://127.0.0.1:9/other' };
  const pv = conns.previewAdd(p, req);
  assert.ok(pv.warnings.some((w) => /replaces/.test(w)), pv.warnings.join(' | '));
  const res = await conns.addConnection(p, req, pv.preview);
  const row = res.rows.find((r) => r.name === 'shared');
  assert.equal(row?.source, 'folder');
  assert.equal(row?.connection.enabled, false);
});

test('runs: a connection whose setup changed is skipped; Use the new setup drops the old tool list', () => {
  const desk = p.state.agents.find((a) => !a.isHuman);
  if (!desk) return console.log('     (no desk in the blank template: skipped)');
  const toolsOf = () => conns.runtimeServers(p, desk.id).allowed.find((a) => a.name === 'dummy-http')?.tools;
  const oldTools = { state: 'connected' as const, checkedAt: store.now(), tools: [{ name: 'do_thing', readOnly: true, reads: true }] };
  conns.updateConnection(p, 'dummy-http', { enabled: true, desks: [desk.id] });
  p.state.checks['dummy-http'] = oldTools;
  assert.ok(conns.runtimeServers(p, desk.id).servers['dummy-http']);
  assert.ok(toolsOf()?.do_thing, 'a check from before fingerprints still counts');
  const c = p.state.connections.find((x) => x.name === 'dummy-http')!;
  assert.match(c.fingerprint ?? '', /^[0-9a-f]{16}$/);
  // The page never gets it.
  assert.equal(conns.listConnections(p).rows.find((r) => r.name === 'dummy-http')?.connection.fingerprint, undefined);
  // Turned on for another server than the one set up now.
  c.fingerprint = '0000000000000000';
  assert.equal(conns.listConnections(p).rows.find((r) => r.name === 'dummy-http')?.changed, true);
  assert.equal(conns.runtimeServers(p, desk.id).servers['dummy-http'], undefined);
  conns.updateConnection(p, 'dummy-http', { enabled: true });
  assert.ok(conns.runtimeServers(p, desk.id).servers['dummy-http']);
  assert.equal(p.state.checks['dummy-http'], undefined, 'the old server\'s tool list is gone');
  assert.deepEqual(toolsOf(), {});
  // A check of another server than the one set up now is never trusted either.
  p.state.checks['dummy-http'] = { ...oldTools, fingerprint: 'ffffffffffffffff' } as typeof oldTools;
  assert.deepEqual(toolsOf(), {});
  // Off and on again: the same applies.
  conns.updateConnection(p, 'dummy-http', { enabled: false });
  conns.updateConnection(p, 'dummy-http', { enabled: true });
  assert.equal(p.state.checks['dummy-http'], undefined);
  conns.updateConnection(p, 'dummy-http', { enabled: false });
});

test('secrets: a turned-on server whose arguments hold tokens leaves none in HQ\'s data or answers', async () => {
  const config = { type: 'stdio' as const, command: 'node', args: TOKEN_ARGS };
  const r = await run(cli.addArgs({ name: 'tokens-in-args', scope: 'local', config }), proj, ARG_TOKENS);
  assert.equal(r.code, 0, r.err || r.out);
  for (const t of ARG_TOKENS) assert.ok(!r.out.includes(t) && !r.err.includes(t), t);
  const res = conns.updateConnection(p, 'tokens-in-args', { enabled: true });
  assert.ok(typeof res !== 'string' && res.fingerprint);
  const answer = JSON.stringify(conns.listConnections(p));
  store.flushAll();
  const db = fs.readFileSync(path.join(store.projectDataDir(p.id), 'db.json'), 'utf8');
  assert.ok(db.includes('tokens-in-args'));
  for (const t of ARG_TOKENS) {
    assert.ok(!db.includes(t), `db.json holds ${t}`);
    assert.ok(!answer.includes(t), `the answer holds ${t}`);
  }
  conns.updateConnection(p, 'tokens-in-args', { enabled: false });
});

test('check: a result for a server that changed while it ran is dropped', async () => {
  const r = await run(cli.addArgs({ name: 'race-srv', scope: 'local', config: { type: 'http', url: DUMMY } }));
  assert.equal(r.code, 0, r.err || r.out);
  const pending = conns.checkConnections(p, ['race-srv']);
  // Discovery already ran; now the setup changes under the running check.
  const j = JSON.parse(fs.readFileSync(scratchJson, 'utf8'));
  for (const k of Object.keys(j.projects ?? {})) if (j.projects[k].mcpServers?.['race-srv']) j.projects[k].mcpServers['race-srv'].url = 'http://127.0.0.1:9/changed';
  fs.writeFileSync(scratchJson, JSON.stringify(j, null, 2));
  await pending;
  assert.equal(p.state.checks['race-srv'], undefined);
  const again = await conns.checkConnections(p, ['race-srv']);
  assert.equal(again.rows.find((r) => r.name === 'race-srv')?.check?.state, 'failed', 'checked again, it counts');
  assert.equal((await run(cli.removeArgs('race-srv', 'local'))).code, 0);
});

// A second project in another folder, for changes that reach every project.
const projB = path.join(root, 'project-b');
fs.mkdirSync(projB, { recursive: true });
const b = store.createProject({ name: 'Bee', key: 'BEE', path: projB, access: 'read', template: 'dev' });

test('two projects: a remove turns off a connection saved before fingerprints; a re-add elsewhere starts off', async () => {
  const deskB = b.state.agents.find((a) => !a.isHuman);
  if (!deskB) return console.log('     (no desk in the blank template: skipped)');
  const add = await run(cli.addArgs({ name: 'legacy-gh', scope: 'user', config: { type: 'http', url: 'http://127.0.0.1:9/one' } }));
  assert.equal(add.code, 0, add.err || add.out);
  // As saved before this fix: on, on Auto, no fingerprint, with that server's tool list.
  const legacy = () => {
    b.state.connections = b.state.connections.filter((c) => c.name !== 'legacy-gh');
    b.state.connections.push({ name: 'legacy-gh', source: 'user', enabled: true, desks: [deskB.id], mode: 'auto' });
    b.state.checks['legacy-gh'] = { state: 'connected', checkedAt: store.now(), tools: [{ name: 'post_it', readOnly: true, reads: true }] };
  };
  legacy();
  assert.ok(conns.runtimeServers(b, deskB.id).servers['legacy-gh']);
  // Removed for all projects from project A: B turns it off too.
  await conns.removeConnection(p, 'legacy-gh', 'user');
  const gone = b.state.connections.find((c) => c.name === 'legacy-gh');
  assert.equal(gone?.enabled, false);
  assert.equal(gone?.mode, 'ask');
  assert.equal(b.state.checks['legacy-gh'], undefined);
  assert.equal(conns.listConnections(b).rows.find((r) => r.name === 'legacy-gh')?.present, false);
  assert.ok(b.state.activity.some((a) => /Turned off legacy-gh/.test(a.text)));
  // Gone: it can be turned off or forgotten, not on.
  assert.equal(typeof conns.updateConnection(b, 'legacy-gh', { enabled: true }), 'string');
  // Even if it was still on, adding the name back for all projects with another URL starts it off in B.
  legacy();
  const req = { name: 'legacy-gh', scope: 'all' as const, transport: 'http' as const, url: 'http://127.0.0.1:9/two' };
  await conns.addConnection(p, req, conns.previewAdd(p, req).preview);
  const readded = b.state.connections.find((c) => c.name === 'legacy-gh');
  assert.equal(readded?.enabled, false);
  assert.equal(readded?.mode, 'ask');
  assert.equal(b.state.checks['legacy-gh'], undefined);
  assert.equal(conns.runtimeServers(b, deskB.id).servers['legacy-gh'], undefined);
  await conns.removeConnection(p, 'legacy-gh', 'user');
});

test('two projects: a setup changed outside HQ turns off what was on in both; old saves get a fingerprint', async () => {
  const deskB = b.state.agents.find((a) => !a.isHuman);
  const deskA = p.state.agents.find((a) => !a.isHuman);
  if (!deskA || !deskB) return console.log('     (no desk in the blank template: skipped)');
  for (const name of ['both-on', 'both-old']) {
    const r = await run(cli.addArgs({ name, scope: 'user', config: { type: 'http', url: `http://127.0.0.1:9/${name}` } }));
    assert.equal(r.code, 0, r.err || r.out);
  }
  conns.updateConnection(p, 'both-on', { enabled: true, desks: [deskA.id] });
  conns.updateConnection(b, 'both-on', { enabled: true, desks: [deskB.id] });
  b.state.checks['both-on'] = { state: 'connected', checkedAt: store.now(), tools: [] };
  // Saved before fingerprints, still the same server.
  b.state.connections.push({ name: 'both-old', source: 'user', enabled: true, desks: [deskB.id], mode: 'ask' });
  conns.backfillFingerprints();
  assert.match(b.state.connections.find((c) => c.name === 'both-old')?.fingerprint ?? '', /^[0-9a-f]{16}$/);
  // Changed with Claude Code itself, not through HQ.
  assert.equal((await run(cli.removeArgs('both-on', 'user'))).code, 0);
  assert.equal((await run(cli.addArgs({ name: 'both-on', scope: 'user', config: { type: 'http', url: 'http://127.0.0.1:9/elsewhere' } }))).code, 0);
  assert.equal(conns.listConnections(b).rows.find((r) => r.name === 'both-on')?.changed, true);
  assert.equal(conns.runtimeServers(b, deskB.id).servers['both-on'], undefined);
  // The next change through HQ settles every project.
  const req = { name: 'settle-trigger', scope: 'project' as const, transport: 'http' as const, url: DUMMY };
  await conns.addConnection(p, req, conns.previewAdd(p, req).preview);
  for (const proj of [p, b]) {
    assert.equal(proj.state.connections.find((c) => c.name === 'both-on')?.enabled, false, proj.meta.key);
    assert.equal(proj.state.checks['both-on'], undefined, proj.meta.key);
  }
  assert.equal(b.state.connections.find((c) => c.name === 'both-old')?.enabled, true, 'unchanged ones stay on');
  for (const name of ['both-on', 'both-old']) assert.equal((await run(cli.removeArgs(name, 'user'))).code, 0);
  await conns.removeConnection(p, 'settle-trigger', 'folder');
});

test('remove: gone from Claude Code and from HQ', async () => {
  const res = await conns.removeConnection(p, 'mine', 'folder');
  assert.equal(res.rows.find((r) => r.name === 'mine'), undefined);
  assert.equal(named('mine'), undefined);
  await assert.rejects(conns.removeConnection(p, 'playwright', 'user'), /changed since/);
});

test('remove: when a hidden one shows through, it is off', async () => {
  const res = await conns.removeConnection(p, 'shared', 'folder');
  const row = res.rows.find((r) => r.name === 'shared');
  assert.equal(row?.source, 'user');
  assert.equal(row?.connection.enabled, false);
  assert.ok(res.warnings?.some((w) => /shows through/.test(w)));
});

test('check: just one server, merged into the rest', async () => {
  p.state.checks['untouched'] = { state: 'connected', checkedAt: '2020-01-01T00:00:00.000Z', tools: [] };
  const before = p.state.lastCheck;
  const res = await conns.checkConnections(p, ['dummy-http']);
  assert.equal(res.rows.find((r) => r.name === 'dummy-http')?.check?.state, 'failed');
  assert.equal(p.state.checks['untouched']?.checkedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(p.state.lastCheck, before);
  await assert.rejects(conns.checkConnections(p, ['no-such-server']), /Nothing to check/);
});

test('sign-in: a server that does not answer fails cleanly, one at a time', async () => {
  conns.loginConnection(p, 'dummy-http');
  assert.throws(() => conns.loginConnection(p, 'with-token'), /Another sign-in|already running/);
  const until = Date.now() + 40_000;
  let state = auth.loginOf(p.id, 'dummy-http')?.state;
  while (state !== 'failed' && Date.now() < until) {
    await sleep(500);
    state = auth.loginOf(p.id, 'dummy-http')?.state;
  }
  assert.equal(state, 'failed');
  assert.throws(() => conns.loginConnection(p, 'local-cmd'), /reached by URL/);
});

// ---------- sign-in, with a stand-in session ----------

const never = <T>() => new Promise<T>(() => undefined);
const until = async (what: string, cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

/** A stand-in for the Claude Code session: the test says what the server reports and what the sign-in call answers. */
function fakeSession(script: { status: () => Promise<Status | undefined>; authenticate?: (() => Promise<unknown>) | null }) {
  const seen = { closed: 0, asked: 0 };
  const q = {
    mcpServerStatus: async () => {
      const st = await script.status();
      return st ? [st] : [];
    },
    ...(script.authenticate === null
      ? {}
      : {
          mcpAuthenticate: () => {
            seen.asked++;
            return script.authenticate ? script.authenticate() : Promise.resolve({ authUrl: 'https://auth.example.com/authorize?x=1', requiresUserAction: true });
          },
        }),
  };
  const session = { q: q as unknown as Query, close: async () => void seen.closed++ };
  return { open: () => session, seen };
}

const FAKE = 'fake-login';
const fakeConfig = { type: 'http' as const, url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'hdr-value-secret' } };
const st = (status: Status['status'], extra: Partial<Status> = {}): Status => ({ name: FAKE, status, ...extra });
const loginState = () => auth.loginOf(p.id, FAKE);
const fast = { firstStatusMs: 300, loginMs: 1500, pollMs: 30 };

test('sign-in: starting, then waiting with the page, then connected', async () => {
  let phase: Status = st('needs-auth');
  const f = fakeSession({ status: async () => phase });
  auth.setLoginTestHooks({ open: f.open, ...fast, loginMs: 5000 });
  const got: Status[] = [];
  auth.startLogin(p, FAKE, fakeConfig, { onConnected: (s) => got.push(s) });
  assert.equal(loginState()?.state, 'starting');
  assert.ok(auth.loginRunning(p.id, FAKE) && auth.loginRunning(null, FAKE) && !auth.loginRunning('other', FAKE));
  await until('waiting', () => loginState()?.state === 'waiting');
  assert.equal(loginState()?.authUrl, 'https://auth.example.com/authorize?x=1');
  phase = st('connected', { tools: [] });
  await until('connected', () => got.length === 1);
  assert.equal(loginState(), undefined);
  await until('closed', () => f.seen.closed > 0);
});

test('sign-in: cancel works while starting, while asking for the page, and while waiting', async () => {
  for (const phase of ['starting', 'asking', 'waiting'] as const) {
    let status: Status = st('needs-auth');
    const f = fakeSession({ status: () => (phase === 'starting' ? never() : Promise.resolve(status)), authenticate: phase === 'asking' ? never : undefined });
    auth.setLoginTestHooks({ open: f.open, ...fast, firstStatusMs: 5000, loginMs: 5000 });
    const got: Status[] = [];
    auth.startLogin(p, FAKE, fakeConfig, { onConnected: (s) => got.push(s) });
    if (phase === 'asking') await until('asked', () => f.seen.asked > 0);
    if (phase === 'waiting') await until('waiting', () => loginState()?.state === 'waiting');
    assert.equal(auth.cancelLogin(p.id, FAKE), true, phase);
    assert.equal(loginState(), undefined, phase);
    assert.equal(auth.loginRunning(null, FAKE), false, phase);
    await until(`${phase} closed`, () => f.seen.closed > 0);
    status = st('connected', { tools: [] });
    await sleep(100);
    assert.equal(got.length, 0, `${phase}: a cancelled sign-in records nothing`);
  }
});

test('sign-in: a session that fails to start, a missing page, a bad page and silent calls all end, and the next one can start', async () => {
  const end = async (label: string, open: () => ReturnType<typeof mcp.openSession>, ms = 3000) => {
    auth.setLoginTestHooks({ open, ...fast });
    auth.startLogin(p, FAKE, fakeConfig, { onConnected: () => assert.fail(label) });
    await until(label, () => loginState()?.state === 'failed', ms);
    return loginState()!;
  };
  const threw = await end('openSession throws', () => {
    throw new Error('spawn failed C:\\secret\\path');
  });
  assert.match(threw.error ?? '', /Could not start/);
  assert.ok(!threw.error?.includes('secret'));
  // Not wedged: the next one starts.
  const noUrl = await end('no sign-in page', fakeSession({ status: async () => st('needs-auth'), authenticate: async () => ({ requiresUserAction: true, callbackExpected: true }) }).open);
  assert.equal(noUrl.unsupported, true);
  const nothing = await end('an answer of nothing', fakeSession({ status: async () => st('needs-auth'), authenticate: async () => undefined }).open);
  assert.equal(nothing.unsupported, true);
  const bad = await end('a page that is not a web page', fakeSession({ status: async () => st('needs-auth'), authenticate: async () => ({ authUrl: 'javascript:alert(1)', requiresUserAction: true }) }).open);
  assert.match(bad.error ?? '', /not a web page/);
  assert.equal(bad.unsupported, undefined);
  const noSdk = await end('no sign-in call', fakeSession({ status: async () => st('needs-auth'), authenticate: null }).open);
  assert.equal(noSdk.unsupported, true);
  const silent = await end('first status never answers', fakeSession({ status: never }).open);
  assert.match(silent.error ?? '', /did not answer/);
  const stuck = await end('the sign-in call never answers', fakeSession({ status: async () => st('needs-auth'), authenticate: never }).open);
  assert.match(stuck.error ?? '', /timed out/);
  // The server's own values never show in what it says went wrong.
  let phase: Status = st('needs-auth');
  const leak = fakeSession({ status: async () => phase });
  auth.setLoginTestHooks({ open: leak.open, ...fast });
  auth.startLogin(p, FAKE, fakeConfig, { onConnected: () => assert.fail('leak') });
  await until('waiting', () => loginState()?.state === 'waiting');
  phase = st('failed', { error: 'refused key hdr-value-secret' });
  await until('failed', () => loginState()?.state === 'failed');
  assert.ok(!loginState()?.error?.includes('hdr-value-secret'), loginState()?.error);
  // No browser needed: it waits without a page and connects.
  phase = st('needs-auth');
  const quiet = fakeSession({ status: async () => phase, authenticate: async () => ({ requiresUserAction: false }) });
  auth.setLoginTestHooks({ open: quiet.open, ...fast });
  const got: Status[] = [];
  auth.startLogin(p, FAKE, fakeConfig, { onConnected: (s) => got.push(s) });
  await until('waiting', () => loginState()?.state === 'waiting');
  assert.equal(loginState()?.authUrl, undefined);
  phase = st('connected', { tools: [] });
  await until('connected', () => got.length === 1);
  auth.setLoginTestHooks();
});

test('sign-in for all projects: a running one blocks adding or removing that name from any project, and is cancelled after', async () => {
  auth.setLoginTestHooks({ open: fakeSession({ status: never }).open, firstStatusMs: 60_000 });
  auth.startLogin(b, 'everywhere-srv', fakeConfig, { onConnected: () => undefined });
  const req = { name: 'everywhere-srv', scope: 'all' as const, transport: 'http' as const, url: DUMMY };
  await assert.rejects(conns.addConnection(p, req, conns.previewAdd(p, req).preview), /sign-in for everywhere-srv is running/);
  auth.cancelLogin(b.id, 'everywhere-srv');
  await conns.addConnection(p, req, conns.previewAdd(p, req).preview);
  auth.startLogin(b, 'everywhere-srv', fakeConfig, { onConnected: () => undefined });
  await assert.rejects(conns.removeConnection(p, 'everywhere-srv', 'user'), /sign-in for everywhere-srv is running/);
  auth.cancelLoginsNamed('everywhere-srv');
  assert.equal(auth.loginRunning(null, 'everywhere-srv'), false);
  await conns.removeConnection(p, 'everywhere-srv', 'user');
  auth.setLoginTestHooks();
});

test('terminal: ; is escaped in every piece, the program is HQ\'s own claude.exe, odd names are refused', async () => {
  assert.deepEqual(cli.terminalArgs('C:\\a;b\\proj'), ['-d', 'C:\\a\\;b\\proj']);
  assert.deepEqual(cli.terminalArgs('C:\\proj', 'my-server', 'C:\\Program Files\\x;y\\claude.exe'), ['-d', 'C:\\proj', 'C:\\Program Files\\x\\;y\\claude.exe', 'mcp', 'login', '--', 'my-server']);
  assert.deepEqual(cli.terminalArgs('C:\\p;q', 'a;new-tab calc', 'C:\\c.exe'), ['-d', 'C:\\p\\;q', 'C:\\c.exe', 'mcp', 'login', '--', 'a\\;new-tab calc']);
  // Refused before anything else is looked at, so no window ever opens here.
  await assert.rejects(conns.openProjectTerminal(p, 'x;new-tab calc'), (e: Error & { status?: number }) => e.status === 400 && /can't open a terminal for that name/.test(e.message));
});

test('CLI runner: a timeout or a leftover child holding the output never hangs the queue', async () => {
  const script = path.join(root, 'hold.cjs');
  fs.writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process');",
      '// A child that outlives this process and keeps its output pipe open.',
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true });",
      'child.unref();',
      "require('node:fs').writeSync(1, `child ${child.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      "if (process.argv[2] === 'exit') process.exit(0);",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const pids: number[] = [];
  const grab = (out: string) => {
    const m = /child (\d+)/.exec(out);
    if (m) pids.push(Number(m[1]));
  };
  // Outside the scratch folder: Windows can't delete a folder a leftover process is working in.
  const cwd = os.tmpdir();
  try {
    let t = Date.now();
    const slow = await cli.runCli([script, 'stay'], { cwd, bin: process.execPath, timeoutMs: 1000 });
    grab(slow.out);
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
    t = Date.now();
    const quick = await cli.runCli([script, 'exit'], { cwd, bin: process.execPath, timeoutMs: 30_000 });
    grab(quick.out);
    assert.equal(quick.timedOut, false);
    assert.equal(quick.code, 0);
    assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
    // The queue moves on.
    assert.equal((await cli.runCli(['-e', '0'], { cwd, bin: process.execPath })).code, 0);
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }
});

test('logout: refused for local commands', async () => {
  await assert.rejects(conns.logoutConnection(p, 'local-cmd'), /reached by URL/);
});

test('secrets: none in HQ\'s data', () => {
  store.flushAll();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (f: string) => files.push(f))(path.join(d, e.name));
  };
  walk(path.join(root, 'data'));
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), f);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message : String(e)}`);
  }
}
auth.cancelAllLogins();
store.flushAll();
const realAfter = mcpShape();
process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });
assert.equal(realAfter, realHash, 'the MCP servers or sign-ins in your real Claude config changed');
assert.equal(failed, 0, `${failed} MCP case(s) failed`);
console.log(`\nall ${passed} MCP cases pass (your real MCP servers and sign-ins are unchanged)`);
