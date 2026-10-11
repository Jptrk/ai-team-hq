---
name: chat-limits-review-checks
description: Checks from the 2026-10-11 review of skipping the chat daily cap in Autopilot projects: which chat wakes are auto/counted, sim path, stale paused threads, default-arg trap
metadata:
  type: reference
---

Background: on 2026-10-11 `defaultLimits(meta)` in server/chat.ts started returning `dailyCap: Infinity` for Autopilot projects, and production call sites pass `defaultLimits(p.meta)`. Checks worth repeating on any change to chat limits (hop limit, daily cap):

- Call sites that post desk-to-desk chat: runner/claude.ts (send_message, hand_off + canWake, report_done, qa_result pass, finishRun settleAfterRun + noticeFinished), routes.ts (resume, sign-off decision, PATCH item to done), and sim.ts tickChat (still no-arg). Codex reuses hqTools/finishRun from claude.ts, so it has no separate path.
- Every chat function has `limits = defaultLimits()` as a default param, so a forgotten arg compiles. Grep the call sites; suggest making the arg required if it keeps biting.
- Desk-made wakes go through hooksFor -> deliver(..., { auto: true }) -> autoGate/projectHold and countStart. The founder's sign-off and mark-done notices in routes.ts call deliver without auto: not gated, not counted.
- Project Daily limits (40 runs / $25, projectHold) apply to every project, not only Autopilot ones. So "chat is already counted" is true everywhere.
- resumeThread never reads dailyCap (only `today`). Threads paused with 'daily-cap' never reopen by themselves, including after the cap stops applying.
- `s.chat.wakes` keeps counting with no cap, so switching Autopilot off mid-day can pause at once. `today()` in store.ts is a UTC date; Daily limits reset at local midnight.
- deliver() is a no-op in sim mode: sim chat never counts toward Daily limits.
- `dailyCap` is never serialized or shown (threadBody sends only hopLimit) and is not in systemPromptFor, so Infinity is safe there.

Related: [[limits-review-checks]], [[runner-mode-review-checks]], [[review-conventions]].
