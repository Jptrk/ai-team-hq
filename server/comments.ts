import type { Attachment, Comment, WorkItem } from '../shared/types';
import { now, uid } from './store';

/** Oldest comments drop off past this, like the message cap. */
const MAX_COMMENTS = 200;

/** Add a comment to a ticket. Desks comment here instead of rewriting the description. */
export function addComment(item: WorkItem, c: Pick<Comment, 'from' | 'text'> & Partial<Pick<Comment, 'attachments' | 'kind' | 'title'>>): Comment {
  const comment: Comment = { id: uid('cmt'), ts: now(), from: c.from, text: c.text };
  if (c.attachments?.length) comment.attachments = c.attachments;
  if (c.kind && c.kind !== 'comment') comment.kind = c.kind;
  if (c.title) comment.title = c.title;
  item.comments = [...(item.comments ?? []), comment].slice(-MAX_COMMENTS);
  return comment;
}

/** A plain comment of yours (not an Instruct or Send back note) newer than the desk's own latest comment on this ticket. */
export function unansweredComment(item: WorkItem, agentId: string): boolean {
  const comments = item.comments ?? [];
  const answered = comments.reduce((latest, c) => (c.from === agentId && c.ts > latest ? c.ts : latest), '');
  return comments.some((c) => c.from === 'you' && (!c.kind || c.kind === 'comment') && c.ts > answered);
}

/** Images on the founder's comments (any kind) newer than the desk's own latest comment on this ticket. */
export function unansweredImages(item: WorkItem, agentId: string): Attachment[] {
  const comments = item.comments ?? [];
  const answered = comments.reduce((latest, c) => (c.from === agentId && c.ts > latest ? c.ts : latest), '');
  return comments.filter((c) => c.from === 'you' && c.ts > answered).flatMap((c) => c.attachments ?? []);
}
