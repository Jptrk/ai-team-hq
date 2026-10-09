---
name: login-review-checks
description: Checks from the 2026-10-10 HQ password login review (server/auth.ts, authRoutes, AuthGate) — /API case bypass, global limiter, await-gap races, dummy-hash timing, port-shared cookies
metadata:
  type: reference
---

Checks that found real issues in the Phase 1 login review (2026-10-10):

- `requestGuard` tests `req.path.startsWith('/api')` (case-sensitive) but Express 5 / router 2 match mounts and routes case-insensitively: `POST /API/projects/<pid>/reset` skips the write check and still reaches the route. SameSite=Strict does not stop it from a page on another localhost port: ports don't change the site, so the cookie goes along. Re-check on any guard/mount change.
- The server listens on 127.0.0.1 and never sets `trust proxy`, and the Vite proxy connects from loopback too, so `req.ip` is always loopback: any "per address" limiter is one global bucket (lockout DoS, and a good login clears everyone's count).
- Await gaps in auth: checkLogin verifies against the hash read before scrypt, then startSession writes to the fresh file, so a login with the OLD password that overlaps a password change gets a session that survives it. Re-read the user/hash after every await.
- A dummy hash created lazily (`dummy ??= hashPassword(...)`) makes the first unknown name cost 2 scrypts (~217 ms vs ~108 ms measured).
- Cookies are not port-scoped: the README's scratch-copy setup (API 4757 + Vite 5175 on localhost) shares `hq_session` with the real HQ, so logging in on one ends the other.
- AccountPage renders cards in both its loading and loaded branches at different child positions: they remount (and lose form state) when the first load lands. Look for the same component in two return branches.

Probe patterns (no listen): Express app driven with `new http.IncomingMessage(new net.Socket())` + `http.ServerResponse` with `end` overridden; auth.ts run after `process.chdir(mkdtemp)`. On Windows import repo files via `pathToFileURL(...).href`, and chdir out of the temp folder before `rmSync` (EBUSY otherwise).

Related: [[review-conventions]], [[account-signin-review-checks]], [[ui-dialog-review-checks]].
