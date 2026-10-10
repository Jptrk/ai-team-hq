---
name: usage-hold-review-checks
description: Checks from the 2026-10-10 per-model usage hold review (settings.usageHolds, globalHold(provider), pauseInfo combined) - hard-coded "Claude" copy, Resume clearing the other model, stale README
metadata:
  type: reference
---

Background: on 2026-10-10 one global `settings.usageHold` (a ChatGPT limit held Claude projects too) became `usageHolds` per provider. Checks worth repeating on any change to holds/pause copy:

- Server gating is centralised: kickoff/deliver/runPlan/releaseHolds/holdQueued/hooks.held all go through `autoGate(p)`; only `releaseYours` and `sim.ts` call `globalHold` directly. Grep both when hold semantics change.
- UI copy keyed on `meta.paused.by` alone: TopBar's popover title hard-coded "Claude's usage limit"/"Claude account problem"; sign-in toasts (AccountPage, ChatGptAccount) say "Press Resume" for any account hold. App.tsx banner/TopBar render one `meta.paused` on every page.
- `resumeAll` clears every model's hold; with a combined notice `by: 'account'` (Claude account + GPT usage) Resume also wipes the other model's still-running usage limit.
- README had a GPT-desks "Limits" bullet (~line 1108) still saying ChatGPT's limit holds all work; grep README for "all automatic work", "Claude's usage limit".
- Provider switch mid-run is blocked (PATCH project 409 while runs queued/running), so run-time vs failure-time provider can't diverge today.

Related: [[limits-review-checks]], [[gpt-desk-review-checks]], [[runner-mode-review-checks]].
