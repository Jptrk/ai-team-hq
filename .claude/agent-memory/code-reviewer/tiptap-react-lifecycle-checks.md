---
name: tiptap-react-lifecycle-checks
description: useEditor destroy timer vs Suspense reveal throttle, what a destroyed TipTap editor still allows, EditorContent sync flush, rAF focus
metadata:
  type: reference
---

Facts checked in node_modules (@tiptap/react + core 3.31.4, react-dom 19.3.0) during the 2026-10-15 review of the `live(editor)` fix in src/editor/MarkdownEditor.tsx:

- useEditor makes the editor during render and arms `scheduleDestroy()` (setTimeout 1 ms). Only the passive `onRender` effect claims it. A Suspense reveal in a retry lane is throttled (`globalMostRecentFallbackTime + 300` in react-dom-client), so the timer can destroy it before commit; useSyncExternalStore only notices in its passive effect, then onRender makes a replacement.
- `Editor.isDestroyed` is `editorView?.isDestroyed ?? true`. `editorView` is null only after `unmount()` (only `destroy()` calls it) or with `element: null`; default element is a detached div, so a live editor reads false.
- Destroyed editor: `commands` getter throws (commandManager null); `chain()`/`can()` return fakes; `state` returns the saved editorState (so `isActive`/`getAttributes` still work); `view` is a Proxy that throws for most keys.
- `EditorContent.init()` skips destroyed editors. When it does mount a live one it calls `forceUpdate()` in componentDidMount, a sync update in layout, so React flushes passive effects in the same task: an editor alive at layout is always claimed before the timer.
- The `focus` command focuses in `requestAnimationFrame` on desktop, so the plain-box to rich-editor caret handoff is always deferred; keys typed in between land on body (pre-existing, not from the fix).

**How to apply:** for any change around useEditor, Suspense, or the takeFocusFrom handoff, check that `takeFocusFrom` is only called for a live editor (short-circuit order) and that no effect touches `editor.commands` without a destroyed check. Related: [[headless-tiptap-checks]], [[ui-dialog-review-checks]].
