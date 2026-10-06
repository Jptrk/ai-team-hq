---
name: sdk-cli-internals
description: How to verify Claude Agent SDK / bundled CLI behavior offline in ai-team-hq (stream shapes, tool ordering) by grepping the shipped JS and binary
metadata:
  type: reference
---

The SDK JS is `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (minified, ~156 lines) and the CLI is a Bun binary at `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`. Both can be read offline:

- `grep -o ".\{N\}pattern.\{M\}" sdk.mjs` for the SDK; `timeout 170 grep -a -o "pattern.\{0,900\}" claude.exe` for the CLI (242 MB, takes ~1 min per grep, give the Bash call a 200-400 s timeout).
- Verified 2026-10-01 (SDK 0.3.282 / CLI 2.1.282): `Query.readMessages` calls `handleControlRequest` unawaited (in-process MCP tool calls and can_use_tool) while normal messages go to a queue the `for await` consumer drains, so control requests can overtake queued messages.
- MCP image results become `{type:'image', source:{type:'base64', media_type, data}}` after the CLI resizes them (function `Ay`); unsupported image types are saved to a file and replaced by text.
- `StreamingToolExecutor` runs tools as promises outside the generator pull, so a later tool in the same assistant turn can execute before an earlier tool's result is written to stdout.
- Verified 2026-10-02 (MCP sign-in review): `Query.mcpAuthenticate(name)` sends `mcp_authenticate`; the CLI runs the OAuth flow with `skipBrowserOpen:true` and answers `{authUrl, requiresUserAction:true, callbackExpected:true, redirectScheme, state, callbackPort}` (or `{requiresUserAction:false}`); after the callback it reconnects using the session's own client config (`ownerConfig` checks live `mcp.clients` first), so status turns `connected`. SDK control requests have no timeout; pending ones reject on close. `mcpClearAuth` exists too.
- CLI 2.1.282 has `mcp login <name>` (`--no-browser`), `mcp logout <name>`, `mcp add-json <name> <json>` (positional JSON only, so secrets go on argv), `mcp remove <name> -s`. Exported chunk names survive minification (`export{V$ as getMcpConfigByName}`), so grep `as <originalName>` to find a minified symbol.
- Verified 2026-10-06 (account sign-in review): `claude_authenticate` starts `startOAuthFlow(..., {skipBrowserOpen:true})`, stores `ci={service,flow}` and answers `{manualUrl, automaticUrl}`; the flow saves credentials itself. `claude_oauth_callback` calls `handleManualAuthCodeInput({authorizationCode,state})`, then it and `claude_oauth_wait_for_completion` both await the same flow and answer `{account:{email,organization,subscriptionType,...}}`. When the flow ends, `finally` sets `ci=null`, so a late callback gets "No active claude_authenticate flow". A wrong code rejects the flow, which ends both waits. Grep `subtype===\"claude_oauth_callback\"` in claude.exe.
- Windows Terminal splits on any unescaped `;` inside an argv element (regex `^;|[^\\];`), so names passed to wt.exe need escaping too.

Related: [[review-conventions]].
