import { createRoot } from 'react-dom/client';
import App from './App';
import { useGame } from './game/store';
import { getEngine, useApp } from './store';
import './index.css';

// No StrictMode: its dev-only double mount would build the GPU scene (90k buildings) twice.
if (import.meta.env.DEV) {
  Object.assign(window, { __app: useApp, __engine: getEngine, __game: useGame });
  void import('./game/dev').then((m) => m.installDevTools());
}

createRoot(document.getElementById('root')!).render(<App />);
