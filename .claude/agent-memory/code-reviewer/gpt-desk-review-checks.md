---
name: gpt-desk-review-checks
description: Checks and offline probes from the 2026-10-08 GPT desks review (codex app-server runner, codexTools, codexAuth) - Windows path aliases past the guard, Stop races, Codex config/protocol checks
metadata:
  type: reference
---

What found real bugs in the GPT desks review (server/runner/codex.ts, codexTools.ts, codexServer.ts, codexAuth.ts; @openai/codex 0.161.0):

- **Windows path aliases.** Node fs uses `\\?\` paths, so `.git.` or `server.key.` is a literal new name (safe), and `fs.realpathSync.native` on such a path is ENOENT, so guard's realPathOf keeps the literal name. Rust std (Codex's apply_patch) and cmd use Win32 normalization: `.git.\hooks\x` lands in `.git\hooks\x`, `node_modules.\x` in node_modules, `x.key.` on x.key. guard() (isProtected) allows all of these; only deleteRefusal rejects trailing dot/space and ":". `::$DATA` is caught (realpath resolves it).
- **Stop in runTurn**: an interrupt is only sent when turnId is known; tool calls and patch approvals are not refused once `stopping` is set. Check any new async gap between "stop" and "the id we need to stop it".
- **In-process regex** (Grep tool) runs on HQ's event loop: `^(a+)+$` on 28 chars blocks about 3 s.
- **Status cache generations** (same bug family as [[account-signin-review-checks]]): a check started before sign-out/sign-in writes its stale answer last; hasChatGptLogin falls back to that cache.
- Runner gating keyed on the *current* opt-in (claudeReady) changes behavior on switch-off/sign-out while live; compare with the AccountPage banners (see [[runner-mode-review-checks]]).

Offline probes (no model, no network, scratch CODEX_HOME):
- `codex.exe --codex-run-as-apply-patch "<patch text>"` from a scratch cwd applies a patch the way Codex does (binary under node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin).
- `codex.exe -c <DESK_CONFIG flags> features list` shows effective features. In 0.161.0 `features.unified_exec=false` (and `experimental_use_unified_exec_tool=false`) do not turn unified_exec off; computer_use/browser_use flags do.
- `codex.exe app-server generate-ts --experimental --out <scratch>` gives the exact protocol types (e.g. ReviewDecision has no plain "denied").
- Runner probes: copy the Fake app-server from server/codex.test.ts into scratchpad/probe/*.mts, import modules by file:/// URL after chdir to a mkdtemp. Wait for a *new* fake server (servers.length) before cancelRun, or you match the previous case's server and cancel a queued run.

Per-project model review (2026-10-09, ProjectMeta.provider, modelProblem/modelHold/setModelGate):
- Any new "hold yours" gate: check routes that treat a null kickoff as an error (POST /items/:id/run answered 500 while the start was held), runs of yours already queued (they reach execute and fail; only `auto` runs re-check the gate in the enqueue callbacks), and holdItem overwriting a `mine` hold (drops mine/note/images) when a queued team run reaches the gate.
- Copy keyed on "no login" when the real cause is the opt-in switch: compare GET /api/meta `auth`/`optedIn` with /api/account `claudeAtStart`; the header pill (runnerLabel) ignores claudeBlocked.
- The PATCH 409 check-then-clear is synchronous; enqueue/huddle turn chains are microtasks and runHuddleDesk tracks its run before awaiting, so no run slips in between.
- Probe pattern: scratchpad/probe/model-probe.mts (HQ_CONCURRENCY=1, a fake app-server whose turn waits on a promise, rename data/.codex/auth.json to make the model go away mid-queue).

Related: [[review-conventions]], [[mcp-guard-review-checks]].
