import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { statusText } from '../status-text.js';

/** One-line render-machine status; polls every 20 s. */
export default function StatusLine() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/status').then((r) => alive && setS(r.data)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const dot = !s ? 'bg-seam' : s.state === 'offline' ? 'bg-stopbath' : s.state === 'paused' ? 'bg-dim' : 'bg-safelight';
  return (
    <div className="flex items-center gap-2 text-xs text-dim" title="The render machine">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span>{statusText(s)}</span>
    </div>
  );
}
