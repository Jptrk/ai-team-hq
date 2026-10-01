---
name: headless-tiptap-checks
description: How to verify TipTap/markdown round-trips in ai-team-hq without a browser or jsdom (no DOM libs installed)
metadata:
  type: reference
---

The repo has no jsdom/happy-dom, but TipTap v3 runs headless in Node for parse/serialize checks:

- Write a `.mts` file in the session scratchpad (plain `.ts` there runs as CJS and top-level await fails).
- Import packages by absolute URL: `await import('file:///C:/Users/patri/Desktop/ai-team-hq/node_modules/@tiptap/core/dist/index.js')` (same for starter-kit, extension-list, extension-table, markdown); app helpers via `file:///.../src/lib/markdownPaste.ts`.
- `new Editor({ element: null, ... })` never mounts. Initial content must be JSON or non-empty markdown with `contentType: 'markdown'`; an empty string falls back to HTML parsing and throws "no window object". Same for `insertContent('plain string')`; pass `{ type: 'text', text }` instead.
- Run from the repo dir: `npx tsx <scratchpad>/x.mts`.

Findings worth re-checking after editor changes: @tiptap/markdown escapes `\ ` * _ [ ] ~` and entity-encodes `& < >` in all text; `setEditable()` emits an update by default. Related: [[review-conventions]].
