---
name: huddle-plan-review-checks
description: Checks from the 2026-10-16 planning-huddle epic/order review (HuddleProposal.after/inEpic, Huddle.epic, followPlan) - out-of-order approval vs Autopilot, transitive order on decline, stale "new epic" copy
metadata:
  type: reference
---

Background: on 2026-10-16 planning huddles got one proposed epic (Huddle.epic) and a ticket order (HuddleProposal.after = proposal ids). recordSummary validates the order (planOrder, blockerProblem on pseudo nodes); decideProposal -> followPlan makes the epic with the first approved in-epic ticket and links blockers once both ends are approved, reverse links only onto To do tickets, every link through blockersProblem.

Checks worth repeating on any change here:

- Out-of-order approval: approve B (after A) while A is pending -> B lands in To do with no blocker, and Autopilot's pickStarts takes it on the next autoTick (any run ending, or the 1-minute live sweep). Once A is approved, B is in progress and is not held back. Any copy promising "starts once those are done" is wrong for that path. Tests approve both synchronously and miss it.
- Declining a middle ticket (A->B->C, B declined) leaves C with no link to A: order is not transitive.
- UI shows "(new epic)" / "New epic: X" even when epicTwin will reuse an existing epic of that title, and keeps the hint after every in-epic proposal was declined.
- Loop safety is sound: forward links are set (setBlockers) before reverse links are checked, so blockerProblem's walk sees them.
- Probe: scratchpad/probe/plan-probe.mts (validateHuddle/createHuddle, phase 'summarize', recordSummary, advance, decideProposal, then pickStarts({autopilot:true})).

Related: [[blocker-hold-review-checks]], [[huddle-engine-review-checks]], [[review-conventions]].
