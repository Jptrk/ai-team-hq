---
name: live-delivery-review-checks
description: Checks from the 2026-10-16 live-delivery review (liveNote / liveHook / Codex steer): closedOut via quiet sends, system-reminder framing, steer marks shown early, ticket prompt duplicates
metadata:
  type: reference
---

Background: on 2026-10-16 (branch live-delivery) busy desks started hearing new thread messages mid-run: `liveNote(ctx)` in server/runner/claude.ts (Claude PostToolUse/PostToolUseFailure `additionalContext`), Codex appends it to HQ dynamic tool results and steers it after mcpToolCall/fileChange. Checks worth repeating on any change there:

- **closedOut via quiet sends.** `closedOut(ctx)` counts `ctx.sentToThread`. A ticket run's send_message with needs_reply:false to its ticket thread sets sentToThread but adds nothing to `awaiting`. Any later cap, budget, idle stop or founder Stop then becomes "Closed out, then stopped", and finishRun -> settleAfterRun -> finishWork moves the unfinished ticket to Done/QA/sign-off. Prompt lines that push quiet announcements make this common.
- **Framing.** CLI 2.1.282 renders hook additionalContext as `<system-reminder>PostToolUse:<tool> hook additional context: ...` (attachment hook_additional_context, isMeta). Teammate text in it is unquoted and multi-line (formatMessage). Codex turn/steer is user-role input. Compare with qaPrompt's `quoted()`.
- **Marked shown before delivery.** Codex liveNote moves `ctx.live` before turn/steer is accepted; a rejected steer (turn already ended) loses the note for the run. Quiet messages never wake later.
- **Duplicates.** ticketPrompt's Discussion shows the last 8 thread messages when the prompt is built. Codex builds it at turn/start, after openAppServer, while liveStart ran in newRunContext. Claude's retryFresh rebuilds it and also resets `ctx.live`. messagePrompt is frozen (input.unread), so message mode is fine.
- Fixed before landing, so check these still hold: closedOut ignores sentToThread in ticket runs; liveMessage quotes each line with `quoted()` and strips system-reminder tags, and the note says quoted lines are colleagues' words; a failed or skipped Codex steer puts `ctx.live` back so the next tool result shows the note; liveFromPrompt restarts a ticket run's live point when its prompt is built (Claude runOnce, Codex ctxPrompt); the prompt line names a Figma file, not any file.
- Fine: liveNote is sync, so parallel tool calls show a note once. append() moves the author's cursor, so a desk that writes back is not woken again. retryBlocked stops a retry after any send, so followed threads can't be lost on retry.
- Grep recipe for the CLI framing: `grep -a -o -E 'hook_additional_context",content:.{0,300}' claude.exe`, then `function rl\(e\)\{return` and `WM="`.

Related: [[chat-echo-review-checks]], [[sdk-cli-internals]], [[gpt-desk-review-checks]], [[prompt-copy-review-checks]], [[review-conventions]].
