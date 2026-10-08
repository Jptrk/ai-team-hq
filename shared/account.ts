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

/** OpenAI's sign-in site. A ChatGPT sign-in page or device page is only ever shown on it. */
const OPENAI_HOSTS = ['auth.openai.com'];

/** The sign-in or device page Codex gave, if it is an https page on OpenAI's sign-in site. The server and the page both check it. */
export function safeOpenAiUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return OPENAI_HOSTS.includes(u.hostname.toLowerCase()) ? u.href : null;
  } catch {
    return null;
  }
}

/** ChatGPT plan names as OpenAI shows them. */
export function chatGptPlanLabel(plan: string | undefined): string | null {
  if (!plan) return null;
  const known: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Business', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  return known[plan.toLowerCase()] ?? plan;
}

/** Plan names as Claude shows them. */
export function planLabel(plan: string | undefined): string | null {
  if (!plan) return null;
  const known: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return known[plan.toLowerCase()] ?? plan;
}
