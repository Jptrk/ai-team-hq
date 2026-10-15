---
name: chat-echo-review-checks
description: Checks from the 2026-10-16 review of quiet "no reply needed" messages and the echo pause in server/chat.ts: stalled waiting tickets, regex false positives, streak counting
metadata:
  type: reference
---

Background: on 2026-10-16 postAgentMessage gained PostOptions {attachments, needsReply, notice}, needsNoReply (NO_REPLY/ACK_ONLY regexes), echoStreak/ECHO_LIMIT, and settleAfterRun stopped posting a message run's closing text to teammates. Checks worth repeating on any change there:

- A ticket run that asks a teammate leaves the ticket in-progress ("Waiting on X in chat") and only the teammate's send_message wakes it again. Anything that makes that answer quiet ("OK.", "Sounds good.", "All good.", "Perfect.", "... No reply needed.", needs_reply:false) or drops it (closing text not posted) stalls the ticket forever. Under Autopilot, freeDesks (autopilot.ts ACTIVE set) also treats that desk as busy, so it gets no other work.
- The owner's message run prompt (REPLY_RULE in runNotes, messagePrompt closing line) must still tell an owner to carry on its ticket when the message answers what it was waiting on.
- echoStreak counts quiet (noReply) messages, hand-off/finished notices (no flag on the Message), one-way runs, and imperative requests (no '?'). Any hq note (pause, resume, held-wake) breaks the streak.
- NO_REPLY matches "No reply needed, just merge it", quoted text, and em-dash conditionals ("— if"), since the lookahead set is `[\s,;:-]`.
- Fixed the same day in 62bf472, so check these still hold: quiet never applies to a desk that waitsOn the sender (owns the thread's todo/in-progress ticket, or asked an unanswered question); owners are told to carry on once answered; echoStreak skips noReply messages, stops at Message.notice, and needs the two desks to take turns; em/en dashes and double-quoted text are handled; closing text reaches a teammate only for a question it left unanswered; a held question in a ticket run still counts as awaited.
- Probe: scratchpad/probe/echo.mts importing server/chat.ts by file:/// URL, chdir to a mkdtemp first, run with `HQ_RUNNER=sim npx tsx`.

Related: [[chat-limits-review-checks]], [[prompt-copy-review-checks]], [[review-conventions]].
