import { Link } from 'react-router';
import { useAuth } from '@clerk/react';
import { useConfig } from '../config.js';
import FilmEdge from '../components/FilmEdge.jsx';

const FRAMES = [
  { tool: 'create_upload', text: 'Your agent asks for a one-time upload link.' },
  { tool: 'curl -T bundle.tar.gz', text: 'It bundles the Remotion project and uploads it. No key in the shell.' },
  { tool: 'submit_render', text: 'A GPU renders it, Chrome and ffmpeg sealed off from the network.' },
  { tool: 'get_job → outputUrl', text: 'The finished mp4 comes back as a link.' },
];

export default function Landing() {
  const { isSignedIn } = useAuth();
  const config = useConfig();
  const origin = window.location.origin;
  const per = Number(config.prices.perMinute).toFixed(2);

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <span className="h-display text-3xl">Darkroom</span>
        {isSignedIn ? (
          <Link to="/app" className="btn btn-primary">Open dashboard</Link>
        ) : (
          <div className="flex gap-2">
            <Link to="/sign-in" className="btn">Sign in</Link>
            <Link to="/sign-up" className="btn btn-primary">{config.signupMode === 'open' ? 'Sign up' : 'Join the waitlist'}</Link>
          </div>
        )}
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-14 md:pt-24">
        <div className="eyebrow">Remotion rendering for AI agents</div>
        <h1 className="h-display mt-4 max-w-4xl text-[clamp(3.2rem,9vw,7.5rem)]">
          Your agent wrote the video. <span className="text-safelight">We develop it.</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-dim">
          Agents can write a Remotion composition in minutes, then wait hours for a CPU to render it.
          Darkroom takes the finished bundle over MCP and renders it on a GPU.
        </p>
        <div className="mt-8 max-w-3xl rounded-md border border-seam bg-tray p-4">
          <code className="code block overflow-x-auto whitespace-pre text-paper/90">
            {`claude mcp add --transport http darkroom ${origin}/mcp \\\n  --header "Authorization: Bearer dr_live_…"`}
          </code>
        </div>
      </section>

      {/* The signature: the agent's four tool calls as frames on a strip of film. */}
      <section aria-label="How it works" className="border-y border-seam bg-[#0d0706]">
        <FilmEdge>{'DARKROOM ▸ 1A ▸ 2A ▸ 3A ▸ 4A ▸ SAFETY FILM ▸ '.repeat(8)}</FilmEdge>
        <ol className="mx-auto grid max-w-6xl grid-cols-1 gap-px px-5 sm:grid-cols-2 lg:grid-cols-4">
          {FRAMES.map((f, i) => (
            <li key={f.tool} className="develop my-4 rounded-sm bg-tray p-5" style={{ animationDelay: `${i * 180}ms` }}>
              <div className="font-mono text-[11px] text-safelight/70">{i + 1}A</div>
              <code className="code mt-3 block text-safelight">{f.tool}</code>
              <p className="mt-2 text-sm text-paper/85">{f.text}</p>
            </li>
          ))}
        </ol>
        <FilmEdge>{'DEVELOPED ON GPU ▸ DARKROOM ▸ '.repeat(10)}</FilmEdge>
      </section>

      <section className="mx-auto grid max-w-6xl gap-12 px-5 py-20 md:grid-cols-2">
        <div>
          <h2 className="h-display text-4xl">Pay for the video, not the wait</h2>
          <p className="mt-4 text-dim">
            Prepaid credit, priced by the length of video you get back. You know the price before it renders,
            and failed or canceled renders cost nothing.
          </p>
        </div>
        <dl className="panel divide-y divide-seam">
          {[
            ['Up to 1080p', `$${per} / video-minute`],
            ['1440p', `$${(per * 2).toFixed(2)} / video-minute`],
            ['4K', `$${(per * 4).toFixed(2)} / video-minute`],
            ['Minimum', `${config.prices.minSeconds} s per render`],
            ['Credit packs', config.prices.packs.map((p) => `$${p}`).join(' · ')],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between px-5 py-3.5">
              <dt className="text-sm text-dim">{k}</dt>
              <dd className="font-mono text-sm">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-24">
        <h2 className="h-display text-4xl">Sealed renders</h2>
        <p className="mt-4 max-w-2xl text-dim">
          Bundles render with no internet access except Google Fonts and the jsDelivr, unpkg and cdnjs CDNs.
          Everything else ships inside the bundle. Outputs are kept for {config.retentionDays} days.
        </p>
      </section>

      <footer className="border-t border-seam px-5 py-8 text-center text-xs text-dim">Darkroom</footer>
    </div>
  );
}
