---
name: account-signin-review-checks
description: Failure modes found in the 2026-10-06 Claude account sign-in review (server/claudeAuth.ts, AccountPage) — stale status cache, vanishing errors, frozen runner on macOS
metadata:
  type: reference
---

Checks that found real bugs in the Claude account login review (2026-10-06):

- Status cache vs in-flight forced check: `checkAccount(false)` returned a <30 s cached answer while a forced re-check after sign-in was running, and the job was cleared before that check ended. A 2 s page poll in that window saw "no sign-in, not signed in", stopped polling, and never showed the success flag. Check the order: the in-flight promise must win over the cache, or the job must outlive the re-check.
- Page-level `error` state cleared by every successful `load()`: an action's catch that calls `load()` wipes its own error within one GET. Look for one shared error state used by both polls and actions.
- "was signing in -> now signed in" toast detection fires on Cancel when an older login exists (Switch account).
- Runner mode frozen at boot (`runnerName()` first call in server/index.ts) runs before the async `claude auth status`, so a macOS keychain login (no .credentials.json) can never be seen at boot; a "restart to go live" hint then loops forever.
- Forced checks chain without coalescing in the shared runCli queue; GET is a SAFE method in requestGuard, so cross-site `<img>` can trigger them.
- The auto mode classifier blocks reading the real ~/.claude/.credentials.json, even a script printing only booleans; say "not verified" instead of retrying.

Probe pattern: scratchpad .mts that chdirs to a mkdtemp folder, sets CLAUDE_CONFIG_DIR, then dynamic-imports server/claudeAuth.ts with `setAccountTestHooks({ open, cli, loginMs })` fakes (see [[huddle-engine-review-checks]]).

Related: [[sdk-cli-internals]], [[review-conventions]], [[ui-dialog-review-checks]].
