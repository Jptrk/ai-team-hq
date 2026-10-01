import fs from 'node:fs';
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

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; source?: { type?: string; media_type?: string; data?: string } };

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

/** Images that passed every check. Nothing is written until save(). */
export interface ReadyImages {
  count: number;
  /** Where they came from, e.g. "figma get_screenshot" or "mock.png". */
  sources: string[];
  /** Write them to the attachments folder. Call once, right before the post that carries them. */
  save(): Attachment[];
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
  if (picked.length + (args.files?.length ?? 0) > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} images at a time.`;
  const files = args.files?.length ? attach(args.files) : null;
  if (typeof files === 'string') return files;
  return {
    count: picked.length + (files?.count ?? 0),
    sources: [...new Set([...picked.map((s) => toolLabel(s.tool)), ...(files?.sources ?? [])])],
    save: () => [...picked.map((s) => save(s.data)), ...(files?.save() ?? [])],
  };
}
