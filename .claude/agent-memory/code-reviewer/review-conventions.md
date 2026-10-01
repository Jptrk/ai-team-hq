---
name: review-conventions
description: How reviews are requested and reported in ai-team-hq (read-only, findings format, allowed commands)
metadata:
  type: feedback
---

Reviews in ai-team-hq are read-only: no file edits, no servers, no MCP calls, nothing that calls a model. Allowed: `npx tsc --noEmit`, `npm run test:ui|test:chat|test:attachments|test:guard`, `npm run build` (offline). There is no git repo, so review the named files directly.

Report each finding with file:line, severity, a concrete failure scenario and a suggested fix; verify every claim against the code; skip style nits.

**Why:** the founder's requests ask for exactly this format and want real bugs, not taste.
**How to apply:** prove behavior with scratchpad scripts (see [[headless-tiptap-checks]]) instead of guessing. Do not rebuild `dist/` when the existing build is newer than the sources; check timestamps first.
