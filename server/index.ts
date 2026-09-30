import './env';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { router } from './routes';
import { isLive, meta } from './runner';
import { startSim } from './sim';
import { flushAll, initStore, listMeta } from './store';

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/api', router);

// Bad JSON bodies and unexpected throws come back as JSON, not an HTML stack trace.
app.use('/api', (err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[hq] api error:', err);
  res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : status >= 500 ? 'Server error' : err.message });
});

const dist = path.resolve('dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const live = isLive();
initStore({ emptySeed: live });
if (!live && process.env.SIMULATE !== '0') startSim();

// node --watch sends SIGTERM on restart; write any debounced changes first.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
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
      ? `[hq] runner=claude model=${m.model} auth=${m.auth} (real agents, real spend)`
      : `[hq] runner=sim (no Claude calls). Go live with HQ_RUNNER=claude in .env${m.auth === 'none' ? ' plus an ANTHROPIC_API_KEY or a Claude Code login' : ''}.`,
  );
});
