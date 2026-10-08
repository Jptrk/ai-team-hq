---
name: runner-mode-review-checks
description: Checks from the 2026-10-08 sim/idle/live runner-mode reviews (pickRunner/pickIdle, startSim gate, login holds) — opt-in cleared by sign-out, stranded work, login holds released as auto, wentLive backfill
metadata:
  type: reference
---

Background: on 2026-10-08 a silent sim fallback (opted in, no login) ticked server/sim.ts on the founder's real projects and wrote ~105 fake Routine tickets, Needs-you items and chat replies. The fix added an "idle" mode (sim runner, no sim timer). Checks worth repeating on any runner-mode change:

- Anything keyed on the *current* opt-in (`settings().claudeLogin`) misses HQ's own Sign out and the switch off: both clear the yes, so the next restart is plain sim again, on real projects. A terminal `claude auth logout` keeps the yes (-> idle). Compare both sign-out routes.
- `kickoff`/`deliver` no-op when not live: in any non-sim, non-live mode, chat shows "is queued" forever (boot clears `t.waiting` without a wake) and instructions sit in-progress with no run (Autopilot picks To do only). The hold helpers (`holdItem`/`holdWake` + `releaseHolds`) are the existing way to defer work to "once live".
- Grep src for `live ?` copy, not just `runner === 'sim'`: HuddleSetup's "Sim mode: canned replies" took a `live` boolean and missed the new state. server/office.ts `!isLive()` fakes "coding" activity.
- README has a mode table (top), "restart HQ to go back to sim", and the /api/meta field list; all drift with runner changes.
- Huddle guards keyed on `turn === deskTurn` can't be hit by tests that pass a fake TurnFn; isIdle() true needs a fresh process (module-level `chosen`); idle.test uses `setIdleForTests`.
- Follow-up (same day): idle holds your starts as `why: 'login'` and releaseHolds re-kicks them with `auto: true`, so they hit daily limits/countStart (autopilot.ts says your clicks never go through the gate), and kickoff on release drops `note`/images/includeNotes (instruct prompt then says "instructions in the attached images"). deliver's `!opts.auto` branch drops the held wake then re-holds it, so every message re-posts the HQ note.
- `wentLive` lives only in data/settings.json: no backfill for installs that went live earlier, and a lost/corrupt file means sim again. sim.ts and seed.ts never create Run records, so `state.runs.length > 0` is a reliable "went live here" signal.

Related: [[account-signin-review-checks]], [[huddle-engine-review-checks]], [[review-conventions]].
