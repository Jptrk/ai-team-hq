export interface TextEditorProps {
  /** Markdown. What you type is kept as markdown, so desks and the rest of HQ read it as before. */
  value: string;
  onChange: (markdown: string) => void;
  /** Ctrl+Enter (Cmd+Enter on a Mac). */
  onSubmit?: () => void;
  /** Images pasted or dropped onto the text. They go to the thumbnail tray, never into the text. */
  onFiles?: (files: File[]) => void;
  placeholder?: string;
  /** Accessible name, e.g. "Reply". */
  label: string;
  autoFocus?: boolean;
  /** Bold, italic, code, link, lists, quote buttons above the text. */
  toolbar?: boolean;
  /** Smallest height in px before the box grows with its text. */
  minHeight?: number;
  disabled?: boolean;
  /** Edit the markdown as it is in a plain box, for text the rich editor cannot keep (images, HTML). */
  plain?: boolean;
}

export interface EditorHandle {
  focus: () => void;
  /** Put text (an @mention) where the caret is, never inside code or a table. */
  insertText: (text: string) => void;
}
