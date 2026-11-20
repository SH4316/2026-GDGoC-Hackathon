import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StationAdmin } from './StationAdmin';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StationAdmin />
  </StrictMode>,
);
