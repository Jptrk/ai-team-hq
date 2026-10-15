---
name: blocker-hold-review-checks
description: Checks from the 2026-10-16 epics/blockers review (autoHold why 'blocked', stillBlocked, heldCount) - stale stored why, Pause vs your released start, loop check through done tickets
metadata:
  type: reference
---

Background: on 2026-10-16 epics (State.epics, shared ticket numbers) and blockers (WorkItem.blockedBy, AutoHold why 'blocked') landed. kickoff holds manual/handoff/instruction/auto starts on a blocked ticket; releaseYours/releaseHolds keep them via stillBlocked. Checks worth repeating on any change to hold kinds:

- A stored `autoHold.why` goes stale: releaseHolds returns early while autoGate is closed (team holds keep why 'blocked' after the blockers are done), and the 'auto' re-hold branch (`halted || freeSlots() === 0`) puts the hold back with its old why. Anything keyed on the stored why (heldCount -> meta.held -> TopBar "Nothing waiting yet.", BoardCard Waiting chip, holdText) is then wrong. Probe it, don't trust the name.
- releaseYours applies globalHold (incl. Pause) to your released starts, so a blocked start of yours whose blockers clear during a Pause waits for Resume, while README's Pause section says your clicks still run.
- blockerProblem walks done tickets too: refuses B blocked by A when done A once waited on B, with "neither could ever start". Keeping the refusal is defensible (done tickets can be reopened); the wording is not.
- Goal planDue: blocked To do goal tickets count as waiting, so a blocker that can't progress (owner off shift, human-owned) makes the lead wait silently, with no stalled notice.
- Probe harness: scratchpad/probe/epics-probe.mts, imports by file:/// URL, HQ_CONCURRENCY=1 and a fake runner that awaits a gate for title 'SLOW' to fill the only slot.

Related: [[usage-hold-review-checks]], [[runner-mode-review-checks]], [[limits-review-checks]], [[review-conventions]].
