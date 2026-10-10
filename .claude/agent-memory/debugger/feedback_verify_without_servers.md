---
name: verify-without-servers
description: How to verify fixes in ai-team-hq without starting servers, calling MCP tools, or spending model usage; when editing server/ is safe while 4747 listens
metadata:
  type: feedback
---

When fixing review findings in ai-team-hq, never start the dev/API servers, never call MCP tools, and never run anything that reaches a model. Verify with `npx tsc --noEmit -p .` and the `npm run test:*` suites (auth, account, settings, timeouts, ui, mcp, guard, auto, chat, attachments; test:mcp holds the requestGuard cases); for extra checks, write throwaway tsx scripts in the session scratchpad that import pure helpers.

**Why:** agent runs spend the founder's Claude subscription usage (see [[no-api-billing-subscription-only]]), and MCP actions post as the founder's own accounts.

**How to apply:** for logic that lives inside SDK tool handlers (e.g. report_done), pull the decision into a small exported pure function and test that from server/guard.test.ts, which already imports server/runner/claude.ts. Logic inside runner/index.ts execute() (calls the real runner) is tested the same way, via a helper in server/chat.ts tested from chat.test.ts. The repo is a git repo now (2026-10-06): report changes with `git status`/`git diff`.

Before editing anything under server/ or shared/, check what listens on 4747 (`Get-NetTCPConnection -LocalPort 4747 -State Listen`). The danger is `npm run dev` (`node --watch` on server/ and shared/): an edit restarts it and kills live agent runs, so stop and report. `npm start` (tsx, no --watch) does not restart on edits, so editing is safe then, but never run `npm run build`: it rewrites dist/, which `npm start` serves. On 2026-10-06 the coordinator confirmed the listener was `npm start` and allowed edits. Scratch scripts never go under server/ or shared/.

Parallel agents may edit the same tree (seen 2026-10-06: an MCP-guard fixer touched server/mcp.ts and README while I worked). Use exact-string edits, never whole-file rewrites of shared files, and re-check `git status` before reporting.

When the server is live, the coordinator may instead hand over a staging copy (scratchpad `hq-stage`, node_modules a junction to the real repo). Work only there, and report an exact created/changed/deleted list for a batch copy. `npm run build` briefly writes `node_modules/.vite-temp`; delete `dist/` afterwards.

Under `npm run dev` with no runs going, the same staging trick keeps restarts to one (2026-10-09): copy server/ shared/ src/ scripts/ + tsconfig/package.json/README into scratchpad `hq-stage` with a node_modules junction, edit there, pass `tsc` and every suite there, re-check runs, then `cp` the changed files back in one command and `diff -rq` repo vs stage. Remove the junction with `cmd /c rmdir` (never `rm -rf`). Note: under `npm run dev` the process listening on 4747 is the watch child, whose command line reads `node --import tsx server/index.ts` (no `--watch`); don't take that for `npm start`. Check the parent PID's command line too.

A coordinator brief can name the wrong mode: on 2026-10-09 (project-removal fixes) it said "`npm start`, no watcher" while the parent was `node --watch`. Trust the process table, not the brief. "Runs going" = read-only GETs on the live server: `/api/projects` (`running` per project) plus each `/api/projects/<id>/state` (runs queued/running, huddles running, agents running). Do it right before the one copy-back, and confirm 4747 answers again after (new PID).

server/codex.test.ts has no fake runner for Claude: a Claude-project (`pc`) run there goes to the real claudeRunner. To test a queued Claude start there (2026-10-10), make Claude ready as its "real cause" test does (CLAUDE_CODE_OAUTH_TOKEN + setClaudeLogin(true)), occupy the desk with `enqueue(`${pc.id}:${desk}`, blocker)` from runner/queue, mark the run done before freeing the blocker, then drop it from `pc.state.runs` (a later test asserts pc has none). server/autopilot.test.ts can instead create a `provider: 'gpt'` project, since its fake runner serves both models.

An Express route can be checked without a listener: import `server/routes.ts` after chdir to a temp dir and call `router(req, res, next)` with a mock `{ method, url, headers, query, get }` request and a `res` with `locals`, `status()` and `json()` (server/account.test.ts has an `api()` helper that does this, with a headers argument).
