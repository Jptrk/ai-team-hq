---
name: desk-identity-review-checks
description: What to check when a change creates, renames, reuses or resets desk (agent) ids in ai-team-hq — state that outlives State, founder-name clashes, probe pattern
metadata:
  type: feedback
---

Agent ids double as @handles, ticket assignees and workspace folder names. The workspace folder outlives `State`. It is not cleared by a reset or by removing a desk, and its ROLE.md is pasted into the system prompt. When a change can hand an old id to a new desk, check whether that desk inherits a stale ROLE.md or memory.md. In the 2026-10-06 fresh-names review, a second reset reused a two-generations-old id about 49% of the time, and with a different role about 44% of the time.

Other places to check for id assumptions: chat.ts resolveRecipients founderNames (checked before desk names, uses the owner's full name lowercased), agents.ts mentionsIn, and the README's QA section ("Ivy").

**Why:** reviews of id/naming changes found the real bug outside `State`, while the in-State maps (skillDesks, connections) were already safe.
**How to apply:** for any seed/reset/rename change, list the per-id state outside `State`, then estimate the reuse rate with a scratchpad .mts that imports server/seed.ts through node_modules/.bin/tsx (see [[review-conventions]], [[huddle-engine-review-checks]]).
