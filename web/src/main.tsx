import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startCustomization } from './customization/runtime';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/customization.css';
import './styles/config.css'; // Shared control geometry precedes lazy page overrides.
import './styles/scrollbars.css';
import './lib/native';
import './configStore'; // Restore the saved theme before either entry surface renders.

startCustomization();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
