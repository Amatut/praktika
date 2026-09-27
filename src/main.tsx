import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { registerServiceWorker } from './pwa/register.ts';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/lesson.css';
import './styles/screens.css';
import './styles/refinement.css';
import './styles/learning-visuals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerServiceWorker();
