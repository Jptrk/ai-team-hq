---
name: limits-review-checks
description: Checks from the 2026-10-10 live-limits review (Accounts page Limits, shared/limits.ts, queue fillSlots) — prompt text vs Claude session key, queue invariant, env parsing pitfalls, docs written in parallel
metadata:
  type: reference
---

Background: on 2026-10-10 HQ's run limits moved from env-only constants to live values (Accounts page > .env > default) read through `limit()`. Checks worth repeating on any change that makes a setting live:

- Any live value interpolated into `systemPromptFor` (server/runner/claude.ts) changes `sessionKeyOf` (it hashes the system prompt), so every Claude desk with a big session starts fresh on its next run ("cached with different instructions") and small ones re-read at full price. The hop limit was the case found. Codex's key (`gptSessionKey`) hashes only tools and model, so GPT desks are unaffected.
- runner/queue.ts invariant: while anyone waits, `active >= concurrency()`. It holds only if every raise calls `fillSlots()`; `acquire` does not check the waiting lines, so a raise without it lets newcomers jump ahead of waiting (and "yours first") jobs.
- Claude's fresh-session retry builds a new RunWatch/maxTurns/maxBudget from live limits but keeps the run's original deadline: snapshot per run if docs promise "a run keeps the limits it started with".
- Old env parsing pitfalls the new `limitFromEnv` fixed (useful when judging behaviour changes): `HQ_CONCURRENCY=junk` gave NaN and deadlocked the queue; `HQ_CHAT_HOP_LIMIT=` (empty) gave 1; NaN turns went to the SDK. New parsing clamps into each spec's range silently (no startup log).
- README/.env.example were being edited by the docs agent while the review ran: re-run `git status` before reporting doc gaps.

Related: [[review-conventions]], [[runner-mode-review-checks]], [[ui-dialog-review-checks]].
