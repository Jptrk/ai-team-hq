import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const MARKDOWN = /[\\/]node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|unified|vfile|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|markdown-table|ccount|trim-lines|devlop|bail|trough|zwitch|longest-streak|html-url-attributes|github-slugger|estree-util|style-to|inline-style-parser)/;

// HQ's data (installed skills, fetched repos, projects) and the desks' workspaces sit inside this folder.
// The dev server serves files from here, so a skill's .html at /data/... would load as HQ's own page and
// could call HQ's API. It must never hand them out.
const ROOT = path.resolve(process.cwd()).split(path.sep).join('/');
const PRIVATE = ['data', 'workspaces'];

/**
 * The URL path names a file in data/ or workspaces/: /data/..., /workspaces/..., or /@fs/<this folder>/data/...,
 * in any case, after decoding and with . and .. resolved. Exported for tests.
 */
export function isPrivatePath(url: string, root = ROOT): boolean {
  let p = url.split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not decodable: Vite won't serve it either.
  }
  p = path.posix.normalize(`/${p.replace(/\\/g, '/')}`).toLowerCase();
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const fsBase = `/@fs/${base.replace(/^\//, '')}`;
  return PRIVATE.some((dir) => [`/${dir}`, `${fsBase}/${dir}`].some((start) => p === start || p.startsWith(`${start}/`)));
}

/** 404 for data/ and workspaces/, before any of Vite's own handlers (HTML pages included) see the request. */
function privateFolders(): Plugin {
  return {
    name: 'hq-private-folders',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isPrivatePath(req.url ?? '')) return next();
        res.statusCode = 404;
        res.end('Not found');
      });
    },
  };
}

export default defineConfig({
  plugins: [privateFolders(), react()],
  server: {
    port: 5174,
    // HQ_API_URL points the UI at another API, e.g. a scratch copy for testing.
    proxy: { '/api': process.env.HQ_API_URL ?? 'http://127.0.0.1:4747' },
    fs: {
      // Vite's own list, which a list here replaces, then HQ's private folders.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...PRIVATE.map((dir) => `${ROOT}/${dir}/**`)],
    },
    // Skills, fetched repos and desk files change all the time and are never part of the app.
    watch: { ignored: PRIVATE.map((dir) => `${ROOT}/${dir}/**`) },
  },
  // Look for dependencies from the app's page only, never from .html files in data/ or workspaces/.
  optimizeDeps: { entries: ['index.html'] },
  build: {
    // The editor chunk (ProseMirror + markdown) is about 510 kB; it loads after the app, in the background.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Separate long-lived vendor chunks so app changes don't re-download them.
        manualChunks(id) {
          // The rich text editor loads on first use, in its own chunk.
          if (/[\\/]node_modules[\\/](@tiptap|prosemirror-|marked|orderedmap|rope-sequence|w3c-keyname|linkifyjs)/.test(id)) return 'editor';
          if (MARKDOWN.test(id)) return 'markdown';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons';
          return undefined;
        },
      },
    },
  },
});
