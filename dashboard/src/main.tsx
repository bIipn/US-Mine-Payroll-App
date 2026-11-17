import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { noteArrival } from './lib/intent';
import './styles.css';

// Sent from the website's "Start free trial": keep the wish, and take it off the address.
noteArrival();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
