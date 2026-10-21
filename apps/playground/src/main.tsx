import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
