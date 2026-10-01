import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { escapeTypedText } from '../lib/markdownPaste';

interface TypedTextWriter {
  codeTypes: Set<string>;
  encodeTextForMarkdown: (text: string, node: JSONContent, parentNode?: JSONContent) => string;
}

let installed = false;

/**
 * @tiptap/markdown saves typed text with & < > as HTML entities and every \ ` * _ [ ] ~ escaped,
 * so "Q&A in C:\repo" came out as "Q&amp;A in C:\\repo" for the desks, titles and search.
 * This keeps text as typed and escapes only what would turn into formatting (escapeTypedText).
 * It patches the prototype, once, because the editor writes markdown before onCreate runs.
 */
export function installTypedTextEscaping(): void {
  if (installed) return;
  installed = true;
  const proto = MarkdownManager.prototype as unknown as TypedTextWriter;
  proto.encodeTextForMarkdown = function encodeTextForMarkdown(this: TypedTextWriter, text, node, parentNode) {
    // Code keeps every character as it is.
    const inCode =
      (parentNode?.type != null && this.codeTypes.has(parentNode.type)) ||
      (node.marks ?? []).some((m: { type: string } | string) => this.codeTypes.has(typeof m === 'string' ? m : m.type));
    return inCode ? text : escapeTypedText(text);
  };
}
