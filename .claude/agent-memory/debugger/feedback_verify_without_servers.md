---
name: verify-without-servers
description: How to verify fixes in ai-team-hq without starting servers, calling MCP tools, or spending model usage; when editing server/ is safe while 4747 listens
metadata:
  type: feedback
---

When fixing review findings in ai-team-hq, never start the dev/API servers, never call MCP tools, and never run anything that reaches a model. Verify with `npx tsc --noEmit -p .` and the `npm run test:*` suites (account, settings, timeouts, ui, mcp, guard, auto, chat, attachments); for extra checks, write throwaway tsx scripts in the session scratchpad that import pure helpers.

**Why:** agent runs spend the founder's Claude subscription usage (see [[no-api-billing-subscription-only]]), and MCP actions post as the founder's own accounts.

**How to apply:** for logic that lives inside SDK tool handlers (e.g. report_done), pull the decision into a small exported pure function and test that from server/guard.test.ts, which already imports server/runner/claude.ts. Logic inside runner/index.ts execute() (calls the real runner) is tested the same way, via a helper in server/chat.ts tested from chat.test.ts. The repo is a git repo now (2026-10-06): report changes with `git status`/`git diff`.

Before editing anything under server/ or shared/, check what listens on 4747 (`Get-NetTCPConnection -LocalPort 4747 -State Listen`). The danger is `npm run dev` (`node --watch` on server/ and shared/): an edit restarts it and kills live agent runs, so stop and report. `npm start` (tsx, no --watch) does not restart on edits, so editing is safe then, but never run `npm run build`: it rewrites dist/, which `npm start` serves. On 2026-10-06 the coordinator confirmed the listener was `npm start` and allowed edits. Scratch scripts never go under server/ or shared/.

Parallel agents may edit the same tree (seen 2026-10-06: an MCP-guard fixer touched server/mcp.ts and README while I worked). Use exact-string edits, never whole-file rewrites of shared files, and re-check `git status` before reporting.

When the server is live, the coordinator may instead hand over a staging copy (scratchpad `hq-stage`, node_modules a junction to the real repo). Work only there, and report an exact created/changed/deleted list for a batch copy. `npm run build` briefly writes `node_modules/.vite-temp`; delete `dist/` afterwards.

An Express route can be checked without a listener: import `server/routes.ts` after chdir to a temp dir and call `router(req, res, next)` with a mock `{ method, url, headers, query, get }` request and a `res` with `locals`, `status()` and `json()` (server/account.test.ts has an `api()` helper that does this, with a headers argument).
