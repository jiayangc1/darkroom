/** A strip of film edge: sprocket holes and edge print. `children` is the printed text. */
export default function FilmEdge({ children }) {
  return (
    <div className="film-edge" aria-hidden="true">
      <div className="whitespace-nowrap px-4 font-mono text-[10px] uppercase tracking-[0.3em] text-safelight/60">{children}</div>
    </div>
  );
}
