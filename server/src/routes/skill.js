// GET /SKILL.md — agent-readable instructions. Users paste one line ("Render my Remotion
// video with Darkroom: <host>/SKILL.md") and the agent reads everything else from here.
import config from '../config.js';
import { priceSheet } from '../billing/pricing.js';

const ERRORS = [
  ['network_blocked', 'The composition fetched a host that is not allowed. Move the asset into `public/` and load it with `staticFile()`, re-bundle, re-upload.'],
  ['composition_not_found', 'No composition with that id. Run `npx remotion compositions src/index.ts` to list ids.'],
  ['limits_exceeded', 'Too long, too many pixels (max 1920×1080 either orientation on the default plan), or fps too high. Lower `scale` or `frameRange`.'],
  ['insufficient_credits', 'Not enough credit. Nothing was charged. Tell the user to add credit at BILLING.'],
  ['bundle_invalid', 'Not a Remotion bundle. Tar the *contents* of the bundle folder (`-C build .`) so index.html is at the root.'],
  ['version_unsupported', `Remotion older than ${config.minRemotionVersion}. Upgrade the project.`],
  ['render_error', 'The composition threw while rendering. `error.message` has the stack; fix the code and retry.'],
  ['timeout', 'The render ran past the time limit. Split it with `frameRange`.'],
  ['too_many_active_jobs', 'Too many jobs queued or rendering. Wait for one to finish.'],
];

export function skillMarkdown() {
  const base = config.publicBaseUrl;
  const p = priceSheet();
  const errors = ERRORS.map(([c, t]) => `| \`${c}\` | ${t.replace('BILLING', `${base}/app/billing`)} |`).join('\n');
  return `---
name: darkroom
description: Render a Remotion video on Darkroom's GPU and get back an mp4 URL. Use when the user asks to render, export or make an mp4 of a Remotion composition with Darkroom.
---

# Darkroom — render Remotion videos

Darkroom renders a **finished Remotion bundle** and returns a link to the mp4. It never runs
\`npm install\` and never sees source code — you bundle locally, upload, then poll.

API base: \`${base}\`

## 0. API key

Use \`$DARKROOM_API_KEY\` if it is set. Otherwise ask the user for a key (starts with \`dr_live_\`);
they make one at ${base}/app/keys. Never print the key back or commit it.

If a \`darkroom\` MCP server is already connected (tools \`create_upload\`, \`submit_render\`, \`get_job\`),
use those tools instead of the curl calls below — same flow.

## 1. Check the composition

- Find the entry point (usually \`src/index.ts\` or \`remotion/index.ts\`) and the composition id
  (\`npx remotion compositions <entry>\`).
- **Network rule:** renders can only reach ${config.egressAllowlist.map((h) => `\`${h}\``).join(', ')}.
  Any image, video, audio or font from anywhere else must live in \`public/\` and load with
  \`staticFile('name.ext')\`. Remote URLs to other hosts fail with \`network_blocked\`.
- Default plan max is 1920×1080 pixels (either orientation). Keep \`scale\` so width×height ≤ 2,073,600.

## 2. Bundle

\`\`\`bash
npx remotion bundle src/index.ts --out-dir build
tar -czf bundle.tar.gz -C build .
\`\`\`

## 3. Upload

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $DARKROOM_API_KEY" ${base}/v1/uploads
# → { "uploadId": "...", "uploadUrl": "...", "expiresAt": "...", "maxBytes": ... }

curl -fsS -T bundle.tar.gz '<uploadUrl>'   # one-time link, valid 15 min, no key needed
\`\`\`

## 4. Render

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $DARKROOM_API_KEY" -H 'Content-Type: application/json' \\
  -d '{"uploadId":"<uploadId>","composition":"<CompositionId>"}' ${base}/v1/jobs
\`\`\`

Optional fields: \`inputProps\` (object), \`frameRange\` (\`[start, end]\`), \`scale\` (0.25–4),
\`crf\` (0–51), \`webhookUrl\` (public https URL, POSTed the job when it finishes).

## 5. Poll

\`\`\`bash
curl -s -H "Authorization: Bearer $DARKROOM_API_KEY" ${base}/v1/jobs/<id>
\`\`\`

Poll about every 10 s until \`status\` is \`done\`, \`failed\` or \`canceled\`. When done, give the user
\`outputUrl\` (and download it if they asked for a file). Videos are deleted after ${config.retentionDays} days.
Cancel with \`DELETE /v1/jobs/<id>\`.

## Errors

On failure, \`error.code\` says what to do:

| code | fix |
|---|---|
${errors}

## Price

$${p.perMinute} per video-minute at ≤1080p, minimum ${p.minSeconds} s per job, billed per second.
Failed and canceled jobs are free.
`;
}

export function skillRoute(_req, res) {
  res.type('text/markdown; charset=utf-8').setHeader('Cache-Control', 'public, max-age=300');
  res.send(skillMarkdown());
}
