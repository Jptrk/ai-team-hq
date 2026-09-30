import path from 'node:path';

/**
 * Loads .env before any other server module is evaluated.
 * Import this first in server/index.ts; ESM evaluates imports in order.
 * The Agent SDK does not read .env on its own.
 */
try {
  process.loadEnvFile(path.resolve('.env'));
} catch {
  // no .env, that's fine
}
