import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/space-grotesk/700.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/markdown.css';
import './styles/views/inbox.css';
import './styles/views/board.css';
import './styles/views/chat.css';
import './styles/views/team.css';
import './styles/views/ticket.css';
import './styles/views/office.css';
import './styles/views/projects.css';
import './styles/views/attachments.css';
import './styles/views/editor.css';
import './styles/views/huddles.css';
import { App } from './App';

// Load the rich text editor in the background, so the first text box you open is ready.
const warm = () => void import('./editor/MarkdownEditor');
if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 3000 });
else setTimeout(warm, 1500);

// A file dropped outside a composer would make the browser navigate to it and lose the page.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
