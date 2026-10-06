---
name: mcp-guard-review-checks
description: MCP Auto-mode delete gate (server/mcp.ts scanInput/autoDelete, mcpDecision) - what to probe and the traps found in the 2026-10-06 use_figma review
metadata:
  type: reference
---

Checks for changes to the MCP permission gate (server/mcp.ts, mcpDecision in server/runner/claude.ts):

- CODE_KEYS / ACTION_KEYS were built for the deny side (a false positive just asks). Any allow-side use of them (e.g. "input has code, so ignore the server's destructive hint") turns broad keys like `query`, `source`, `expression` (a search filter, a file path) into a pass, and sibling fields such as `write_disposition: 'WRITE_TRUNCATE'` or `if_exists: 'replace'` are never scanned.
- CODE_DELETES misses plain deletes: camelCase GraphQL `productDelete(` (needs `\b`), `shutil.rmtree(`, `fs.rmSync(`, DynamoDB `REMOVE`.
- `keyIn` uses the last snake word minus a trailing s: `sub_command`, `commands`, `UpdateExpression` all match. Short strings under `command` also go through nameSaysDelete, so a test with `git reset --hard` denies via 'input', not the shell rule. Check which reason a deny test hits.

Probe: `scratchpad/probe/*.mts`, `await import('file:///C:/Users/patri/Desktop/ai-team-hq/server/mcp.ts')` (no import side effects), run with `npx tsx` from the repo. For equivalence, extract the old walker from `git show HEAD:server/mcp.ts` into a standalone .ts and fuzz. Cap the fuzz size with a node budget or it runs for more than 5 minutes.

Related: [[review-conventions]].
