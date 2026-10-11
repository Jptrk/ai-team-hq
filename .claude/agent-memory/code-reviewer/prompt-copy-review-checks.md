---
name: prompt-copy-review-checks
description: Reviewing desk system-prompt wording (Voice, rules) in systemPromptFor: cross-section conflicts, GPT reach, session keys, README drift
metadata:
  type: feedback
---

When a change only touches desk prompt copy in `systemPromptFor` (server/runner/claude.ts), check these:

- Voice bullets vs "Talking to teammates" (no thanks, no acknowledgements, no small talk): words like "warm" or "texting" plus "teammates use the same voice" pull toward pleasantries.
- Voice vs the markdown section ("How your writing shows up") and plain-text titles/post_update/report_done summaries. A "texting" register pulls against lists and headings.
- Banned-word lists vs the "keep the technical term" and "keep names exact" rules (ticket titles, product names, terms of art like "robust").
- Voice is unscoped by mode. It reaches reports/ deliverables, huddle/QA/plan output and ROLE.md ("follow it within these rules", so the base rules win over a ROLE.md voice).
- GPT desks get the same text: codex.ts `developerPrompt(systemPromptFor(...))`. thread/resume re-sends developerInstructions, and gptSessionKey hashes only tools and model, so GPT threads are not reset. Claude's sessionKeyOf hashes the system prompt, so Claude desks start one fresh session.
- README "Voice" bullet (~line 228) drifts from the prompt's conditions. Compare it clause by clause.
- Prove string escapes by eval-ing the exact source line with node from a scratch file. Don't import the module.

**Why:** the 2026-10-11 "simple words" Voice review found only wording-level risks. These were the places where they could hide.
**How to apply:** use with [[review-conventions]]. Rate wording risks low unless a rule contradicts another outright.
