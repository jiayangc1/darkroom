# Darkroom

A render service for AI agents. An agent uploads a finished Remotion bundle; a GPU worker (a Mac
Studio) renders it; the agent gets back a CDN link to the mp4.

**https://darkroom.jiayangchen.com** — sign up (waitlist + invite codes), make an API key, buy
prepaid credit, and connect an agent over MCP. `darkroom.lsjc.dev` serves the same app.

```
agent ──POST /v1/jobs (bundle.tar.gz)──▶ server (Express + Postgres, Coolify) ──▶ BunnyCDN storage
                                             ▲  │
            worker pulls jobs (outbound only)│  │ bundle / output streamed through the server
                                             │  ▼
                                   Mac worker ── child process per job: Remotion + Chrome (GPU)
                                                  Chrome forced through a filtering proxy
```

- `server/` — public API, worker API, job queue (`FOR UPDATE SKIP LOCKED` + leases), sweeper, webhooks.
- `worker/` — macOS worker: tiny poller + one render process per job.
- `cli/` — `darkroom submit ./bundle --composition X --out video.mp4`.
- `web/` — the dashboard (Vite + React SPA, Clerk sign-in), built into the server image.
- Design: `docs/superpowers/specs/2026-11-19-render-job-system-design.md` (job system) and
  `docs/superpowers/specs/2026-11-19-paid-service-design.md` (accounts, credits, MCP, dashboard).

## Pricing and plans

Prepaid credit (Stripe Checkout, packs of $10 / $25 / $100, tax added at checkout). A job costs
`max(15, ceil(seconds)) × $0.0025 × tier`, where tier is 1× up to 1920×1080 pixels (either
orientation), 2× up to 2560×1440, 4× above. The cost is reserved when the worker reads the
composition (`video-meta`) and charged when the job is `done`; failed and canceled jobs are free.

| plan | how | limits |
|---|---|---|
| `waitlist` | signed up, not let in | can't create keys or render |
| `trial` | invite code or admin approval; $1.50 once | 1 active job, ≤1920×1080 px, ≤120 s |
| `paid` | first purchase | defaults (5 active, 600 s, 4K) |
| `internal` | admin-CLI accounts (the owner) | never charged |

## MCP (agents)

Streamable HTTP, stateless, at `/mcp`, authenticated with the same API key:

```bash
claude mcp add --transport http darkroom https://darkroom.jiayangchen.com/mcp \
  --header "Authorization: Bearer dr_live_…"
```

Tools: `create_upload` → (agent runs the returned `curl`) → `submit_render` → `get_job`;
plus `list_jobs`, `cancel_job`, `get_balance`.

## API (agents)

Auth: `Authorization: Bearer dr_live_…`. Errors are `{ "error": { "code", "message" } }`.

### `POST /v1/jobs` — multipart/form-data

| part | |
|---|---|
| `bundle` (file) | `.tar.gz` of the output folder of `npx remotion bundle` (index.html at the root) |
| `job` (field, JSON) | `{ "composition": "MyComp", "inputProps": {…}, "frameRange": [0, 299], "scale": 1, "crf": 18, "codec": "h264", "webhookUrl": "https://…" }` — only `composition` is required |

The Remotion version is read from the bundle (minimum 4.0.0). Returns `202` with the job.

```bash
npx remotion bundle src/index.ts --out-dir build
tar -czf bundle.tar.gz -C build .
curl -H "Authorization: Bearer $KEY" -F bundle=@bundle.tar.gz \
  --form-string 'job={"composition":"MyComp"}' https://<server>/v1/jobs
```

### Upload links (two steps; the upload needs no API key)

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" https://<server>/v1/uploads
# → { uploadId, uploadUrl, expiresAt, maxBytes, curl }   (valid 15 min, single use)
curl -fsS -T bundle.tar.gz '<uploadUrl>'                # → { uploadId, bytes, remotionVersion }
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"uploadId":"…","composition":"MyComp"}' https://<server>/v1/jobs
```

Unused uploads are deleted after an hour.

### `GET /v1/jobs/:id`, `GET /v1/jobs?limit=20&before=<createdAt>`, `DELETE /v1/jobs/:id` (cancel)

Job: `{ id, status, progress, stage, composition, remotionVersion, error, outputUrl, video, attempts, createdAt, startedAt, finishedAt, expiresAt, cost, estimatedCost }`
(costs are USD strings). `GET /v1/jobs/:id` also has `queuePosition` and `worker`
(`rendering` / `idle` / `paused` with `until` / `offline`).
Statuses: `uploading → queued → rendering → uploading_output → done`, or `failed` / `canceled` / `expired`
(outputs are deleted after 7 days).

### Network rule

Renders have **no internet access** except: `fonts.googleapis.com`, `fonts.gstatic.com`,
`cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`. Put every other asset in the bundle
(`staticFile()`). A blocked request fails the job with `network_blocked`, naming the host.

### Error codes

`bundle_invalid`, `bundle_too_large`, `version_unsupported`, `composition_not_found`,
`limits_exceeded` (default: 10 min, 3840×2160), `network_blocked`, `render_error`, `timeout`,
`worker_lost`, `storage_error`, `too_many_active_jobs`, `rate_limited`, `canceled`,
`insufficient_credits` (402), `not_approved` (403, waitlisted), `upload_invalid`, `upload_in_progress`.
`limits_exceeded` also covers frame rates above 60 fps.

### Webhooks

On `done` / `failed` / `canceled`, Darkroom POSTs `{ "event": "job.done", "job": {…} }` with
`Darkroom-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(webhookSecret, "<t>.<raw body>")`.
Retries after 1, 5, 30, 120 minutes.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const [t, v1] = sig.split(',').map((p) => p.split('=')[1]);
const ok = timingSafeEqual(Buffer.from(v1), Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')));
```

## Server

Env: see `server/.env.example` (adds Clerk, Stripe, `ADMIN_CLERK_USER_IDS`, `SIGNUP_MODE`, prices).
Runs migrations on boot. Webhooks it receives: `POST /webhooks/stripe`
(`checkout.session.completed`, `checkout.session.async_payment_succeeded`) and
`POST /webhooks/clerk` (`user.deleted`). Deploy with `server/Dockerfile`
(build context = repo root).

Production: `https://darkroom.lsjc.dev` on Coolify (project "Darkroom", app `darkroom-server`,
Postgres `darkroom-postgres`), files at `https://darkroom-files.b-cdn.net`. Notes:
- Coolify's own health check is off (it needs curl/wget); the image has a Node `HEALTHCHECK`.
- DNS is a Cloudflare CNAME to `a.lsjc.dev`, **DNS-only** — Cloudflare's proxy caps uploads at 100 MB.
- Run admin commands with a Coolify one-off scheduled task in container `darkroom-server`.

Admin (inside the container or locally with `DATABASE_URL`):

```bash
npm run admin -w server -- account:create "Acme"        # prints id + webhook secret
npm run admin -w server -- key:create <accountId> label # prints API key once
npm run admin -w server -- worker:create mac-studio     # prints worker token once (avoid on Coolify: its logs mask it)
# Better: generate the token yourself and register only its hash
T="drw_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"; printf %s "$T" | shasum -a 256
npm run admin -w server -- worker:register mac-studio <sha256>
npm run admin -w server -- account:limits <id> '{"maxActiveJobs":10}'
npm run admin -w server -- account:plan <id> waitlist|trial|paid|internal
```

## Mac worker

```bash
brew install node
git clone … darkroom && cd darkroom
worker/macos/setup.sh          # first run creates worker/.env — set SERVER_URL + WORKER_TOKEN
worker/macos/setup.sh          # installs the LaunchAgent and starts it
sudo pmset -c sleep 0 disksleep 0
```

The worker runs in your login session (GPU access needs it) and starts when you log in.

```bash
node worker/bin/darkroom-worker.js status
node worker/bin/darkroom-worker.js pause          # finish the current job, then stop taking jobs
node worker/bin/darkroom-worker.js pause --now    # hand the current job back immediately
node worker/bin/darkroom-worker.js resume
tail -f ~/Library/Logs/darkroom-worker/worker.log
```

Isolation: Chrome is forced through a filtering proxy (bundle server + allowlist only, checked
before DNS); Node sockets are guarded; ffmpeg and the compositor run under `sandbox-exec` with no
network and no access to your home folder outside the job. Chrome always comes from the worker's
`CHROME_REMOTION_VERSION`, never from the bundle's Remotion version.

Memory: idle it is one small Node process; under launchd it exits after every job so all render
memory goes back to the system. It only takes a job when `MIN_FREE_GB` (8) is available,
uses one Chrome tab per `GB_PER_TAB` (2) up to `MAX_TABS` (4), and hands the job back if macOS
reports critical memory pressure. `PAUSE_SCHEDULE=09:00-18:00` blocks hours for model work.

## CLI

```bash
export DARKROOM_API_URL=https://<server> DARKROOM_API_KEY=dr_live_…
node cli/bin/darkroom.js submit ./build --composition MyComp --out video.mp4
```
