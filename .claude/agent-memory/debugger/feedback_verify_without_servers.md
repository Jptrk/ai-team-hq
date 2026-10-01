---
name: verify-without-servers
description: How to verify fixes in ai-team-hq without starting servers, calling MCP tools, or spending model usage
metadata:
  type: feedback
---

When fixing review findings in ai-team-hq, never start the dev/API servers, never call MCP tools, and never run anything that reaches a model. Verify with `npx tsc --noEmit`, `npm run test:attachments`, `npm run test:chat`, `npm run test:guard`, `npm run test:ui`, and `npm run build`; for extra checks, write throwaway tsx scripts in the session scratchpad that import pure helpers.

**Why:** agent runs spend the founder's Claude subscription usage (see [[no-api-billing-subscription-only]]), and MCP actions post as the founder's own accounts.

**How to apply:** for logic that lives inside SDK tool handlers (e.g. report_done), pull the decision into a small exported pure function and test that from server/guard.test.ts, which already imports server/runner/claude.ts. Logic inside runner/index.ts execute() (calls the real runner) is tested the same way, via a helper in server/chat.ts tested from chat.test.ts. There is no git repo, so report changes by file:line.

Before editing anything under server/ or shared/, run `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4747 -State Listen -ErrorAction SilentlyContinue"`. If it prints a listener, stop and report: the dev API runs under `node --watch` on server/ and shared/, and a restart kills live agent runs. Exit code 1 with no output means nothing is listening. Scratch scripts never go under server/ or shared/ for the same reason.

When the server is live, the coordinator may instead hand over a staging copy (scratchpad `hq-stage`, node_modules a junction to the real repo). Work only there, and report an exact created/changed/deleted list for a batch copy. The staging `.git` is stale, so md5-snapshot the files before editing and diff afterwards. `npm run build` briefly writes `node_modules/.vite-temp` (Vite's bundled config); it empties again, so mention it rather than avoid it. Delete `dist/` afterwards.

An Express route can be checked without a listener: a probe in the scratchpad chdirs to a temp dir, imports `server/store.ts` and `server/routes.ts` through `pathToFileURL(...).href` (plain Windows paths fail as ESM specifiers), creates a project, then calls `router(req, res, next)` with a mock `{ method, url }` request and a `res` that has `locals`, `status()` and `json()`.
