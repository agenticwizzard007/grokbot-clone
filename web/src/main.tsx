import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/config.css'; // Shared control geometry precedes lazy page overrides.
import './styles/scrollbars.css';
import './lib/native';
import './configStore'; // Restore the saved theme before either entry surface renders.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
