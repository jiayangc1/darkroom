import { useState } from 'react';
import { Link } from 'react-router';
import { useConfig } from '../config.js';
import CodeBlock from '../components/CodeBlock.jsx';

const ERRORS = [
  ['network_blocked', 'The composition fetched a host that isn\'t allowed. Put the asset in the bundle with staticFile().'],
  ['composition_not_found', 'No composition with that id in the bundle.'],
  ['limits_exceeded', 'Too long, too large, or a frame rate over the limit for your plan.'],
  ['insufficient_credits', 'Not enough credit for this video. Nothing was charged.'],
  ['bundle_invalid', 'Not a Remotion bundle. Tar the contents of the bundle folder so index.html is at the root.'],
  ['version_unsupported', 'Remotion older than 4.0.0.'],
  ['render_error', 'The composition threw while rendering. The message has the stack.'],
  ['timeout', 'The render ran past the time limit.'],
  ['too_many_active_jobs', 'Too many jobs queued or rendering at once. Wait for one to finish.'],
];

const TABS = ['Claude Code', 'Cursor', 'Codex', 'REST / curl'];

export default function GetStarted() {
  const config = useConfig();
  const origin = window.location.origin;
  const [tab, setTab] = useState(TABS[0]);
  const key = 'dr_live_YOUR_KEY';

  const snippets = {
    'Claude Code': `claude mcp add --transport http darkroom ${origin}/mcp \\\n  --header "Authorization: Bearer ${key}"`,
    Cursor: `// ~/.cursor/mcp.json\n{\n  "mcpServers": {\n    "darkroom": {\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer ${key}" }\n    }\n  }\n}`,
    Codex: `# ~/.codex/config.toml  (export DARKROOM_API_KEY=${key})\n[mcp_servers.darkroom]\nurl = "${origin}/mcp"\nbearer_token_env_var = "DARKROOM_API_KEY"`,
    'REST / curl': `# 1. get an upload link\ncurl -s -X POST -H "Authorization: Bearer $DARKROOM_API_KEY" ${origin}/v1/uploads\n\n# 2. upload the bundle to the uploadUrl it returns (no key needed)\ncurl -fsS -T bundle.tar.gz '<uploadUrl>'\n\n# 3. render it\ncurl -s -H "Authorization: Bearer $DARKROOM_API_KEY" -H 'Content-Type: application/json' \\\n  -d '{"uploadId":"<uploadId>","composition":"MyComp"}' ${origin}/v1/jobs\n\n# 4. poll until status is done; the mp4 is at outputUrl\ncurl -s -H "Authorization: Bearer $DARKROOM_API_KEY" ${origin}/v1/jobs/<id>`,
  };

  return (
    <div className="max-w-3xl">
      <div className="eyebrow">Setup</div>
      <h1 className="h-display mt-1 text-5xl">Connect an agent</h1>
      <p className="mt-3 text-dim">
        Darkroom renders Remotion videos your agent has already written. The agent bundles the project, uploads it,
        and gets back a link to the mp4. Make a key on <Link to="/app/keys" className="text-safelight hover:underline">API keys</Link>,
        then add Darkroom to your agent:
      </p>

      <div className="mt-8 flex gap-1 border-b border-seam" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-safelight text-paper' : 'border-transparent text-dim hover:text-paper'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mt-4"><CodeBlock>{snippets[tab]}</CodeBlock></div>
      {tab !== 'REST / curl' && (
        <p className="mt-3 text-sm text-dim">
          Then ask: <span className="text-paper">“Render the Intro composition with Darkroom.”</span> The agent gets an upload link,
          runs the bundle and upload commands itself, and polls until the video is ready.
        </p>
      )}

      <h2 className="mt-12 text-lg font-semibold">What to send</h2>
      <p className="mt-1 text-sm text-dim">A finished bundle, not source code. Darkroom never runs npm install.</p>
      <div className="mt-4"><CodeBlock>{'npx remotion bundle src/index.ts --out-dir build\ntar -czf bundle.tar.gz -C build .'}</CodeBlock></div>

      <h2 className="mt-12 text-lg font-semibold">Network rule</h2>
      <p className="mt-1 text-sm text-dim">
        Renders can't reach the internet except{' '}
        {config.allowlist.map((h, i) => <span key={h}><code className="code text-paper">{h}</code>{i < config.allowlist.length - 1 ? ', ' : ''}</span>)}.
        Put images, video, audio and fonts from anywhere else in the bundle and load them with <code className="code">staticFile()</code>.
      </p>

      <h2 className="mt-12 text-lg font-semibold">When a render fails</h2>
      <div className="panel mt-4 divide-y divide-seam">
        {ERRORS.map(([code, text]) => (
          <div key={code} className="grid gap-1 p-3 sm:grid-cols-[220px_1fr] sm:gap-4">
            <code className="code text-safelight">{code}</code>
            <span className="text-sm">{text}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-dim">Finished videos are kept for {config.retentionDays} days.</p>
    </div>
  );
}
