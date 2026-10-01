import { forwardRef, lazy, Suspense, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { imageFiles } from '../lib/images';
import type { EditorHandle, TextEditorProps } from './types';

/**
 * The plain box that has the caret, and where. The rich editor that takes its place (same spot
 * in the page) carries on there, so typing while the editor loads never loses focus.
 */
let focused: { parent: Element | null; caret: number } | null = null;

/** For an editor just put in the page: did the plain box it replaces have the caret? Answers once. */
export function takeFocusFrom(el: Element | null): { caret: number } | null {
  const hit = focused && el?.parentElement && focused.parent === el.parentElement ? focused : null;
  if (hit) focused = null;
  return hit;
}

/** A plain textarea: shown while the rich editor loads, when it cannot load, and for `plain` text. */
const PlainBox = forwardRef<EditorHandle, TextEditorProps>(function PlainBox({ value, onChange, onSubmit, onFiles, placeholder, label, autoFocus, minHeight = 64, disabled }, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  // True while React takes the box out of the page, when a browser may report a blur the user did not cause.
  const leaving = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => box.current?.focus(),
      insertText: (text) => {
        onChange(`${value}${value && !/\s$/.test(value) ? ' ' : ''}${text}`);
        box.current?.focus();
      },
    }),
    [value, onChange],
  );
  useLayoutEffect(() => {
    leaving.current = false;
    const el = box.current;
    // Taking over from another plain box that had the caret (the rich editor did not load).
    const from = takeFocusFrom(el);
    if (el && from) {
      el.focus();
      el.setSelectionRange(from.caret, from.caret);
    }
    return () => {
      leaving.current = true;
      if (el && focused && document.activeElement === el) focused.caret = el.selectionStart;
    };
  }, []);
  return (
    <textarea
      ref={box}
      className="md-editor-fallback"
      style={{ minHeight }}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        focused = { parent: e.currentTarget.parentElement, caret: e.currentTarget.selectionStart };
      }}
      onBlur={() => {
        if (!leaving.current) focused = null;
      }}
      onPaste={(e) => {
        const files = imageFiles(e.clipboardData?.files);
        if (files.length && !e.clipboardData.getData('text/plain')) {
          e.preventDefault();
          onFiles?.(files);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit?.();
        }
      }}
    />
  );
});

// If the editor's file cannot be fetched (offline, a deploy replaced it), the plain box stays instead of the page breaking.
const MarkdownEditor = lazy(() => import('./MarkdownEditor').catch(() => ({ default: PlainBox })));

/**
 * Every text box you write in: chat, Create, comments, notes, descriptions. The rich editor
 * loads the first time one opens; until then a plain box works the same way, so typing never waits.
 */
export const TextEditor = forwardRef<EditorHandle, TextEditorProps>(function TextEditor(props, ref) {
  if (props.plain) return <PlainBox {...props} ref={ref} />;
  return (
    <Suspense fallback={<PlainBox {...props} ref={ref} />}>
      <MarkdownEditor {...props} ref={ref} />
    </Suspense>
  );
});

export type { EditorHandle, TextEditorProps };
