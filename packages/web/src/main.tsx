import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const wurzel = document.getElementById('root');
if (!wurzel) throw new Error('#root nicht gefunden');

createRoot(wurzel).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
