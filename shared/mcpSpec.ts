import { presetArgs, presetById, type PresetValues } from './mcpPresets';
import type { McpSource } from './types';

/**
 * What the Add connection screen sends, and the checks both sides run on it.
 * Pure: the server and the browser use the same rules, and the tests run them directly.
 */

/** Where a new server is saved. project: Claude Code's local scope for the project's folder. all: its user scope. */
export type AddScope = 'project' | 'all';
/** Claude Code's own names for where a server lives. */
export type CliScope = 'local' | 'user' | 'project';
export type AddTransport = 'http' | 'sse' | 'stdio';

export interface KeyValue {
  name: string;
  value: string;
  /** Masked on screen and kept out of every log. */
  secret?: boolean;
}

export interface AddRequest {
  /** A preset id, or absent for a custom server. */
  preset?: string;
  name: string;
  scope: AddScope;
  /** Preset options. */
  values?: PresetValues;
  transport?: AddTransport;
  url?: string;
  headers?: KeyValue[];
  command?: string;
  args?: string[];
  env?: KeyValue[];
  /** Custom local commands only: you checked "I trust this command". */
  trustCommand?: boolean;
}

export type McpJson =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export interface BuiltSpec {
  name: string;
  scope: CliScope;
  config: McpJson;
  /** Values to blank out of anything the CLI prints. */
  secrets: string[];
  /** What you review and confirm. Secrets are masked. */
  preview: string;
  /** The command line it runs on this PC, masked, for local servers. */
  runs: string | null;
  /** A custom local command: needs trustCommand. */
  custom: boolean;
  /** Absolute command path the server must check exists. */
  commandPath: string | null;
}

export const ADD_SCOPES: Record<AddScope, CliScope> = { project: 'local', all: 'user' };
/** HQ's source names for where a definition lives, and Claude Code's scope for each. */
export const SOURCE_TO_SCOPE: Partial<Record<McpSource, CliScope>> = { folder: 'local', user: 'user', repo: 'project' };
export const SCOPE_TO_SOURCE: Record<CliScope, McpSource> = { local: 'folder', user: 'user', project: 'repo' };

export const MASK = '•••';
const MAX_ROWS = 20;
const MAX_ARGS = 40;
const MAX_VALUE = 4096;

/** A variable, header or NAME=value name that holds a secret: API_TOKEN, X-Api-Key, Authorization, DB_PASS. */
export const SECRET_NAME = /key|token|secret|auth|passw|passphrase|(^|[-_])pass($|[-_])|pwd|bearer|cookie/i;
/** A flag whose value is a secret. --header too: its value is often "Authorization: ...". */
export const SECRET_FLAG = new RegExp(`${SECRET_NAME.source}|header`, 'i');
/** Prefixes that well-known services put on their tokens. */
export const TOKEN_PREFIXES = 'sk|ctx7sk|ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs]|npm|hf|ntn|lin_api|shpat|dop_v1';
/** A value that is a token on its own: a known prefix, a Google key, a JWT, or 32+ letters and digits. */
export const SECRET_VALUE = new RegExp(`^(${TOKEN_PREFIXES})[-_]|^AIza[0-9A-Za-z_-]{20,}|^eyJ[A-Za-z0-9_-]{8,}\\.|^[A-Za-z0-9_\\-]{32,}$`);

/** What a masker shows, and the values it blanked out (for scrubbing). */
export interface Masked<T> {
  shown: T;
  secrets: string[];
}

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 20+ characters of letters and digits that read as random: mixed case, or a lot of digits (hex, ids). Not words-with-dashes. */
function randomLooking(s: string): boolean {
  if (s.length < 20 || !/^[A-Za-z0-9_\-.~]+$/.test(s) || !/\d/.test(s) || !/[A-Za-z]/.test(s)) return false;
  const digits = s.replace(/\D/g, '').length;
  return (/[a-z]/.test(s) && /[A-Z]/.test(s)) || digits / s.length >= 0.25;
}

const tokenLike = (s: string): boolean => SECRET_VALUE.test(s) || randomLooking(s);

/** A URL path with token-looking parts blanked: /mcp/sk-ak-1234/sse -> /mcp/•••/sse. */
export function maskPath(pathname: string): Masked<string> {
  const secrets: string[] = [];
  const shown = pathname
    .split('/')
    .map((seg) => {
      if (!seg || !tokenLike(decoded(seg))) return seg;
      secrets.push(seg, decoded(seg));
      return MASK;
    })
    .join('/');
  return { shown, secrets };
}

/** name=value pairs of a query or fragment, with secret names and token-looking values blanked. */
function maskPairs(text: string, secrets: string[]): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const value = pair.slice(eq + 1);
      if (!value || !(SECRET_NAME.test(decoded(pair.slice(0, eq))) || tokenLike(decoded(value)))) return pair;
      secrets.push(value, decoded(value));
      return `${pair.slice(0, eq + 1)}${MASK}`;
    })
    .join('&');
}

const URLISH = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/is;

/**
 * A URL with the password of user:password@ blanked (and a token used as the user name), token-looking
 * path parts, and query or fragment values with a secret name or a token-looking value.
 * postgresql://app:pw@db/prod -> postgresql://app:•••@db/prod. Anything that is not a URL comes back as is.
 */
export function maskUrl(url: string): Masked<string> {
  const m = URLISH.exec(url);
  if (!m) return { shown: url, secrets: [] };
  const [, scheme, authority, pathname, query, fragment] = m;
  const secrets: string[] = [];
  let host = authority;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    let user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const password = colon >= 0 ? userinfo.slice(colon + 1) : '';
    if (password) secrets.push(password, decoded(password));
    if (tokenLike(decoded(user))) {
      secrets.push(user, decoded(user));
      user = MASK;
    }
    host = `${user}${colon >= 0 ? `:${password ? MASK : ''}` : ''}@${authority.slice(at + 1)}`;
  }
  const path = maskPath(pathname);
  secrets.push(...path.secrets);
  const q = query ? `?${maskPairs(query.slice(1), secrets)}` : '';
  const f = fragment ? `#${maskPairs(fragment.slice(1), secrets)}` : '';
  return { shown: `${scheme}${host}${path.shown}${q}${f}`, secrets };
}

const isFlag = (a: string): boolean => /^--?[A-Za-z]/.test(a);
// After -p, a package (@scope/pkg, pkg@1) or a port (8080:80) is not a password.
const NOT_A_PASSWORD = /[@/]|^[\d:.]+$/;

/** Does `flag` (no =) take a secret as the next argument? --api-key X, --token X, --header X, -p X. */
function takesSecret(flag: string, next: string): boolean {
  if (!isFlag(flag) || flag.includes('=') || flag.startsWith('--no-') || next.startsWith('-')) return false;
  if (flag === '-p') return !NOT_A_PASSWORD.test(next);
  return SECRET_FLAG.test(flag);
}

/** One argument on its own: --flag=value, NAME=value, "Name: value", a URL, or a bare token. */
function maskOne(arg: string, secrets: string[]): string {
  const blank = (value: string) => {
    secrets.push(...secretForms(value));
    return MASK;
  };
  // --api-key=..., --env=GITHUB_TOKEN=...
  const flag = /^(--?[A-Za-z][\w.-]*)=(.*)$/s.exec(arg);
  if (flag) {
    const [, name, value] = flag;
    if (value && (SECRET_FLAG.test(name) || SECRET_VALUE.test(value))) return `${name}=${blank(value)}`;
    return `${name}=${maskOne(value, secrets)}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
    const u = maskUrl(arg);
    secrets.push(...u.secrets);
    return u.shown;
  }
  // GITHUB_PERSONAL_ACCESS_TOKEN=... (docker -e), DATABASE_URL=postgres://user:pw@...
  const pair = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(arg);
  if (pair) {
    const [, name, value] = pair;
    if (value && (SECRET_NAME.test(name) || SECRET_VALUE.test(value))) return `${name}=${blank(value)}`;
    return `${name}=${maskOne(value, secrets)}`;
  }
  // Authorization: Bearer ..., X-Api-Key: ...
  const header = /^([A-Za-z][\w-]*)\s*:\s*(\S.*)$/s.exec(arg);
  if (header && SECRET_NAME.test(header[1])) return `${header[1]}: ${blank(header[2])}`;
  if (/^(bearer|basic|token)\s+\S/i.test(arg) || SECRET_VALUE.test(arg)) return blank(arg);
  return arg;
}

/**
 * Arguments with anything secret blanked, the same way everywhere HQ shows or remembers them.
 * The value after a secret flag is blanked (--api-key X), never an argument just because the one
 * before it mentions a token: in `-e GITHUB_TOKEN=... ghcr.io/github/server` the image stays.
 */
export function maskArgs(args: string[]): Masked<string[]> {
  const secrets: string[] = [];
  const shown = args.map((a, i) => {
    if (i > 0 && takesSecret(args[i - 1], a)) {
      secrets.push(...secretForms(a));
      return MASK;
    }
    return maskOne(a, secrets);
  });
  return { shown, secrets: [...new Set(secrets.filter(Boolean))] };
}

/** Header or variable rows that hold a secret: ticked Secret, or named like one (unless the value is a ${VAR} reference). */
function isSecretRow(row: KeyValue): boolean {
  return Boolean(row.secret) || (SECRET_NAME.test(row.name) && !row.value.includes('${'));
}

/** A header or variable value as HQ shows it, and the secrets in it. */
function maskValue(row: KeyValue): Masked<string> {
  if (isSecretRow(row) || SECRET_VALUE.test(row.value)) return { shown: MASK, secrets: secretForms(row.value) };
  return maskUrl(row.value);
}

/** A secret as typed, and without its Bearer/Basic/Token word, so either way it is blanked. */
export function secretForms(value: string): string[] {
  const bare = value.replace(/^(bearer|basic|token)\s+/i, '');
  return bare && bare !== value ? [value, bare] : [value];
}

/** How a server name appears inside tool names: mcp__<key>__<tool>. */
export function toolKey(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function nameProblem(name: string): string | null {
  if (!name) return 'Give it a name.';
  if (name.length > 40) return 'Names can be at most 40 characters.';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return 'Use letters, numbers, - and _ only, starting with a letter or number.';
  // The guard matches tools by mcp__<name>__, so a name with __ could pass for another server's tools.
  if (name.includes('__')) return 'A name cannot contain two underscores in a row.';
  if (name.toLowerCase() === 'hq') return 'hq is HQ\'s own name. Pick another.';
  return null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

export function urlProblem(url: string): string | null {
  if (!url) return 'Enter the server URL.';
  if (url.length > 2048) return 'That URL is too long.';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'That is not a valid URL.';
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) return 'Use https://. Plain http:// is only allowed for this PC (localhost).';
  if (u.username || u.password) return 'Put logins in a header, not in the URL.';
  if (u.hash) return 'Remove the # part of the URL.';
  return null;
}

/** A sign-in link from a remote server: only web pages, never javascript: or an app link. */
export function safeAuthUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))) return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}

// Programs that run other commands from text: HQ shows exactly what runs, and a shell would hide it.
const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wsl', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32']);
// Variables that change how every program starts.
const BLOCKED_ENV = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'NODE_OPTIONS', 'SYSTEMROOT', 'WINDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']);

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

function programName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

export function commandProblem(command: string): string | null {
  if (!command) return 'Enter the program to run.';
  if (command.length > 400) return 'That command is too long.';
  if (!isAbsolutePath(command) && !/^[A-Za-z0-9._-]+$/.test(command)) return 'Enter one program name, like npx or uvx, or the full path to a program. Put its options under Arguments.';
  if (/[\x00-\x1f"]/.test(command)) return 'The program name has a character that is not allowed.';
  if (SHELLS.has(programName(command))) return 'Shells like cmd and PowerShell are not allowed. Enter the program itself.';
  return null;
}

export function argProblem(arg: string): string | null {
  if (arg.length > 1000) return 'An argument is too long.';
  if (/[\x00-\x1f]/.test(arg)) return 'An argument has a control character.';
  if (/["%]/.test(arg)) return 'Arguments cannot contain " or %.';
  return null;
}

function headerNameProblem(name: string): string | null {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return `"${name.slice(0, 40)}" is not a valid header name.`;
  return null;
}

function envNameProblem(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return `"${name.slice(0, 40)}" is not a valid variable name.`;
  if (BLOCKED_ENV.has(name.toUpperCase())) return `${name} cannot be set here.`;
  return null;
}

function valueProblem(row: KeyValue): string | null {
  if (row.value.length > MAX_VALUE) return `The value for ${row.name} is too long.`;
  if (/[\r\n\x00]/.test(row.value)) return `The value for ${row.name} has a line break.`;
  // Claude Code would read ${NAME} as a variable and swap it out.
  if (row.secret && row.value.includes('${')) return `The secret for ${row.name} cannot contain \${. To use a variable, untick Secret.`;
  return null;
}

function rowsProblem(rows: KeyValue[], nameCheck: (n: string) => string | null, what: string): string | null {
  if (rows.length > MAX_ROWS) return `At most ${MAX_ROWS} ${what}.`;
  const seen = new Set<string>();
  for (const r of rows) {
    const p = nameCheck(r.name) ?? valueProblem(r);
    if (p) return p;
    const k = r.name.toLowerCase();
    if (seen.has(k)) return `${r.name} is listed twice.`;
    seen.add(k);
  }
  return null;
}

/** Arguments are split on spaces for display only when they need no quoting. */
function showArg(a: string): string {
  return a === '' || /\s/.test(a) ? `'${a}'` : a;
}

/** Header or variable lines for the preview, masked, and the secrets in them. */
function rowLines(rows: KeyValue[], line: (r: KeyValue, shown: string) => string): Masked<string[]> {
  const secrets: string[] = [];
  const shown = rows.map((r) => {
    const v = maskValue(r);
    secrets.push(...v.secrets);
    return line(r, v.shown);
  });
  return { shown, secrets };
}

const SCOPE_LABEL: Record<CliScope, string> = { local: "this project's settings", user: 'all my projects', project: "the repo's .mcp.json" };

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function cleanRows(rows: KeyValue[] | undefined): KeyValue[] {
  return (rows ?? []).map((r) => ({ name: r.name.trim(), value: r.value, secret: Boolean(r.secret) })).filter((r) => r.name || r.value);
}

/**
 * Check an add request and turn it into the JSON Claude Code saves, plus a masked preview.
 * Returns a sentence to show when something is wrong.
 */
export function buildSpec(req: AddRequest): BuiltSpec | { error: string } {
  const name = req.name.trim();
  const bad = nameProblem(name);
  if (bad) return { error: bad };
  if (req.scope !== 'project' && req.scope !== 'all') return { error: 'Pick where to save it.' };
  const scope = ADD_SCOPES[req.scope];
  const head = [`name: ${name}`, `saved in: ${SCOPE_LABEL[scope]}`];

  if (req.preset) {
    const preset = presetById(req.preset);
    if (!preset) return { error: 'Unknown preset.' };
    const args = presetArgs(preset, req.values ?? {});
    const runs = [preset.command, ...args].map(showArg).join(' ');
    return {
      name,
      scope,
      config: { type: 'stdio', command: preset.command, args },
      secrets: [],
      preview: [...head, `runs: ${runs}`].join('\n'),
      runs,
      custom: false,
      commandPath: null,
    };
  }

  const transport = req.transport;
  if (transport === 'http' || transport === 'sse') {
    const url = (req.url ?? '').trim();
    const urlBad = urlProblem(url);
    if (urlBad) return { error: urlBad };
    const headers = cleanRows(req.headers);
    const rowsBad = rowsProblem(headers, headerNameProblem, 'headers');
    if (rowsBad) return { error: rowsBad };
    const shownUrl = maskUrl(url);
    const lines = rowLines(headers, (h, v) => `header: ${h.name}: ${v}`);
    return {
      name,
      scope,
      config: { type: transport, url, ...(headers.length ? { headers: Object.fromEntries(headers.map((h) => [h.name, h.value])) } : {}) },
      secrets: unique([...lines.secrets, ...shownUrl.secrets]),
      preview: [...head, `${transport === 'sse' ? 'SSE' : 'HTTP'}: ${shownUrl.shown}`, ...lines.shown].join('\n'),
      runs: null,
      custom: true,
      commandPath: null,
    };
  }

  if (transport === 'stdio') {
    const command = (req.command ?? '').trim();
    const cmdBad = commandProblem(command);
    if (cmdBad) return { error: cmdBad };
    const args = (req.args ?? []).filter((a) => a !== '');
    if (args.length > MAX_ARGS) return { error: `At most ${MAX_ARGS} arguments.` };
    for (const a of args) {
      const p = argProblem(a);
      if (p) return { error: p };
    }
    const env = cleanRows(req.env);
    const rowsBad = rowsProblem(env, envNameProblem, 'variables');
    if (rowsBad) return { error: rowsBad };
    const shownArgs = maskArgs(args);
    const runs = [command, ...shownArgs.shown].map(showArg).join(' ');
    const lines = rowLines(env, (e, v) => `env: ${e.name}=${v}`);
    return {
      name,
      scope,
      config: { type: 'stdio', command, args, ...(env.length ? { env: Object.fromEntries(env.map((e) => [e.name, e.value])) } : {}) },
      secrets: unique([...lines.secrets, ...shownArgs.secrets]),
      preview: [...head, `runs: ${runs}`, ...lines.shown].join('\n'),
      runs,
      custom: true,
      commandPath: isAbsolutePath(command) ? command : null,
    };
  }
  return { error: 'Pick how HQ talks to it: a URL or a local command.' };
}

/** Secrets in arguments: warn, since arguments are readable in Claude Code's settings and by other programs while the server runs. */
export function secretArgs(args: string[]): string[] {
  return maskArgs(args).secrets;
}

/** Read an add request from an untrusted body. Returns a sentence when the shape is wrong. */
export function parseAddRequest(body: unknown): AddRequest | string {
  if (!body || typeof body !== 'object') return 'Send the server details.';
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const rows = (v: unknown, what: string): KeyValue[] | string => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return `${what} must be a list`;
    const out: KeyValue[] = [];
    for (const r of v) {
      if (!r || typeof r !== 'object') return `${what} must be a list of name and value`;
      const x = r as Record<string, unknown>;
      if (typeof x.name !== 'string' || typeof x.value !== 'string') return `${what} must be a list of name and value`;
      out.push({ name: x.name, value: x.value, secret: x.secret === true });
    }
    return out;
  };
  if (typeof b.name !== 'string') return 'name is required';
  if (b.scope !== 'project' && b.scope !== 'all') return 'scope must be project or all';
  const req: AddRequest = { name: b.name, scope: b.scope };
  if (b.preset !== undefined) {
    if (typeof b.preset !== 'string') return 'preset must be text';
    req.preset = b.preset;
    if (b.values !== undefined) {
      if (!b.values || typeof b.values !== 'object' || Array.isArray(b.values)) return 'values must be an object';
      const values: PresetValues = {};
      for (const [k, v] of Object.entries(b.values as Record<string, unknown>)) {
        if (typeof v !== 'string' && typeof v !== 'boolean') return 'values must be text or true/false';
        values[k] = v;
      }
      req.values = values;
    }
    return req;
  }
  if (b.transport !== 'http' && b.transport !== 'sse' && b.transport !== 'stdio') return 'transport must be http, sse or stdio';
  req.transport = b.transport;
  req.url = str(b.url);
  req.command = str(b.command);
  if (b.args !== undefined) {
    if (!Array.isArray(b.args) || !b.args.every((a) => typeof a === 'string')) return 'args must be a list of text';
    req.args = b.args as string[];
  }
  const headers = rows(b.headers, 'headers');
  if (typeof headers === 'string') return headers;
  const env = rows(b.env, 'env');
  if (typeof env === 'string') return env;
  req.headers = headers;
  req.env = env;
  req.trustCommand = b.trustCommand === true;
  return req;
}
