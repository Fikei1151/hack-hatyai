import { createRoot } from 'react-dom/client';
import App from './App';
import { getEngine, useApp } from './store';
import './index.css';

// No StrictMode: its dev-only double mount would build the GPU scene (90k buildings) twice.
if (import.meta.env.DEV) Object.assign(window, { __app: useApp, __engine: getEngine });

createRoot(document.getElementById('root')!).render(<App />);
