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

Related: [[review-conventions]].
