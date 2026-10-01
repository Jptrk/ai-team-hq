---
name: review-conventions
description: How reviews are requested and reported in ai-team-hq (read-only, findings format, allowed commands, scratch-copy diffs)
metadata:
  type: feedback
---

Reviews in ai-team-hq are read-only: no file edits, no servers, no MCP calls, nothing that calls a model. Allowed: `npx tsc --noEmit -p .`, `npm run test:ui|test:chat|test:attachments|test:guard|test:huddles`, `npm run build` (offline).

Since 2026-10-01 the repo is a git repo, and changes often arrive as a changed copy in the session scratchpad (LF endings, `node_modules` symlinked to the repo). Diff with `diff -u --strip-trailing-cr <repo file> <scratch file>`; never run git commands that change anything.

Report each finding with file:line, severity, a concrete failure scenario and a suggested fix; verify every claim against the code; say plainly what is fine; skip style nits.

**Why:** the founder's requests ask for exactly this format and want real bugs, not taste.
**How to apply:** prove behavior with scratchpad scripts (see [[headless-tiptap-checks]], [[huddle-engine-review-checks]]) instead of guessing. Do not rebuild `dist/` when the existing build is newer than the sources; check timestamps first.
