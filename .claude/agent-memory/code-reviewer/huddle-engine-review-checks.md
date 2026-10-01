---
name: huddle-engine-review-checks
description: Failure modes found in the 2026-10-01 Huddles review (drive loop resume/stop races, blind note approval) and how to probe them headlessly
metadata:
  type: reference
---

Checks that found real bugs in server/huddles.ts + huddle-core.ts (first review, 2026-10-01):

- Resume after a round where every desk failed: recordFallback empties `waiting`, so Resume runs zero turns and re-fails at once. Check that reopen restores owed turns.
- Stop then Resume before a cancelled turn unwinds: the aborted run comes back while status is 'running' again and is recorded as a failure (desk loses its turn; in summarize the huddle fails).
- Summary landed, then stop or restart before the run ended: Resume re-runs the facilitator (wasted run).
- Facilitator desk removed: every Resume fails the same way.
- Note proposals: UI shows only the 80-char title while the full multi-line text goes into team notes (system prompt).

Probe pattern: write `scratchpad/probe/*.mts` (a `.ts` outside the package compiles as CJS and rejects top-level await), import the server modules by `file:///` URL, chdir to `os.tmpdir()` mkdtemp before importing store, pass a fake TurnFn to `startHuddle/resumeHuddleRun`, run with `HQ_RUNNER=sim npx tsx ../probe/x.mts` from the scratch copy.

Related: [[review-conventions]], [[sdk-cli-internals]].
