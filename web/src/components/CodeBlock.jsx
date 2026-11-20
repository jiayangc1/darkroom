import CopyButton from './CopyButton.jsx';

export default function CodeBlock({ children, copy = true }) {
  const text = String(children).trim();
  return (
    <div className="group relative rounded-md border border-seam bg-room">
      <pre className="code overflow-x-auto p-3 pr-24 leading-relaxed text-paper/90"><code>{text}</code></pre>
      {copy && <CopyButton text={text} className="absolute right-2 top-2 bg-tray py-1" />}
    </div>
  );
}
