import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import type { Attachment } from '../../shared/types';
import { attachmentsDir, imageBlocks } from '../attachments';

/**
 * Images in a desk's prompt. The founder's newest images go in as image blocks, so the desk
 * always sees them; anything past the cap is listed by path, and the desk can open it with Read.
 */

/** Image blocks per run. Each one costs roughly 1,000-1,600 tokens. */
export const PROMPT_IMAGES = 6;
/** Total file bytes sent inline per run. Base64 adds a third, and resumed sessions keep them, so stay well under the API's request limit. */
export const PROMPT_IMAGE_BYTES = 9_000_000;

/** Where a desk can Read an attachment. */
export function attachmentPath(projectId: string, a: Attachment): string {
  return path.join(attachmentsDir(projectId), a.file);
}

/** " [images: C:\...\att_x.png, ...]" for a line of prompt text, or "" with none. */
export function imageMarker(projectId: string, atts?: Attachment[]): string {
  if (!atts?.length) return '';
  return ` [image${atts.length === 1 ? '' : 's'}: ${atts.map((a) => attachmentPath(projectId, a)).join(', ')}]`;
}

/**
 * Split into the images sent inline and the rest. Inline is the newest ones, added newest first
 * until the count cap or the byte cap would be passed; it keeps the original order.
 */
export function splitImages(images: Attachment[], cap = PROMPT_IMAGES, maxBytes = PROMPT_IMAGE_BYTES): { inline: Attachment[]; rest: Attachment[] } {
  const unique = images.filter((a, i) => images.findIndex((b) => b.id === a.id) === i);
  const inline: Attachment[] = [];
  let bytes = 0;
  for (let i = unique.length - 1; i >= 0 && inline.length < cap; i--) {
    if (bytes + unique[i].size > maxBytes) break;
    bytes += unique[i].size;
    inline.unshift(unique[i]);
  }
  return { inline, rest: unique.filter((a) => !inline.includes(a)) };
}

type UserContent = Exclude<SDKUserMessage['message']['content'], string>;

/**
 * The prompt as content blocks: the text first, then the images. Returns the plain string
 * when there is nothing to show, so runs without images are unchanged.
 */
export function userContent(text: string, projectId: string, images: Attachment[] = []): string | UserContent {
  const { inline, rest } = splitImages(images);
  const blocks = imageBlocks(projectId, inline);
  if (!blocks.length) return text;
  const lines = [text, '', `The founder attached ${blocks.length} image${blocks.length === 1 ? '' : 's'}, shown below.`];
  if (rest.length) lines.push(`More images are on disk; open them with Read if you need them:${imageMarker(projectId, rest)}`);
  return [{ type: 'text', text: lines.join('\n') }, ...blocks] as UserContent;
}

/** A one-message prompt stream, the form query() needs for image blocks. */
export async function* oneMessage(content: UserContent): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}
