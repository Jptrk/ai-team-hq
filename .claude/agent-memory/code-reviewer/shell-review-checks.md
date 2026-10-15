---
name: shell-review-checks
description: Desks' opt-in Shell (server/runner/shell.ts shellRefusal, guard shellDecision/shellDelete, bashHook) - parser bypasses and fence gaps found in the 2026-10-15 review, plus probe pattern
metadata:
  type: reference
---

What found real bugs in the Shell review (ProjectMeta.shell, shellRefusal text parser, Claude Bash + PreToolUse hook, GPT HQ Bash tool):

- **commandOf takes the first word as the program**: shell reserved words (`if`, `then`, `do`, `else`, `!`, `{`, function bodies) hide everything after them. `if [ -d x ]; then rm -rf ../x; fi` and `{ git push; }` passed. Re-check any new parser change with these.
- **Windows forms the parser skips**: `cmd //c ...` (Git Bash form, MSYS turns `/c` into `C:/`), `powershell -NoProfile <command>` (no -Command flag). check() `continue`s past shells, so nothing nested is read.
- **cd tracking**: `cd -- dir` took `--` as the folder; `popd` not tracked.
- **shellDelete**: the plain-path branch checks only the target's own name, so a folder holding `.env`/keys/nested `.git` goes; the glob/find branch only probes top-level `.git`/`.env`, never keys. delete_file walks the folder; compare against it.
- Background `&` is not refused; GPT runProgram returns after EXIT_GRACE_MS and the child lives on.
- Verified in CLI 2.1.282: `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` exists; auto-backgrounding needs `CLAUDE_AUTO_BACKGROUND_TASKS` (off).

Probes: pure parser via `await import('file:///.../server/runner/shell.ts')` with a fake fence `{cwd, win:true, deleteRefusal}`; real guard via the test's setup (chdir mkdtemp, HQ_RUNNER=sim, store.initStore({emptySeed:true}), claude.guard(ctx)('Bash', {command})). Write probe files with the Write tool: the Bash tool's heredoc ate `\\`.

Related: [[mcp-guard-review-checks]], [[gpt-desk-review-checks]], [[review-conventions]].
