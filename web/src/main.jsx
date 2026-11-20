import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

const root = createRoot(document.getElementById('root'));

// The Clerk key comes from the server at runtime, so the same build works in every environment.
fetch('/api/public-config')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
  .then((config) => root.render(<StrictMode><App config={config} /></StrictMode>))
  .catch(() => {
    root.render(
      <div style={{ padding: 32, fontFamily: 'system-ui', color: '#ede3d1', background: '#170d0b', minHeight: '100vh' }}>
        Darkroom can\'t reach its server right now. Reload in a moment.
      </div>,
    );
  });
