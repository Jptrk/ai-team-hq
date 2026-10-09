---
name: codex-mcp-facts
description: Codex 0.161.0 MCP facts verified offline (2026-10-09) for GPT desk connections - sign-in file, mcp logout, env list, resource tools, approval params
metadata:
  type: reference
---

Verified against the pinned binary (node_modules/@openai/codex-win32-x64/.../codex.exe) with a scratch CODEX_HOME, nothing signed in:

- With `mcp_oauth_credentials_store="file"`, Codex keeps MCP sign-ins in `<CODEX_HOME>/.credentials.json` (a bad file there makes `mcp logout` fail "failed to parse credentials file at ..."). No file means no MCP sign-ins.
- `codex mcp logout [-c k=v]... -- <name>` works offline: exit 0 "No OAuth credentials stored for 'x'." for a configured http server; exit 1 "No MCP server named" if not configured; exit 1 "only supported for streamable_http" for a stdio one. In a temp CODEX_HOME it prints a "could not create PATH aliases" WARNING first.
- Windows env list Codex hands every stdio MCP server (strings near "invalid HTTP header value"): PATH PATHEXT SHELL COMSPEC SYSTEMROOT WINDIR SYSTEMDRIVE USERNAME USERDOMAIN USERPROFILE HOMEDRIVE HOMEPATH PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 PROGRAMDATA LOCALAPPDATA APPDATA TEMP TMP TMPDIR POWERSHELL PWSH. The Unix list is compiled out of the Windows build.
- No switch for the built-in list_mcp_resources / list_mcp_resource_templates / read_mcp_resource tools: ToolsToml has only web_search, experimental_request_user_input, update_plan; no feature flag names them.
- Spike logs: the approval's `_meta.tool_params` equals the `item/started` mcpToolCall `arguments` (both `{}` for no args); items also carry `readOnlyHint`.

How to apply: re-check these before moving the @openai/codex pin. Related: [[verify-without-servers]].
