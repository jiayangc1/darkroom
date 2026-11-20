import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, KeyRound, MessageSquareText, Clapperboard } from 'lucide-react';
import { useConfig } from '../config.js';
import CodeBlock from '../components/CodeBlock.jsx';
import CopyButton from '../components/CopyButton.jsx';
import FilmEdge from '../components/FilmEdge.jsx';

const ERRORS = [
  ['network_blocked', 'Fetched a host that isn\'t allowed. Put the asset in the bundle with staticFile().'],
  ['composition_not_found', 'No composition with that id in the bundle.'],
  ['limits_exceeded', 'Too long, too large, or a frame rate over your plan\'s limit.'],
  ['insufficient_credits', 'Not enough credit for this video. Nothing was charged.'],
  ['bundle_invalid', 'Not a Remotion bundle. Tar the folder\'s contents so index.html is at the root.'],
  ['version_unsupported', 'Remotion older than 4.0.0.'],
  ['render_error', 'The composition threw while rendering. The message has the stack.'],
  ['timeout', 'The render ran past the time limit.'],
  ['too_many_active_jobs', 'Too many jobs queued or rendering at once.'],
];

const TABS = ['Claude Code', 'Cursor', 'Codex', 'curl'];

const STEPS = [
  { icon: KeyRound, title: 'Make a key', body: <>Create one on <Link to="/app/keys" className="text-safelight hover:underline">API keys</Link>. Your agent asks for it, or reads <code className="code">DARKROOM_API_KEY</code>.</> },
  { icon: MessageSquareText, title: 'Paste the line', body: 'The agent reads the skill, bundles your Remotion project and uploads it.' },
  { icon: Clapperboard, title: 'Get the mp4', body: 'It polls until the render is done and hands you the link.' },
];

export default function GetStarted() {
  const config = useConfig();
  const origin = window.location.origin;
  const host = window.location.host;
  const [tab, setTab] = useState(TABS[0]);
  const key = 'dr_live_YOUR_KEY';
  const prompt = `Render my Remotion video with Darkroom: ${host}/SKILL.md`;

  const snippets = {
    'Claude Code': `claude mcp add --transport http darkroom ${origin}/mcp \\\n  --header "Authorization: Bearer ${key}"`,
    Cursor: `// ~/.cursor/mcp.json\n{\n  "mcpServers": {\n    "darkroom": {\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer ${key}" }\n    }\n  }\n}`,
    Codex: `# ~/.codex/config.toml  (export DARKROOM_API_KEY=${key})\n[mcp_servers.darkroom]\nurl = "${origin}/mcp"\nbearer_token_env_var = "DARKROOM_API_KEY"`,
    curl: `# 1. get an upload link\ncurl -s -X POST -H "Authorization: Bearer $DARKROOM_API_KEY" ${origin}/v1/uploads\n\n# 2. upload the bundle to the uploadUrl it returns (no key needed)\ncurl -fsS -T bundle.tar.gz '<uploadUrl>'\n\n# 3. render it\ncurl -s -H "Authorization: Bearer $DARKROOM_API_KEY" -H 'Content-Type: application/json' \\\n  -d '{"uploadId":"<uploadId>","composition":"MyComp"}' ${origin}/v1/jobs\n\n# 4. poll until status is done; the mp4 is at outputUrl\ncurl -s -H "Authorization: Bearer $DARKROOM_API_KEY" ${origin}/v1/jobs/<id>`,
  };

  const tabs = (
    <div className="flex gap-0.5 overflow-x-auto" role="tablist">
      {TABS.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          className={`shrink-0 rounded px-2.5 py-1 text-[13px] ${tab === t ? 'bg-seam text-paper' : 'text-dim hover:text-paper'}`}
        >
          {t}
        </button>
      ))}
    </div>
  );

  return (
    <div className="max-w-3xl pb-16">
      <div className="eyebrow">Setup</div>
      <h1 className="h-display mt-1 text-5xl">Connect an agent</h1>
      <p className="mt-3 max-w-xl text-dim">
        Darkroom renders Remotion videos your agent has already written. Give it one line and it does the rest.
      </p>

      {/* The one-liner, Clerk-style */}
      <section className="develop mt-8 overflow-hidden rounded-xl border border-safelight/40 bg-tray shadow-[0_0_60px_-20px_var(--color-safelight)]">
        <FilmEdge>Darkroom · paste into your agent · Darkroom · paste into your agent · Darkroom</FilmEdge>
        <div className="p-5 sm:p-6">
          <div className="eyebrow text-safelight/80">Paste this into Claude Code, Cursor or Codex</div>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 break-words font-mono text-[15px] leading-relaxed text-paper sm:text-base">
              Render my Remotion video with Darkroom:{' '}
              <span className="text-safelight">{host}/SKILL.md</span>
            </p>
            <CopyButton text={prompt} label="Copy prompt" className="btn-primary self-start sm:self-auto" />
          </div>
          <a
            href="/SKILL.md"
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center gap-1 text-sm text-dim hover:text-paper"
          >
            Read the skill your agent will follow <ArrowUpRight size={14} />
          </a>
        </div>
      </section>

      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="panel p-4">
            <div className="flex items-center justify-between">
              <Icon size={18} strokeWidth={1.75} className="text-safelight" />
              <span className="font-mono text-[11px] text-dim">0{i + 1}</span>
            </div>
            <div className="mt-3 font-medium">{title}</div>
            <p className="mt-1 text-sm leading-relaxed text-dim">{body}</p>
          </li>
        ))}
      </ol>

      <section className="mt-14">
        <h2 className="text-lg font-semibold">Or connect over MCP</h2>
        <p className="mt-1 text-sm text-dim">
          Gives your agent Darkroom tools directly. Then ask: <span className="text-paper">“Render the Intro composition with Darkroom.”</span>
        </p>
        <div className="mt-4"><CodeBlock header={tabs}>{snippets[tab]}</CodeBlock></div>
      </section>

      <section className="mt-14">
        <div className="eyebrow">Reference</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="panel p-4">
            <h3 className="font-medium">What to send</h3>
            <p className="mt-1 text-sm text-dim">A finished bundle, not source. Darkroom never runs npm install.</p>
            <pre className="code mt-3 overflow-x-auto rounded-md bg-room p-3 leading-relaxed text-paper/90">
              {'npx remotion bundle src/index.ts \\\n  --out-dir build\ntar -czf bundle.tar.gz -C build .'}
            </pre>
          </div>
          <div className="panel p-4">
            <h3 className="font-medium">Network rule</h3>
            <p className="mt-1 text-sm text-dim">
              Renders only reach these hosts. Bundle everything else and load it with <code className="code text-paper">staticFile()</code>.
            </p>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {config.allowlist.map((h) => (
                <li key={h} className="code rounded border border-seam bg-room px-2 py-0.5 text-paper/90">{h}</li>
              ))}
            </ul>
          </div>
        </div>

        <h3 className="mt-8 font-medium">When a render fails</h3>
        <p className="mt-1 text-sm text-dim">The job's <code className="code">error.code</code> tells your agent what to fix.</p>
        <dl className="panel mt-3 divide-y divide-seam">
          {ERRORS.map(([code, text]) => (
            <div key={code} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[200px_1fr] sm:gap-4">
              <dt className="code self-center text-safelight">{code}</dt>
              <dd className="text-sm text-paper/85">{text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-dim">Finished videos are kept for {config.retentionDays} days.</p>
      </section>
    </div>
  );
}
