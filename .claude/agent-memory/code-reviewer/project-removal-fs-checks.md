---
name: project-removal-fs-checks
description: Windows/Node 24 fs facts and failure modes found in the 2026-10-09 project Archive / Delete-for-good review (moveDir copy fallback, junctions, stale Project after id reuse), and how to probe them
metadata:
  type: reference
---

Measured on this PC (Windows 11, Node v24.19.0), 2026-10-09:

- `fs.cpSync(dir, dest, {recursive:true})` **dereferences junctions** (copies the target's files; a 'dir' symlink stays a link). A junction cycle **hard-crashes node** (exit 0xC0000409, no exception, no 'exit' event). `filter: (src) => !fs.lstatSync(src).isSymbolicLink()` skips both safely.
- `fs.rmSync(recursive, force)` does NOT follow junctions (cycles and outside targets are safe) and removes read-only files. It also does **not retry on EPERM**: `maxRetries`/`retryDelay` do nothing for a held cwd or a locked file. It throws at once.
- `renameSync` of a folder fails with EPERM when any file inside is open, or a child process has its cwd inside (MCP probe / sign-in `.probe`).
- `readdirSync(withFileTypes)` reports a junction as a link, not a directory.
- An exclusively locked file (FileShare.None, as Word does) makes cpSync throw. Simulate it with a background `powershell [System.IO.File]::Open(f,'Open','ReadWrite','None')`.

ai-team-hq failure modes found: store.ts `moveDir` copy fallback throwing mid-archive (handle dropped, registry kept, so the next getProject reseeds an empty team). `makeMeta` checks only the registry, so a same-name project reuses the id. A stale `Project` then resolves `meta` by id and its commit overwrites the new project's db.json. Long-lived holders of a `Project`: connections check (≤90s), MCP sign-in job (≤330s, global one-at-a-time lock, cancel route 404s once the project is gone), and a sim huddle unwinding after Stop.

Probe pattern: scratchpad `.mts` with `process.chdir(mkdtemp)` and then `await import(pathToFileURL('C:/.../server/store.ts').href)`, run with the repo's `node_modules/.bin/tsx`. **Give temp dirs a session-unique prefix (e.g. `hqrev-`) and clean only that prefix.** A broad `hq-probe-` regex once deleted other sessions' leftover temp folders.

Related: [[review-conventions]], [[huddle-engine-review-checks]], [[desk-identity-review-checks]], [[mcp-guard-review-checks]].
