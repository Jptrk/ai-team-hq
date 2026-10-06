/** Anthropic's own sites. A Claude sign-in page is only ever shown on one of these. */
const CLAUDE_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];

/**
 * The sign-in page Claude Code gave, if it is an https page on Anthropic's own sites. Anything else is not
 * shown: the link signs in to your Claude account. The server and the page both check it.
 */
export function safeClaudeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return CLAUDE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? u.href : null;
  } catch {
    return null;
  }
}

/** Plan names as Claude shows them. */
export function planLabel(plan: string | undefined): string | null {
  if (!plan) return null;
  const known: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return known[plan.toLowerCase()] ?? plan;
}
