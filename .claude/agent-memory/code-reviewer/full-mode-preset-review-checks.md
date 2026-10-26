---
name: full-mode-preset-review-checks
description: Checks from the 2026-10-26 review of the Full connection mode, new READ_WORDS, ticket caps for message runs, and the claude_code preset system prompt (snapshot, auto memory)
metadata:
  type: reference
---

Background: on 2026-10-26 HQ added ConnectionMode 'full', READ_WORDS look/peek/observe/screenshot/snapshot, ticket limits for message runs on a ticket's thread, and switched desks to `systemPrompt: { type: 'preset', preset: 'claude_code', append }`. Checks worth repeating:

- **Mode enumerations outside the guard**: src/App.tsx AutoBar count (`c.mode === 'auto'`), AgentPanel chip tooltip, codexMcp.ts header doc, "(auto, as you)" feed text, README Trust bullet, shared/limits.ts hints. Grep `'auto'` in src too, not only server.
- **READ_WORDS is a prefix regex**: a new word also makes `<word>_restore`, `<word>_upload`, `<word>_and_act` reads on servers with no hints, and reads skip Ask/Read only/huddle/QA/plan. Probe isReadOnlyTool with such names. Anchoring at `^` means "browser_snapshot" is not covered.
- **SDK snapshot (default on, sdk.d.ts ~2356)**: a resumed session resends its recorded system prompt; a new `append` is ignored until compaction. freshStartReason resets only big sessions, and rememberSession then stores the new key, so prompt changes (mode text, preset) never reach small sessions. GPT is unaffected (developerInstructions re-sent).
- **Preset turns on Claude Code's auto memory** (sdk.d.ts lists it as a dynamic section; on by default; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` turns it off). The CLI allows `.md` writes in that dir with no canUseTool ("auto memory files are allowed for writing"), so desks write outside HQ's fence into ~/.claude/projects.
- **Message run item**: runner/index.ts sets item = the thread's ticket for any desk woken there, owner or not. Use `owns(ctx)` when a rule is meant for the owner.

Probe: scratchpad/probe/*.mts importing `file:///C:/Users/patri/Desktop/Folders/Personal%20Projects/ai-team-hq/server/mcp.ts`, run `npx tsx` from the repo (the repo moved from Desktop/ai-team-hq).

Related: [[mcp-guard-review-checks]], [[gpt-connections-review-checks]], [[limits-review-checks]], [[sdk-cli-internals]], [[review-conventions]].
