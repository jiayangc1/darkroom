# Darkroom

A render service for AI agents. An agent uploads a finished Remotion bundle; a GPU worker (a Mac
Studio) renders it; the agent gets back a CDN link to the mp4.

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
- Design: `docs/superpowers/specs/2026-11-19-render-job-system-design.md`.

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

### `GET /v1/jobs/:id`, `GET /v1/jobs?limit=20&before=<createdAt>`, `DELETE /v1/jobs/:id` (cancel)

Job: `{ id, status, progress, stage, composition, remotionVersion, error, outputUrl, video, attempts, createdAt, startedAt, finishedAt, expiresAt }`.
Statuses: `uploading → queued → rendering → uploading_output → done`, or `failed` / `canceled` / `expired`
(outputs are deleted after 7 days).

### Network rule

Renders have **no internet access** except: `fonts.googleapis.com`, `fonts.gstatic.com`,
`cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`. Put every other asset in the bundle
(`staticFile()`). A blocked request fails the job with `network_blocked`, naming the host.

### Error codes

`bundle_invalid`, `bundle_too_large`, `version_unsupported`, `composition_not_found`,
`limits_exceeded` (default: 10 min, 3840×2160), `network_blocked`, `render_error`, `timeout`,
`worker_lost`, `storage_error`, `too_many_active_jobs`, `rate_limited`, `canceled`.

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

Env: see `server/.env.example`. Runs migrations on boot. Deploy with `server/Dockerfile`
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
