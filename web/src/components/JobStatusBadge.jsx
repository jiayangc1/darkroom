const STYLE = {
  uploading: 'text-safelight border-safelight/40',
  queued: 'text-safelight border-safelight/40',
  rendering: 'text-safelight border-safelight bg-safelight/10',
  uploading_output: 'text-safelight border-safelight bg-safelight/10',
  done: 'text-fixer border-fixer/40',
  failed: 'text-stopbath border-stopbath/50',
  canceled: 'text-dim border-seam',
  expired: 'text-dim border-seam',
};
const LABEL = { uploading_output: 'saving', uploading: 'uploading' };

export default function JobStatusBadge({ status, progress }) {
  const live = status === 'rendering';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider ${STYLE[status] || 'text-dim border-seam'}`}>
      {live && <span className="h-1.5 w-1.5 rounded-full bg-safelight motion-safe:animate-pulse" />}
      {LABEL[status] || status}
      {live && typeof progress === 'number' && <span>{Math.round(progress * 100)}%</span>}
    </span>
  );
}
