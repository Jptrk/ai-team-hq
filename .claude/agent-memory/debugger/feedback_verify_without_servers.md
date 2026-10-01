---
name: verify-without-servers
description: How to verify fixes in ai-team-hq without starting servers, calling MCP tools, or spending model usage
metadata:
  type: feedback
---

When fixing review findings in ai-team-hq, never start the dev/API servers, never call MCP tools, and never run anything that reaches a model. Verify with `npx tsc --noEmit`, `npm run test:attachments`, `npm run test:chat`, `npm run test:guard`, `npm run test:ui`, and `npm run build`; for extra checks, write throwaway tsx scripts in the session scratchpad that import pure helpers.

**Why:** agent runs spend the founder's Claude subscription usage (see [[no-api-billing-subscription-only]]), and MCP actions post as the founder's own accounts.

**How to apply:** for logic that lives inside SDK tool handlers (e.g. report_done), pull the decision into a small exported pure function and test that from server/guard.test.ts, which already imports server/runner/claude.ts. There is no git repo, so report changes by file:line.
