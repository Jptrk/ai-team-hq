import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, Italic, Link as LinkIcon, List, ListOrdered, Quote, Strikethrough } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { imageFiles } from '../lib/images';
import { cleanMarkdown, looksLikeDiffOrTerminal, looksLikeMarkdown } from '../lib/markdownPaste';
import { installTypedTextEscaping } from './markdownEscape';
import { takeFocusFrom } from './TextEditor';
import type { EditorHandle, TextEditorProps } from './types';

/**
 * The rich text box, Jira style: **bold**, # heading, - list, > quote, `code` and ``` turn into
 * formatting as you type, pasted markdown is formatted, and Ctrl+B / Ctrl+I / Ctrl+K work.
 * It reads and writes plain markdown. Loaded on first use (see TextEditor).
 */

// Typed text is saved as typed (Q&A, C:\repo, a_b.ts), not as HTML entities and backslashes.
installTypedTextEscaping();

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const LINK_SCHEMES = ['http', 'https', 'mailto'];

function promptLink(editor: Editor): void {
  const previous = (editor.getAttributes('link').href as string | undefined) ?? '';
  const url = window.prompt('Link address (https:// or mailto:)', previous || 'https://');
  if (url === null) return;
  const href = url.trim();
  const chain = editor.chain().focus().extendMarkRange('link');
  if (!href || href === 'https://') chain.unsetLink().run();
  else if (SAFE_LINK.test(href)) chain.setLink({ href }).run();
}

/** Paste text exactly as it is: no markdown, line breaks kept. */
function insertPlainText(editor: Editor, text: string): void {
  const t = text.replace(/\r\n?/g, '\n');
  const { state, view } = editor;
  if (state.selection.$from.parent.type.spec.code) {
    view.dispatch(state.tr.insertText(t).scrollIntoView());
    return;
  }
  const content = t.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]);
  if (content.length) editor.chain().insertContent(content).scrollIntoView().run();
}

function Toolbar({ editor }: { editor: Editor }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
    }),
  });
  // One Tab stop for the whole toolbar; the arrow keys, Home and End move between the buttons.
  const [current, setCurrent] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const buttons: { key: keyof typeof on; label: string; Icon: typeof Bold; run: () => void }[] = [
    { key: 'bold', label: 'Bold (Ctrl+B)', Icon: Bold, run: () => editor.chain().focus().toggleBold().run() },
    { key: 'italic', label: 'Italic (Ctrl+I)', Icon: Italic, run: () => editor.chain().focus().toggleItalic().run() },
    { key: 'strike', label: 'Strikethrough', Icon: Strikethrough, run: () => editor.chain().focus().toggleStrike().run() },
    { key: 'code', label: 'Code (Ctrl+E)', Icon: Code, run: () => editor.chain().focus().toggleCode().run() },
    { key: 'link', label: 'Link (Ctrl+K)', Icon: LinkIcon, run: () => promptLink(editor) },
    { key: 'bullet', label: 'Bulleted list', Icon: List, run: () => editor.chain().focus().toggleBulletList().run() },
    { key: 'ordered', label: 'Numbered list', Icon: ListOrdered, run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: 'quote', label: 'Quote', Icon: Quote, run: () => editor.chain().focus().toggleBlockquote().run() },
  ];
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = buttons.length - 1;
    const moves: Record<string, number> = { ArrowRight: current === last ? 0 : current + 1, ArrowLeft: current === 0 ? last : current - 1, Home: 0, End: last };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setCurrent(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="md-editor-toolbar" role="toolbar" aria-label="Formatting" onKeyDown={onKeyDown}>
      {buttons.map(({ key, label, Icon, run }, i) => (
        <button
          key={key}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          tabIndex={i === current ? 0 : -1}
          className={`icon-btn sm${on?.[key] ? ' on' : ''}`}
          aria-label={label}
          aria-pressed={Boolean(on?.[key])}
          title={label}
          // Keep the text selection: a mousedown on the button would otherwise blur the editor.
          onMouseDown={(e) => e.preventDefault()}
          onFocus={() => setCurrent(i)}
          onClick={run}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

const MarkdownEditor = forwardRef<EditorHandle, TextEditorProps>(function MarkdownEditor(
  { value, onChange, onSubmit, onFiles, placeholder, label, autoFocus, toolbar, minHeight = 64, disabled },
  ref,
) {
  // The editor is created once; callbacks change every render, so read them through refs.
  const props = useRef({ onChange, onSubmit, onFiles });
  props.current = { onChange, onSubmit, onFiles };
  const emitted = useRef(value);
  // Changed by you since the text last came in from outside. Untouched text is handed back as it came.
  const edited = useRef(false);
  // Ctrl+Shift+V was pressed, so the paste that follows goes in as plain text.
  const plainPaste = useRef(false);
  const hint = useRef(placeholder ?? '');
  hint.current = placeholder ?? '';
  const editorRef = useRef<Editor | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Markdown has no underline; Ctrl+U would make text that cannot be saved.
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          // www.example.com and ana@example.com link; javascript:, data: and other schemes never do.
          isAllowedUri: (url, ctx) => {
            const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
            if (scheme && !LINK_SCHEMES.includes(scheme)) return false;
            return Boolean(ctx.defaultValidate(url));
          },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: () => hint.current }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: value,
    contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editable: !disabled,
    editorProps: {
      attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', class: 'md md-compact md-editor-content', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
        const mod = event.ctrlKey || event.metaKey;
        plainPaste.current = mod && event.shiftKey && (event.key === 'v' || event.key === 'V');
        if (mod && event.key === 'Enter') {
          event.preventDefault();
          // Hand over the latest text and let React apply it first, so a fast Ctrl+Enter never sends a stale draft.
          const md = edited.current ? cleanMarkdown(editorRef.current?.getMarkdown() ?? '') : emitted.current;
          emitted.current = md;
          flushSync(() => props.current.onChange(md));
          props.current.onSubmit?.();
          return true;
        }
        if (mod && (event.key === 'k' || event.key === 'K') && editorRef.current) {
          event.preventDefault();
          promptLink(editorRef.current);
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const plain = plainPaste.current;
        plainPaste.current = false;
        const data = event.clipboardData;
        if (!data) return false;
        const text = data.getData('text/plain');
        // Images (a screenshot) go to the tray, where this box takes images. Copying from Office also
        // puts a picture of the selection on the clipboard; when there is text, the text wins.
        const files = imageFiles(data.files);
        if (files.length && !text) {
          if (!props.current.onFiles) return false;
          props.current.onFiles(files);
          return true;
        }
        const ed = editorRef.current;
        if (!ed || !text) return false;
        const inCode = Boolean(view.state.selection.$from.parent.type.spec.code);
        // Ctrl+Shift+V: exactly the text, no formatting.
        if (plain) {
          insertPlainText(ed, text);
          return true;
        }
        // Code from VS Code, a diff or terminal output becomes a code block, never markdown.
        // One line (a name or a path copied from VS Code) stays in the sentence as plain text.
        const fromCodeEditor = data.types.includes('vscode-editor-data');
        if (fromCodeEditor || looksLikeDiffOrTerminal(text)) {
          const code = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
          if (inCode || !code.includes('\n')) insertPlainText(ed, text);
          else ed.commands.insertContent({ type: 'codeBlock', content: [{ type: 'text', text: code }] });
          return true;
        }
        // Markdown typed elsewhere gets formatted. A copy from this editor keeps its own formatting.
        if (!inCode && !data.getData('text/html').includes('data-pm-slice') && looksLikeMarkdown(text)) {
          ed.commands.insertContent(text, { contentType: 'markdown' });
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        // Dropped files are picked up by the composer around the editor, not inserted as text.
        return Boolean((event as DragEvent).dataTransfer?.files.length);
      },
    },
    onUpdate: ({ editor: e, transaction }) => {
      // setEditable reports an update too, and a first focus can add an empty last paragraph on its
      // own. Only a change you made to the text counts, so opening a box never rewrites its text.
      if (!transaction.docChanged) return;
      edited.current = true;
      const md = cleanMarkdown(e.getMarkdown());
      emitted.current = md;
      props.current.onChange(md);
    },
  });
  editorRef.current = editor;

  // Changes from outside (cleared after sending) replace the content.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    edited.current = false;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
    if (value) editor.commands.focus('end');
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  // The plain box shown while this editor loaded had the caret: carry on typing at the end.
  useLayoutEffect(() => {
    if (editor && takeFocusFrom(root.current)) editor.commands.focus('end');
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus('end'),
      insertText: (text) => {
        if (!editor) return;
        const { $from } = editor.state.selection;
        let walled = false;
        for (let d = $from.depth; d > 0; d--) if (['codeBlock', 'tableCell', 'tableHeader'].includes($from.node(d).type.name)) walled = true;
        // Never inside code or a table: the text starts a new paragraph at the end instead.
        if (walled) {
          editor.chain().focus().insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text }] }).run();
          return;
        }
        const before = $from.nodeBefore?.text?.slice(-1) ?? '';
        const after = $from.nodeAfter?.text?.charAt(0) ?? '';
        // One space on each side, never two: "hello @Nora world", not "hello @Nora  world".
        let piece = before && !/\s/.test(before) ? ` ${text}` : text;
        if (/\s$/.test(piece) && /^\s/.test(after)) piece = piece.replace(/\s+$/, '');
        editor.chain().focus().insertContent({ type: 'text', text: piece }).run();
      },
    }),
    [editor],
  );

  return (
    <div ref={root} className={`md-editor${toolbar ? ' with-toolbar' : ''}${disabled ? ' disabled' : ''}`} style={{ ['--md-editor-min' as string]: `${minHeight}px` }}>
      {toolbar && editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
});

export default MarkdownEditor;
