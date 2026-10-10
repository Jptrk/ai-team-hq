---
name: write-probes-with-write-tool
description: Bash heredocs on this Windows machine collapse double backslashes; Python text-mode edits silently turn CRLF files into LF
metadata:
  type: feedback
---

Write throwaway probe scripts and test strings with the Write tool, not a Bash heredoc. On this machine the Bash tool turned `\\` into `\` inside a quoted heredoc, so a probe testing `C:\repo\src` silently tested `C:` + carriage return instead.

**Why:** a probe of markdown escaping gave wrong output until the file was rewritten with Write (2026-10-01).

**How to apply:** any time a script or fixture contains backslashes (Windows paths, regex, markdown escapes), create it with Write. The same goes for `python - <<'EOF'` multi-replace edit scripts: on 2026-10-10 a `\\'` in an inserted TS string became `'` and broke the test file (a grep of the result caught it). Keep backslash-free text in heredoc edits; put lines with backslashes or escaped quotes in through Edit. Probes that need project packages (e.g. @tiptap/*) must live under the project (e.g. a temporary src/__probe/ folder, deleted afterwards), because bare imports do not resolve from the scratchpad. See [[verify-without-servers]].

Working-tree line endings in ai-team-hq are mixed (seen 2026-10-08: README.md and server/guard.test.ts CRLF; most server/*.ts and shared/types.ts LF; check with `file`). The index is LF. A Python `open(p).read()` / `write` round trip converts them to LF without any error, and `grep -q $'\r'` in Git Bash wrongly reported CRLF files as LF (2026-10-06). Prefer the Edit tool (it keeps line endings); for scripted edits, read and write bytes and count `b'\r\n'` to confirm.
