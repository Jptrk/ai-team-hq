---
name: write-probes-with-write-tool
description: Bash heredocs on this Windows machine collapse double backslashes; write probe or test files with the Write tool
metadata:
  type: feedback
---

Write throwaway probe scripts and test strings with the Write tool, not a Bash heredoc. On this machine the Bash tool turned `\\` into `\` inside a quoted heredoc, so a probe testing `C:\repo\src` silently tested `C:` + carriage return instead.

**Why:** a probe of markdown escaping gave wrong output until the file was rewritten with Write (2026-10-01).

**How to apply:** any time a script or fixture contains backslashes (Windows paths, regex, markdown escapes), create it with Write. Probes that need project packages (e.g. @tiptap/*) must live under the project (e.g. a temporary src/__probe/ folder, deleted afterwards), because bare imports do not resolve from the scratchpad. See [[verify-without-servers]].
