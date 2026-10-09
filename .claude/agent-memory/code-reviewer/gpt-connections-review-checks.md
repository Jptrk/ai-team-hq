---
name: gpt-connections-review-checks
description: Checks from the 2026-10-09 review of MCP connections on GPT desks (codexMcp.ts, codexMcpAuth.ts, approveMcp in runner/codex.ts) - approval matching, env leaks into Codex, hq-name shadowing, Codex MCP facts
metadata:
  type: reference
---

What found real bugs when connections came to GPT desks (Codex 0.161.0):

- **Approval matching.** Codex's tool approval (`mcpServer/elicitation/request`, `_meta.codex_approval_kind: 'mcp_tool_call'`) carries no item id. Any heuristic that picks "the newest unanswered in-progress mcpToolCall" swaps verdicts when two calls on one server are in flight (read gets declined, write gets accepted). Check the decision is made from the elicitation's own tool (message `run tool "X"`, which may be a tool *title*) and `_meta.tool_params`, and the item is matched by tool + args.
- **Connection env goes into the whole app-server env** (`{...codexEnv(), ...opts.env}`). Codex forwards to each stdio MCP server only a whitelist (PATH, PATHEXT, SHELL, COMSPEC, SYSTEMROOT, WINDIR, SYSTEMDRIVE, USERNAME, USERDOMAIN, USERPROFILE, HOMEDRIVE, HOMEPATH, PROGRAMFILES*, PROGRAMW6432, PROGRAMDATA, LOCALAPPDATA, APPDATA, TEMP, TMP; strings verified in codex.exe) plus its env_vars. So a connection's PATH/TEMP/HTTPS_PROXY reaches Codex itself and every other server. Claude Code instead spreads its whole env (`Ms()`) plus the server's env, per server, so servers relying on inherited vars work on Claude and fail on GPT.
- **A server named exactly `hq`** (from ~/.claude.json or a repo .mcp.json) is shadowed on Claude (`mcpServers: {...servers, hq: hqServer}`) but becomes a real Codex server on GPT, and guard() allows every `mcp__hq__*` call: no modes, no huddle/QA/plan read-only.
- Generated variable names (`HQ_MCP_<KEY>_<HEADER>`, uppercased, non-alnum to `_`) collide across keys like `my-api`/`my_api`: one server's token is sent to the other. Same family: env names differing only by case are one variable on Windows.
- Per-server tool hints come from Claude's check; a server signed in only for GPT has none, so Auto loses the destructive-hint gate. Codex's `mcpServerStatus/list` returns tools with annotations.
- In-memory status caches written after an await: a Check that started before a sign-in landed writes the older answer last (same family as [[account-signin-review-checks]]).

Codex facts (from `codex app-server generate-ts`, see [[gpt-desk-review-checks]]): McpToolCallResult has no isError (a tool error is item status `failed`); ListMcpServerStatus is paginated (nextCursor); McpAuthStatus is unknown/unsupported/notLoggedIn/bearerToken/oAuth; the app-server has no MCP OAuth logout; `mcpServer/oauth/login` takes `timeoutSecs`; Codex adds built-in `list_mcp_resources`/`read_mcp_resource` tools with no approval. Default MCP tool parallelism is per-server `supports_parallel_tool_calls` (off).

Probe pattern: scratchpad/probe/*.mts with a minimal fake app-server via `setAppServerForTests` whose turn/start runs scripted `item/started` + elicitation steps, then report_done and turn/completed; put connections in CLAUDE_CONFIG_DIR/.claude.json of a mkdtemp root.

Related: [[mcp-guard-review-checks]], [[review-conventions]].
