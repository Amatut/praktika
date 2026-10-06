import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { registerServiceWorker } from './pwa/register.ts';
// Порядок подключения = каскад: токены → основа → общие компоненты → оболочка → экраны.
// У каждого экрана свой файл (владельцы — в шапке файла).
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/screens/today.css';
import './styles/screens/course.css';
import './styles/screens/projects.css';
import './styles/screens/directions.css';
import './styles/screens/progress.css';
import './styles/screens/settings.css';
import './styles/screens/lesson.css';
import './styles/screens/lesson-steps.css';
import './styles/learning-visuals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerServiceWorker();
