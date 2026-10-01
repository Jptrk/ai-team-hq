import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Attachment, type State } from '../shared/types';
import { isInside } from './paths';
import { now, projectDataDir } from './store';

/**
 * Images you paste into chat, tickets, notes and comments.
 *
 *   data/projects/<project>/attachments/att_<hex>.<ext>
 *
 * Only PNG, JPEG, WebP and GIF, checked from the file's first bytes (never the name or the
 * request's Content-Type). No SVG: it can carry script. db.json stores metadata only.
 */

const EXT: Record<Attachment['type'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const FILE_NAME = /^(att_[a-f0-9]{12})\.(png|jpg|webp|gif)$/;
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export class AttachmentError extends Error {}

export function attachmentsDir(projectId: string): string {
  return path.join(projectDataDir(projectId), 'attachments');
}

/** The real image type from the first bytes, or null for anything else. */
export function sniffImage(buf: Buffer): Attachment['type'] | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

function readHead(abs: string, bytes = 12): Buffer {
  const fd = fs.openSync(abs, 'r');
  try {
    const head = Buffer.alloc(bytes);
    const n = fs.readSync(fd, head, 0, bytes, 0);
    return head.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Save an upload. Throws AttachmentError with a message fit for the founder. */
export function saveUpload(projectId: string, buf: Buffer, by: string): Attachment {
  if (!buf.length) throw new AttachmentError('The image is empty.');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError('Images can be at most 3.75 MB.');
  const type = sniffImage(buf);
  if (!type) throw new AttachmentError('Only PNG, JPEG, WebP and GIF images can be attached.');
  const id = `att_${crypto.randomBytes(6).toString('hex')}`;
  const file = `${id}.${EXT[type]}`;
  const dir = attachmentsDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf, { flag: 'wx' });
  return { id, file, type, size: buf.length, by, ts: now() };
}

/** Absolute path for a file name from a URL, only if it is one of ours. */
export function resolveAttachment(projectId: string, file: string): string | null {
  if (!FILE_NAME.test(file)) return null;
  const dir = attachmentsDir(projectId);
  const abs = path.resolve(dir, file);
  return isInside(abs, dir) && abs !== dir ? abs : null;
}

function filesById(projectId: string): Map<string, string> {
  const dir = attachmentsDir(projectId);
  const map = new Map<string, string>();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir)) {
    const m = FILE_NAME.exec(name);
    if (m) map.set(m[1], name);
  }
  return map;
}

/**
 * Turn ids sent by the browser into attachments. Every id must be a file that is really
 * there and really an image; size and type come from the file, not from the request.
 */
export function pickAttachments(projectId: string, raw: unknown, by: string): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw new AttachmentError('attachments must be a list of image ids');
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_ATTACHMENTS) throw new AttachmentError(`At most ${MAX_ATTACHMENTS} images at a time.`);
  if (!ids.length) return [];
  const files = filesById(projectId);
  return ids.map((id) => {
    const file = files.get(id);
    if (!file) throw new AttachmentError('An image was not found on the server. Paste it again.');
    const abs = path.join(attachmentsDir(projectId), file);
    const type = sniffImage(readHead(abs));
    if (!type) throw new AttachmentError('An attached file is not an image.');
    const stat = fs.statSync(abs);
    return { id, file, type, size: stat.size, by, ts: stat.mtime.toISOString() };
  });
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: Attachment['type']; data: string };
}

/** Image content blocks for a prompt. Files that went missing are skipped. */
export function imageBlocks(projectId: string, atts: Attachment[]): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const a of atts) {
    const abs = resolveAttachment(projectId, a.file);
    if (!abs || !fs.existsSync(abs)) continue;
    out.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: fs.readFileSync(abs).toString('base64') } });
  }
  return out;
}

/** Every attachment file the project still points at. */
export function referencedFiles(s: State): Set<string> {
  const files = new Set<string>();
  const add = (list?: Attachment[]) => {
    for (const a of list ?? []) files.add(a.file);
  };
  for (const m of s.messages) add(m.attachments);
  for (const i of s.instructions) add(i.attachments);
  for (const item of s.items) {
    add(item.attachments);
    for (const c of item.comments ?? []) add(c.attachments);
  }
  return files;
}

/**
 * Delete images nothing points at any more: pastes removed before sending, and messages
 * past the 1500-message cap. Anything newer than a day is kept, in case it is mid-send.
 */
export function sweepAttachments(projectId: string, s: State, nowMs = Date.now(), maxAgeMs = SWEEP_AGE_MS): number {
  const dir = attachmentsDir(projectId);
  if (!fs.existsSync(dir)) return 0;
  const keep = referencedFiles(s);
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!FILE_NAME.test(name) || keep.has(name)) continue;
    const abs = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(abs).mtimeMs < maxAgeMs) continue;
      fs.rmSync(abs);
      removed += 1;
    } catch {
      /* in use or already gone */
    }
  }
  return removed;
}
