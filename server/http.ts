import type { NextFunction, Request, Response } from 'express';

/**
 * Who may talk to HQ's API. It listens on 127.0.0.1 only, but a web page can still reach it:
 *   - DNS rebinding: a site whose name points at 127.0.0.1 is "same origin" with itself, so the
 *     browser lets it read HQ. The Host header still carries that site's name, so only this PC's
 *     own names are accepted.
 *   - Other local apps on another port count as same-site, so writes must come from HQ's own page.
 * Requests without browser headers (curl, tests) pass, as they can only come from this PC.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function extraHosts(): Set<string> {
  return new Set(
    (process.env.HQ_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The Host header names this PC (any port), or a host you listed in HQ_ALLOWED_HOSTS. */
export function hostAllowed(host: string | undefined, extra = extraHosts()): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return name !== null && (LOOPBACK.has(name) || extra.has(name));
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The port a URL or Host header names, with http's and https's defaults filled in. */
function portOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return null;
  }
}

/**
 * A change may only come from HQ's own page, or from something that is not a browser.
 * Browsers without Sec-Fetch-Site (older Safari) only send Origin, so then Origin must also name
 * HQ's own port: another app on this PC is another port. With Sec-Fetch-Site the browser has
 * already said same-origin, and the Vite dev proxy forwards to another port, so ports aren't compared.
 */
export function writeAllowed(method: string, secFetchSite: string | undefined, origin: string | undefined, host: string | undefined, extra = extraHosts()): boolean {
  if (SAFE.has(method.toUpperCase())) return true;
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false;
  if (origin !== undefined) {
    if (origin === 'null') return false;
    const name = hostnameOf(origin.replace(/^[a-z]+:\/\//i, ''));
    if (!/^https?:\/\//i.test(origin) || name === null || !(LOOPBACK.has(name) || extra.has(name))) return false;
    if (!secFetchSite && (!host || portOf(origin) !== portOf(`http://${host}`))) return false;
  }
  return true;
}

export function requestGuard(req: Request, res: Response, next: NextFunction): void {
  if (!hostAllowed(req.get('host'))) {
    res.status(403).json({ error: 'HQ only answers on this PC (localhost). Set HQ_ALLOWED_HOSTS to allow another name.' });
    return;
  }
  if (req.path.startsWith('/api') && !writeAllowed(req.method, req.get('sec-fetch-site'), req.get('origin'), req.get('host'))) {
    res.status(403).json({ error: 'Requests from other sites are not allowed' });
    return;
  }
  next();
}

/**
 * JSON only. A form or a plain fetch from another page cannot send this type without asking
 * first, and HQ never says yes, so routes that run programs can only be called from HQ itself.
 */
export function jsonOnly(req: Request, res: Response, next: NextFunction): void {
  if ((req.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    next();
    return;
  }
  res.status(415).json({ error: 'Send this as JSON' });
}
