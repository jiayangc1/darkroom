import CopyButton from './CopyButton.jsx';

/** Code with a header bar: `header` (a label or tabs) on the left, copy on the right. */
export default function CodeBlock({ children, header = null, copy = true }) {
  const text = String(children).trim();
  return (
    <div className="overflow-hidden rounded-lg border border-seam bg-room">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-seam bg-tray/60 pl-3 pr-1.5">
        <div className="min-w-0 flex-1">{header}</div>
        {copy && <CopyButton text={text} className="border-transparent py-1 text-dim hover:text-paper" />}
      </div>
      <pre className="code overflow-x-auto p-4 leading-relaxed text-paper/90"><code>{text}</code></pre>
    </div>
  );
}
