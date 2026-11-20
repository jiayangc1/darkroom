/** "$0.0375" for small amounts, "$12.50" otherwise. Input is the API's USD decimal string. */
export function money(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  const s = abs !== 0 && abs < 1 ? abs.toFixed(4).replace(/0{1,2}$/, '') : abs.toFixed(2);
  return `${n < 0 ? '−' : ''}$${s}`;
}

export const seconds = (video) => (video?.fps ? `${(video.frames / video.fps).toFixed(1)} s` : '—');
export const resolution = (video) => (video?.width ? `${video.width}×${video.height}` : '—');

export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export const ACTIVE = ['uploading', 'queued', 'rendering', 'uploading_output'];
