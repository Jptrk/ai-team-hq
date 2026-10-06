---
name: claude-auth-status-methods
description: What `claude auth status --json` reports as authMethod (bundled CLI claude.exe), incl. that a Console /login reads as "claude.ai"
metadata:
  type: reference
---

The bundled CLI is `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`; grep it with `grep -a -o` (60-90 s timeout) for minified source. `claude auth status` builds `{loggedIn, authMethod, apiProvider, ...}` and adds email/orgName/subscriptionType only when authMethod is "claude.ai".

authMethod values seen 2026-10-06: `third_party` (Bedrock/Vertex), `claude.ai`, `api_key_helper`, `oauth_token` (an auth token from the environment, e.g. CLAUDE_CODE_OAUTH_TOKEN), `api_key`, `none`. A Console `/login` stores a "/login managed key" and is reported as `claude.ai` too, with no subscriptionType, so a check for `method === 'console'` never fires; "claude.ai with no plan" is the closer signal.

Used by server/claudeAuth.ts parseAuthStatus and the Account page's non-subscription warning. Related: [[verify-without-servers]].
