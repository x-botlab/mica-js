import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The editors never inject their chrome; the host decides when the stylesheets load.
import '@mica-js/canvas-editor/style.css';
import '@mica-js/schematic-editor/style.css';
import { App } from './App';
import './index.css';

const container = document.querySelector('#root');
if (container === null) {
  throw new Error('Missing #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
