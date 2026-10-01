import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Attachment } from '../../shared/types';
import { attachmentsDir, saveUpload, sniffImage } from '../attachments';
import { isInside } from '../paths';

/**
 * Images desks send to the founder.
 *
 * A connected tool (for example Figma's get_screenshot) returns its image inside the tool result.
 * HQ holds the latest few from a run in memory, so the desk can attach them to a comment, a chat
 * message or a decision. Only the ones it attaches are saved. A desk can also attach an image file
 * it can read.
 */

/** Only images from the desk's connections count: never HQ's own tools, never a file it read. */
export function isCaptureTool(name: string): boolean {
  return name.startsWith('mcp__') && !name.startsWith('mcp__hq__');
}

/** "figma get_screenshot" for mcp__figma__get_screenshot, for tool replies. */
export function toolLabel(name: string): string {
  const rest = name.replace(/^mcp__/, '').replace(/^claude_ai_/, '');
  const cut = rest.indexOf('__');
  return cut === -1 ? rest : `${rest.slice(0, cut)} ${rest.slice(cut + 2)}`;
}

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; source?: { type?: string; media_type?: string; data?: string } };

function blocksOf(msg: unknown): Block[] {
  const content = (msg as { message?: { content?: unknown } } | null)?.message?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** tool_use id -> tool name, from an assistant message. */
export function toolUsesIn(msg: unknown): [string, string][] {
  if ((msg as { type?: string } | null)?.type !== 'assistant') return [];
  return blocksOf(msg)
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => [b.id!, b.name!]);
}

/** tool_use ids answered by the tool results in a user message. */
export function toolResultIdsIn(msg: unknown): string[] {
  if ((msg as { type?: string } | null)?.type !== 'user') return [];
  return blocksOf(msg)
    .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map((b) => b.tool_use_id!);
}

/** The tool results in a user message: which tool_use each answers, and whether the tool did its job. */
export function toolResultsIn(msg: unknown): { id: string; ok: boolean }[] {
  if ((msg as { type?: string } | null)?.type !== 'user') return [];
  return blocksOf(msg)
    .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map((b) => ({ id: b.tool_use_id!, ok: b.is_error !== true }));
}

export interface ToolImage {
  tool: string;
  data: Buffer;
}

/** Base64 images inside the tool results of a user message, with the tool that produced each. */
export function toolImagesIn(msg: unknown, toolById: Map<string, string>): ToolImage[] {
  if ((msg as { type?: string } | null)?.type !== 'user') return [];
  const out: ToolImage[] = [];
  for (const block of blocksOf(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const tool = toolById.get(block.tool_use_id);
    if (!tool || !isCaptureTool(tool) || !Array.isArray(block.content)) continue;
    for (const inner of block.content as Block[]) {
      const src = inner?.source;
      if (inner?.type !== 'image' || src?.type !== 'base64' || typeof src.data !== 'string') continue;
      out.push({ tool, data: Buffer.from(src.data, 'base64') });
    }
  }
  return out;
}

export interface Shots {
  /** The latest good images connected tools returned this run, oldest first. Held in memory, never on disk. */
  recent: ToolImage[];
  /** Why the newest image was not kept, to tell the desk when it asks to attach. */
  skipped?: string;
  /** Capture tool calls whose results have not come back yet. */
  pending: Set<string>;
}

/** Why an image cannot be attached, or null when it can. */
function badImage(data: Buffer): string | null {
  if (!data.length) return 'it is empty';
  if (data.length > MAX_ATTACHMENT_BYTES) return 'it is over 3.75 MB';
  if (!sniffImage(data)) return 'it is not a PNG, JPEG, WebP or GIF image';
  return null;
}

/** Hold the images a tool returned. Keeps the newest MAX_ATTACHMENTS; a bad one is skipped with a reason, never thrown. */
export function keepShots(shots: Shots, images: ToolImage[]): void {
  for (const img of images) {
    const why = badImage(img.data);
    if (why) {
      shots.skipped = `The latest screenshot (from ${toolLabel(img.tool)}) was not kept: ${why}. Take another one, or leave screenshots out.`;
      continue;
    }
    shots.recent.push(img);
    if (shots.recent.length > MAX_ATTACHMENTS) shots.recent.splice(0, shots.recent.length - MAX_ATTACHMENTS);
    shots.skipped = undefined;
  }
}

/** Wait, polling every `stepMs`, until no capture result is outstanding. False if one still is after `timeoutMs`. */
export async function waitForShots(shots: Shots, timeoutMs = 3000, stepMs = 25): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (shots.pending.size) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return true;
}

// ---------- screenshots that come back as a link ----------
//
// Figma's online MCP server answers get_screenshot with {"image_url": "https://www.figma.com/api/mcp/asset/….png"}
// instead of the picture. HQ downloads such a link as soon as the result arrives (it expires), then holds the
// image like any other screenshot. Only https links on Figma's hosts, and the storage they redirect to, are fetched.

/** Where a link may start: Figma itself. */
const IMAGE_LINK_HOSTS = [/^(?:www\.)?figma\.com$/i, /\.figma\.com$/i, /\.figmausercontent\.com$/i];
/** Where Figma may send the download on: its own hosts, or the cloud storage that serves the file. */
const REDIRECT_HOSTS = [...IMAGE_LINK_HOSTS, /\.amazonaws\.com$/i];
const LINK_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** The link as a URL if HQ may download it: https, a known image host, no IP address, port or login in it. */
export function allowedImageLink(raw: string, hosts: RegExp[] = IMAGE_LINK_HOSTS): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  return hosts.some((re) => re.test(host)) ? u : null;
}

export interface ToolImageLink {
  /** The tool_use id the link answered. */
  id: string;
  tool: string;
  url: string;
}

function linksInJson(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || !value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && /^(?:image_?url|imageUrl)$/i.test(key)) out.push(v);
    else if (v && typeof v === 'object') linksInJson(v, out, depth + 1);
  }
}

/** Image links (an `image_url` field) in the tool results of a user message, from connected tools only. */
export function toolImageLinksIn(msg: unknown, toolById: Map<string, string>): ToolImageLink[] {
  if ((msg as { type?: string } | null)?.type !== 'user') return [];
  const out: ToolImageLink[] = [];
  for (const block of blocksOf(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const tool = toolById.get(block.tool_use_id);
    if (!tool || !isCaptureTool(tool)) continue;
    const texts = typeof block.content === 'string' ? [block.content] : Array.isArray(block.content) ? (block.content as { type?: string; text?: unknown }[]).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string) : [];
    const found: string[] = [];
    for (const text of texts) {
      try {
        linksInJson(JSON.parse(text), found);
      } catch {
        /* not JSON: links in prose are not picked up */
      }
    }
    for (const url of [...new Set(found)]) if (allowedImageLink(url)) out.push({ id: block.tool_use_id, tool, url });
  }
  return out;
}

export type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

/** Download an image link a connected tool returned. Returns the bytes, or why it could not. Never throws. */
export async function fetchImageLink(url: string, fetchImpl: FetchLike = fetch, timeoutMs = LINK_TIMEOUT_MS): Promise<Buffer | string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = allowedImageLink(url);
  if (!current) return 'the link is not on a host HQ downloads images from';
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current.href, { redirect: 'manual', signal });
    } catch {
      return 'the download failed or took too long';
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let next: URL | null = null;
      try {
        next = location ? allowedImageLink(new URL(location, current).href, REDIRECT_HOSTS) : null;
      } catch {
        next = null;
      }
      if (!next) return 'the link redirected somewhere HQ does not download from';
      current = next;
      continue;
    }
    if (!res.ok) return `the download failed (HTTP ${res.status})`;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) return 'it is over 3.75 MB';
    const reader = res.body?.getReader();
    if (!reader) return 'the download was empty';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_ATTACHMENT_BYTES) {
          await reader.cancel().catch(() => undefined);
          return 'it is over 3.75 MB';
        }
        chunks.push(value);
      }
    } catch {
      return 'the download failed or took too long';
    }
    return Buffer.concat(chunks);
  }
  return 'the link redirected too many times';
}

/**
 * Download the image links in one user message and hold them like inline screenshots. Each tool call stays
 * pending until its downloads finish, so an attach in the same turn waits for them.
 */
export function keepLinkedShots(shots: Shots, links: ToolImageLink[], fetchImpl: FetchLike = fetch): Promise<void> {
  const byId = new Map<string, ToolImageLink[]>();
  for (const l of links) byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
  return Promise.all(
    [...byId.entries()].map(async ([id, list]) => {
      shots.pending.add(id);
      try {
        const results = await Promise.all(list.map((l) => fetchImageLink(l.url, fetchImpl)));
        results.forEach((r, i) => {
          if (typeof r === 'string') shots.skipped = `The latest screenshot (from ${toolLabel(list[i].tool)}) could not be downloaded: ${r}. Take another one, or leave screenshots out.`;
          else keepShots(shots, [{ tool: list[i].tool, data: r }]);
        });
      } finally {
        shots.pending.delete(id);
      }
    }),
  ).then(() => undefined);
}

// ---------- images from the open web ----------
//
// A desk can attach a public image by its address (urls: [...]). HQ downloads it itself: https only, and every
// address the name resolves to must be on the public internet, checked when the connection is made, so a link
// can never reach this machine or the local network. Redirects get the same checks.

/** False for loopback, private, link-local, carrier-grade NAT, documentation, multicast and reserved ranges. */
export function isPublicAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && /^192\.0\.[02]\./.test(ip)))) return false;
    if (a === 198 && (b === 18 || b === 19 || /^198\.51\.100\./.test(ip))) return false;
    if (/^203\.0\.113\./.test(ip)) return false;
    return true;
  }
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPublicAddress(mapped[1]);
    if (v6 === '::' || v6 === '::1') return false;
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

/** The address as a URL if HQ may try it: https, no login, the normal port, a name rather than a raw IP. */
export function webImageUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) || u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || !u.hostname.includes('.')) return null;
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup that refuses any name resolving to a non-public address. Runs at connect time, so it holds against DNS tricks. */
function publicLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('not a public address'), { code: 'EPRIVATE' }));
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

function getOnce(u: URL, timeoutMs: number): Promise<{ status: number; location?: string; body?: Buffer | string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { status: number; location?: string; body?: Buffer | string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = https.get(u, { lookup: publicLookup as never, timeout: timeoutMs, headers: { 'user-agent': 'AI-Team-HQ/1.0', accept: 'image/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish({ status, location: res.headers.location });
      }
      if (status !== 200) {
        res.resume();
        return finish({ status });
      }
      if (Number(res.headers['content-length'] ?? 0) > MAX_ATTACHMENT_BYTES) {
        res.destroy();
        return finish({ status, body: 'it is over 3.75 MB' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_ATTACHMENT_BYTES) {
          res.destroy();
          finish({ status, body: 'it is over 3.75 MB' });
        } else chunks.push(c);
      });
      res.on('end', () => finish({ status, body: Buffer.concat(chunks) }));
      res.on('error', () => finish({ status, body: 'the download failed' }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) =>
      finish({ status: 0, body: e.code === 'EPRIVATE' ? 'that address is not on the public internet' : e.code === 'ETIMEDOUT' ? 'the download took too long' : 'the download failed' }),
    );
  });
}

/** Download one public image. The bytes, or why not. Never throws. */
export async function fetchWebImage(raw: string, timeoutMs = LINK_TIMEOUT_MS): Promise<Buffer | string> {
  let current = webImageUrl(raw);
  if (!current) return 'only https addresses of public websites can be attached';
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await getOnce(current, timeoutMs);
    if (r.status >= 300 && r.status < 400) {
      let next: URL | null = null;
      try {
        next = r.location ? webImageUrl(new URL(r.location, current).href) : null;
      } catch {
        next = null;
      }
      if (!next) return 'it redirected somewhere HQ does not download from';
      current = next;
      continue;
    }
    if (typeof r.body === 'string') return r.body;
    if (r.status !== 200 || !r.body) return `the download failed (HTTP ${r.status})`;
    return r.body;
  }
  return 'it redirected too many times';
}

export interface WebImage {
  /** Where it came from, e.g. "images.pexels.com", shown under the post. */
  source: string;
  data: Buffer;
}

/** Download and check every address a desk asked for. All or nothing, with a reason naming the one that failed. */
export async function webImages(urls: string[] | undefined, fetchOne: (url: string) => Promise<Buffer | string> = fetchWebImage): Promise<WebImage[] | string> {
  const list = [...new Set(urls ?? [])];
  if (list.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} images at a time.`;
  const results = await Promise.all(list.map((u) => fetchOne(u)));
  const out: WebImage[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = results[i];
    let host = list[i];
    try {
      host = new URL(list[i]).hostname;
    } catch {
      /* keep it as given */
    }
    if (typeof r === 'string') return `Could not attach the image from ${host}: ${r}.`;
    const why = badImage(r);
    if (why) {
      return why === 'it is not a PNG, JPEG, WebP or GIF image'
        ? `The address from ${host} is not an image file (it may be a web page). Use the image's own address, for example the one that ends in .jpg or .png.`
        : `Could not attach the image from ${host}: ${why}.`;
    }
    out.push({ source: host, data: r });
  }
  return out;
}

/** Images that passed every check. Nothing is written until save(). */
export interface ReadyImages {
  count: number;
  /** Where they came from, e.g. "figma get_screenshot" or "mock.png". */
  sources: string[];
  /** Write them to the attachments folder. Call once, right before the post that carries them. */
  save(): Attachment[];
  /** For images from the web, a credit line HQ adds under the post, e.g. "Image from images.pexels.com". */
  note?: string;
}

/** The post's text with the credit line for web images, if any. */
export function withImageNote(text: string, ready: Pick<ReadyImages, 'note'>): string {
  return ready.note ? `${text}\n\n*${ready.note}*` : text;
}

/** Real paths of the roots that exist. */
function realRoots(roots: string[]): string[] {
  return roots.flatMap((r) => {
    try {
      return [fs.realpathSync.native(r)];
    } catch {
      return [];
    }
  });
}

/**
 * Image files a desk asked to attach, by path. Each must be inside one of `roots` (its workspace,
 * the project folder, the attachments folder), also once links are followed, be a real
 * PNG/JPEG/WebP/GIF, and fit the size cap. Every file is checked before any is copied; files
 * already in the attachments folder are reused, others are copied in by save().
 */
export function attachFiles(projectId: string, agentId: string, files: string[], roots: string[], baseDir: string): ReadyImages | string {
  const real = realRoots(roots);
  const [own] = realRoots([attachmentsDir(projectId)]);
  const checked: { name: string; buf: Buffer; reuse?: Attachment }[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const abs = path.resolve(baseDir, f);
    if (!roots.some((r) => isInside(abs, r))) return `${f} is outside the folders you can read.`;
    let target: string;
    try {
      target = fs.realpathSync.native(abs);
    } catch {
      return `${f} does not exist.`;
    }
    // A link inside a root can point anywhere; the file it lands on must be inside a root too.
    if (!real.some((r) => isInside(target, r))) return `${f} is outside the folders you can read.`;
    if (seen.has(target)) continue;
    seen.add(target);
    const stat = fs.statSync(target);
    if (!stat.isFile()) return `${f} is not a file.`;
    if (stat.size > MAX_ATTACHMENT_BYTES) return `${f} is over 3.75 MB. Attach a smaller image.`;
    const buf = fs.readFileSync(target);
    const type = sniffImage(buf);
    if (!type) return `${f} is not a PNG, JPEG, WebP or GIF image.`;
    const name = path.basename(target);
    const m = own && isInside(target, own) ? /^(att_[a-f0-9]{12})\.(png|jpg|webp|gif)$/.exec(name) : null;
    checked.push({ name, buf, reuse: m ? { id: m[1], file: name, type, size: stat.size, by: agentId, ts: stat.mtime.toISOString() } : undefined });
  }
  return {
    count: checked.length,
    sources: checked.map((c) => c.name),
    save: () => checked.map((c) => c.reuse ?? saveUpload(projectId, c.buf, agentId)),
  };
}

/**
 * The images for one tool call: the latest `screenshots` held this run, then `files`. At most six.
 * Everything is checked first; save() then writes only what is attached.
 * Returns an error message for the desk when it cannot be done.
 */
export function deskImages(
  args: { screenshots?: number; files?: string[] },
  shots: Shots,
  attach: (files: string[]) => ReadyImages | string,
  save: (data: Buffer) => Attachment,
  /** Images already downloaded from the web (urls), checked by webImages. */
  web: WebImage[] = [],
): ReadyImages | string {
  const want = args.screenshots ?? 0;
  let picked: ToolImage[] = [];
  if (want > 0) {
    // The newest capture was refused: say so, never attach an older one in its place.
    if (shots.skipped) return shots.skipped;
    if (!shots.recent.length) {
      return 'No screenshot was taken in this run yet. Take one with a connected tool first (for example Figma get_screenshot), then attach it with screenshots: 1.';
    }
    picked = shots.recent.slice(-want);
  }
  if (picked.length + (args.files?.length ?? 0) + web.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} images at a time.`;
  const files = args.files?.length ? attach(args.files) : null;
  if (typeof files === 'string') return files;
  const hosts = [...new Set(web.map((w) => w.source))];
  return {
    count: picked.length + (files?.count ?? 0) + web.length,
    sources: [...new Set([...picked.map((s) => toolLabel(s.tool)), ...(files?.sources ?? []), ...hosts])],
    save: () => [...picked.map((s) => save(s.data)), ...(files?.save() ?? []), ...web.map((w) => save(w.data))],
    ...(hosts.length ? { note: `Image${web.length === 1 ? '' : 's'} from ${hosts.join(', ')}` } : {}),
  };
}
