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

// Windows starts a program named without a folder (`git`, `python`) from the child's working folder before
// PATH, so a git.exe in a fetched repo or a python.exe in a desk's workspace would run instead. This turns
// that off for every program HQ and its children start. HQ also starts git and Python by full path (proc.ts).
process.env.NoDefaultCurrentDirectoryInExePath = '1';
