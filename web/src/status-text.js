const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function statusText(s) {
  if (!s) return '…';
  if (s.state === 'rendering') return s.queued ? `Rendering · ${s.queued} waiting` : 'Rendering';
  if (s.state === 'idle') return 'Ready for jobs';
  if (s.state === 'paused') return s.until ? `Paused until ${time(s.until)}` : 'Paused for now';
  return 'Offline';
}
