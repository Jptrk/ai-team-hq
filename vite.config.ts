import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const MARKDOWN = /[\\/]node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|unified|vfile|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|markdown-table|ccount|trim-lines|devlop|bail|trough|zwitch|longest-streak|html-url-attributes|github-slugger|estree-util|style-to|inline-style-parser)/;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // HQ_API_URL points the UI at another API, e.g. a scratch copy for testing.
    proxy: { '/api': process.env.HQ_API_URL ?? 'http://127.0.0.1:4747' },
  },
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
