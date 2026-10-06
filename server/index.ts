import './env';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { router } from './routes';
import { autoSweep, isLive, loginOptIn, meta } from './runner';
import { limitsFromEnv, limitsWarning } from './runner/watch';
import { startSim } from './sim';
import { sweepAttachments } from './attachments';
import { backfillFingerprints } from './connections';
import { requestGuard } from './http';
import { cancelAllLogins } from './mcpAuth';
import { cancelAccountLogin, checkAccount, hasClaudeLogin } from './claudeAuth';
import { initSkills } from './skills';
import { allProjects, flushAll, initStore, listMeta } from './store';

const app = express();
// Only this PC's own names, and changes only from HQ's own page (see server/http.ts).
app.use(requestGuard);
app.use(express.json({ limit: '64kb' }));
app.use('/api', router);

// Bad JSON bodies and unexpected throws come back as JSON, not an HTML stack trace.
app.use('/api', (err: Error & { status?: number; type?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[hq] api error:', err);
  const message =
    err.type === 'entity.parse.failed'
      ? 'Request body is not valid JSON'
      : err.type === 'entity.too.large'
        ? req.path.includes('/attachments')
          ? 'That is too large. Images can be at most 3.75 MB.'
          : 'That request is too large.'
        : status >= 500
          ? 'Server error'
          : err.message;
  res.status(status).json({ error: message });
});

const dist = path.resolve('dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// HQ picks sim or live once, just below. A Mac keeps the Claude login in the keychain, not a file HQ can
// read, so ask Claude Code first: otherwise HQ starts in sim every time and "restart to go live" never ends.
if (!process.env.ANTHROPIC_API_KEY && loginOptIn() && !hasClaudeLogin()) await checkAccount().catch(() => null);
const live = isLive();
initStore({ emptySeed: live, freshNames: true });
for (const p of allProjects()) {
  const removed = sweepAttachments(p.id, p.state);
  if (removed) console.log(`[hq] ${p.meta.key}: removed ${removed} unused image${removed === 1 ? '' : 's'}`);
}
// Skills: repos fetched for a pick that never happened don't survive a restart.
initSkills();
// Connections saved before HQ kept fingerprints: pin each to the server it means now.
try {
  backfillFingerprints();
} catch (e) {
  console.error('[hq] connections:', e instanceof Error ? e.name : 'error');
}
if (!live && process.env.SIMULATE !== '0') startSim();
// Live: every minute, a usage limit that has reset clears and held work starts again (later: Autopilot picks).
// The first pass waits a little after boot, so starts a restart cut off begin once the server has settled.
if (live) {
  const every = Number(process.env.HQ_AUTO_SWEEP_MS) > 0 ? Number(process.env.HQ_AUTO_SWEEP_MS) : 60_000;
  setTimeout(() => {
    autoSweep();
    setInterval(() => autoSweep(), every);
  }, 20_000);
}

// node --watch sends SIGTERM on restart; write any debounced changes first.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cancelAllLogins();
    cancelAccountLogin();
    flushAll();
    process.exit(0);
  });
}

const PORT = Number(process.env.PORT ?? 4747);
app.listen(PORT, '127.0.0.1', () => {
  const m = meta();
  const projects = listMeta();
  console.log(`HQ api listening on http://127.0.0.1:${PORT}`);
  console.log(`[hq] ${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects.map((p) => `${p.key} ${p.name}`).join(', ')}`);
  console.log(
    live
      ? `[hq] runner=claude model=${m.model} effort=${m.effort ?? 'model default'} auth=${m.auth} (real agents, real spend)`
      : process.env.HQ_RUNNER === 'sim'
        ? '[hq] runner=sim (HQ_RUNNER=sim in .env, no Claude calls).'
        : m.restartToGoLive
          ? '[hq] runner=sim (no Claude calls). Desks may run on your Claude login now: restart HQ to go live.'
          : "[hq] runner=sim (no Claude calls). Go live from HQ's Account page with your Claude login (or put an ANTHROPIC_API_KEY in .env), then restart.",
  );
  const limits = limitsWarning(limitsFromEnv());
  if (live && limits) console.warn(`[hq] ${limits}`);
  // Ask Claude Code who is signed in, so the Account page answers at once (and a Mac keychain login counts).
  void checkAccount().catch(() => undefined);
  if (live && !m.effort && process.env.CLAUDE_CODE_EFFORT_LEVEL) {
    console.warn(`[hq] CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} is set, so desk runs use it while HQ's effort is Model default. A level picked in HQ overrides it.`);
  }
});
