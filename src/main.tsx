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
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
