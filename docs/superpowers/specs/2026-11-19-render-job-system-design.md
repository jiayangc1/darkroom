# Render job system — design

Date: 2026-11-19
Status: approved 2026-11-19

## Intent

A paid **render service for AI agents**. An agent has already written a Remotion
video and bundled it; it uploads the bundle, a GPU machine renders it, and the
agent gets back a CDN link to the finished mp4. The first worker is the owner's
M3 Ultra Mac Studio.

Why: our own Remotion shorts (55gms-ad, doctors-ad, …) render on a CPU-only VM
with `--gl=swangle` at ~7 s/frame (a 67 s ad took hours). On a real GPU the same
render should take minutes. This system is both the offload path for our own
videos and the job system the paid service will be built on.

This document covers **project 1: the job system + Mac worker**. Project 2 (the
paid service on top — web dashboard, signup/JWT accounts, payments, MCP server)
comes after and builds on this one.

## Goals

- Agents submit a pre-built Remotion bundle + composition ID + input props and
  get back a job ID immediately.
- Jobs queue on a control server; one or more workers pull and render them on
  GPU; output goes to BunnyCDN; the agent polls or receives a webhook.
- Every job belongs to an account with API keys; render usage is recorded per
  account so billing can be added later.
- Customer code can never reach the owner's home network or files.
- The Mac is never reachable from the internet.
- A failed or killed render is retried, never silently lost.
- Our own renders from this VM go through the same API (small CLI client).
- **Light on RAM.** The owner also runs local AI models on the Mac, so the
  worker must use almost no memory when idle and must not starve them while
  rendering (see "Memory use").

## Non-goals (this project)

- Writing scripts, generating voice, scene planning, approvals — the service only
  renders.
- Accepting project **source** (no `npm install` / bundling of customer code).
- Web dashboard, self-serve signup, payments, MCP server (project 2).
- Non-Remotion renderers.
- Linux/NVIDIA workers (the protocol must not rule them out, but only the macOS
  worker is built now).

## Anti-goals (failure even if it "works")

- Customer bundle JS can reach any LAN address, the Mac's other localhost
  services, or the Mac's filesystem outside the job's temp dir.
- The Mac accepts inbound connections from the internet.
- A job vanishes (worker crash, Mac sleep, server restart) without ending in
  `done` / `failed` / `canceled`.
- Temp dirs or downloaded bundles accumulate on the Mac until the disk fills
  (current `remotion render` leaves bundle copies behind — must not repeat).

## Constraints

- Owner's stack: Node.js ES modules, Express 4, PostgreSQL via `pg` (optional
  `DATABASE_URL`), BunnyCDN for storage, Busboy for streaming uploads,
  `file-type`, Helmet, rate limiting, SSRF protection with `ipaddr.js` + a custom
  URL validator. Same conventions as the owner's other projects.
- Server deploys to the owner's Coolify (Docker). Postgres also on Coolify.
- Worker runs on macOS (Apple Silicon), as a `launchd` user agent in the owner's login session.
- No tests written or run unless the owner asks (owner's global rule).
- Semantic commit messages; commit as progress is made.
- Remotion licensing: owner must check Remotion's license terms for rendering for
  paying customers before charging. Not a build blocker.

## Approaches considered

1. **Worker pulls jobs from the control server (chosen).** Mac makes outbound
   HTTPS only: claim, progress, complete/fail. Adding a second worker = running
   the same program elsewhere.
2. Server pushes jobs to the Mac over Cloudflare Tunnel / Tailscale. Rejected:
   the Mac must accept inbound connections, and every worker needs manual wiring.
3. Redis/BullMQ queue. Rejected: an extra service with no benefit at this scale;
   Postgres `SELECT … FOR UPDATE SKIP LOCKED` is enough.
4. Isolate each render in a Linux VM on the Mac. Rejected: Apple Silicon VMs
   don't get usable GPU acceleration for Chrome, which defeats the purpose.
   Isolation is done with Chrome's sandbox + a filtering proxy instead.

Input format was decided as **finished bundles only** (output of
`npx remotion bundle`), not project source, so no third-party install scripts
ever run on the Mac.

## Design

### Repo layout

New repo `~/code/render-service` (monorepo, npm workspaces):

- `server/` — control server (Express API + Postgres + Bunny client + cleanup jobs)
- `worker/` — macOS render worker (+ `launchd` plist, setup script)
- `cli/` — small client: `render submit ./bundle --composition X --props p.json`
  → uploads, waits, downloads the mp4. Used from our VM for our own videos.
- `docs/`

### Data model (Postgres)

- `accounts` — id, name, created_at, limits (max concurrent jobs, max duration,
  etc.; defaults in config).
- `api_keys` — id, account_id, prefix, hash (store only a hash; show the key once
  on creation), label, created_at, last_used_at, revoked_at. Keys created with a
  server-side admin CLI for now.
- `workers` — id, name, token hash, last_seen_at, capabilities (e.g. platform,
  max concurrency).
- `jobs` — id, account_id, status, composition_id, input_props (jsonb),
  render_options (jsonb), remotion_version, bundle storage path + size,
  output storage path + CDN URL, webhook_url, progress (0–1), attempts,
  worker_id, lease_expires_at, error (code + message), composition metadata
  (fps, frames, width, height), render_seconds (wall time on worker),
  video_seconds, timestamps (created, started, finished, expires_at).
- `job_events` — append-only log of state changes per job (debugging + audit).

### Job lifecycle

`uploading → queued → rendering → uploading_output → done`
plus terminal `failed`, `canceled`, and `expired` (output deleted after retention).

- **Claim:** worker calls claim; server picks the oldest `queued` job with
  `FOR UPDATE SKIP LOCKED`, sets `rendering`, worker_id, lease (e.g. 60 s).
- **Heartbeat:** progress updates extend the lease.
- **Lease expiry:** a server sweep returns expired jobs to `queued` (attempts+1);
  after 3 attempts → `failed` with code `worker_lost`.
- **Deterministic failures** (bad bundle, composition not found, limits exceeded,
  JS error in the composition) fail immediately without retry.
- **Cancel:** agent can cancel a queued or rendering job; worker sees the cancel
  on its next heartbeat response and aborts.

### Public API (agents) — `/v1`, API key in `Authorization: Bearer`

- `POST /v1/jobs` — multipart: file part `bundle` (`.tar.gz` of the bundle dir)
  + field `job` (JSON: `composition`, `inputProps`, `remotionVersion`, optional
  `frameRange`, `scale`, `codec` (default h264), `crf`, `webhookUrl`).
  Streams the upload via Busboy straight to Bunny Storage (no full buffering),
  enforces a max size, then queues. Returns `{ id, status }`.
- `GET /v1/jobs/:id` — status, progress, error, output URL when done, expiry.
- `GET /v1/jobs` — the account's jobs, paginated.
- `DELETE /v1/jobs/:id` — cancel.
- **Webhook** (optional): POST on terminal state, JSON body, HMAC-SHA256
  signature header using a per-account secret; retried a few times with backoff.
  The webhook URL is checked with the SSRF validator (public addresses only)
  at submit time and again at send time.
- Rate limiting per API key; per-account max concurrent queued+rendering jobs.

### Worker API — `/worker`, worker token auth

- `POST /worker/claim` — long-poll (e.g. up to 30 s); returns a job or 204.
  Includes a short-lived signed URL / proxied stream for downloading the bundle.
- `POST /worker/jobs/:id/progress` — progress + heartbeat; response says
  whether the job was canceled.
- `POST /worker/jobs/:id/output` — streams the mp4 up; server writes it to Bunny
  (the worker never holds Bunny credentials).
- `POST /worker/jobs/:id/complete` / `fail` — final metadata or error code.

### Render flow on the worker

1. Claim job → create a fresh temp dir owned by the worker user.
2. Download the bundle archive; extract safely: reject symlinks, hard links,
   absolute paths, `..`; cap total uncompressed size and file count. Must contain
   `index.html` at the root.
3. Ensure the Remotion renderer for `remotionVersion` is installed in a
   per-version cache (`@remotion/renderer@<version>` from npm). Only Remotion's
   own packages are installed; customer code is never installed. Reject versions
   below a configured minimum (Remotion 4.x).
4. `selectComposition` → read fps / frames / size; enforce limits (max duration,
   max resolution) before rendering; fail with a clear error code otherwise.
5. `renderMedia` with `gl: 'angle'`, configurable concurrency (tabs), report
   progress every few seconds.
6. Upload output, mark complete, **always** delete the temp dir (finally block +
   a startup sweep for leftovers).

One job at a time per worker, using several Chrome tabs; tab count follows
free memory (see "Memory use").

### Network isolation (customer code)

Decided (2026-11-19): the worker runs as the **owner's own macOS user**, not a
dedicated user, because Chrome may only get GPU access inside a logged-in
desktop session. This trades away "no access to the owner's files" as a separate
OS user; protection relies on Chrome's own sandbox (never disabled) plus:

1. **Filtering proxy inside the worker.** Chrome is launched with its traffic
   forced through a local HTTP/CONNECT proxy, **including loopback** (so bundle JS
   cannot reach other localhost services). The proxy allows the renderer's own
   local bundle server and denies private, loopback (other than the allowed
   port), link-local, CGNAT, multicast and metadata ranges, checked with
   `ipaddr.js` **after DNS resolution** (connect to the resolved IP to prevent
   rebinding). Public internet: allowlist only, see "Internet access" below.
   Disable WebRTC paths that bypass the proxy.
2. **Node-side fetches are filtered too.** Remotion downloads some media
   (e.g. `<OffthreadVideo>` / remote assets) from Node, outside Chrome. Those
   requests must go through the same allow/deny check, or be refused.
3. A per-user `pf` rule is **not** possible (it would block the owner too), so
   there is no firewall backstop; the hostile test bundle (below) is the
   safeguard.

A setup script on the Mac installs the `launchd` user agent (runs in the
owner's login session) and sets `pmset` so the machine doesn't sleep. The
worker only runs while the owner is logged in; after a reboot it starts again
on login.

First build step: confirm on the Mac that `gl: 'angle'` actually uses the GPU
when launched from the `launchd` agent (compare frame times against swangle).

How Remotion lets us pass Chrome flags (proxy, bypass list) is for the builder to
work out; if Remotion can't, the worker launches the browser itself and hands it
to Remotion. The isolation must be verified with a deliberately hostile test
bundle that tries LAN IPs, localhost ports, and DNS-rebinding names.

### Internet access: allowlist only

Decided (2026-11-19): customer renders get **no internet access except a short
domain allowlist** (config). Default list: Google Fonts (`fonts.googleapis.com`,
`fonts.gstatic.com`) plus a few common static CDNs (`cdn.jsdelivr.net`,
`unpkg.com`, `cdnjs.cloudflare.com`). Allowed domains still go through the
post-DNS private-address check. Everything else must be inside the bundle
(`staticFile()`); a blocked request fails the job with a clear error code
(`network_blocked`, naming the host) so the agent knows how to fix it. The API
docs state this rule up front. The same policy applies to Node-side fetches.

### Storage (BunnyCDN)

- Bunny Storage zone, paths `bundles/<account>/<job>.tar.gz` and
  `outputs/<account>/<job>.mp4`; outputs served via the pull zone CDN URL.
- Bundles deleted once the job reaches a terminal state.
- Outputs deleted after **7 days** (configurable); job → `expired`.
- A server-side periodic task handles lease sweeps, expirations, and deletions.

### Memory use

The Mac's unified memory is shared with the owner's local AI models.

- **Idle = one small Node process.** The long-running worker only polls the
  server; it never imports Remotion and keeps no browser open. Target: well
  under 100 MB resident while idle.
- **Each job runs in a child process** that loads the version-specific
  renderer, launches Chrome, renders, and exits. When it exits, Chrome, the
  renderer and all render memory are released. Nothing is kept warm between jobs.
- **Check memory before claiming.** The worker only claims a job when free memory
  (from macOS `vm_stat` / memory pressure) is above a configured floor. Otherwise
  it waits and checks again, and the job stays queued for other workers.
- **Tabs scale to free memory.** Concurrency = min(configured max, free memory ÷
  per-tab estimate (~2 GB)), at least 1.
- **Back off under pressure.** While rendering, if macOS memory pressure turns
  critical, the worker aborts the job and returns it to the queue (not counted
  as a failed attempt), then waits before claiming again.
- **Pause switch.** A local command (`render-worker pause` / `resume`) and an
  optional schedule of hours when the worker doesn't claim jobs, so the owner
  can free the machine for model work. A pause lets the current job finish
  unless `--now` is given.

### Usage recording

Per job: `render_seconds` (worker wall-clock), `video_seconds`, frames,
resolution. Enough to bill from later; no billing now.

### Operations

- Server: Dockerfile, deployed on Coolify, Postgres on Coolify, env-based config.
- Worker: env/config file (server URL, worker token, concurrency, cache dir,
  temp dir), `launchd` keep-alive, logs to a file with rotation.
- Admin CLI on the server: create account, create/revoke API key, register worker.

## Left to the builder

- Exact numeric limits (bundle size, max duration, max resolution, rate limits,
  lease length) — pick sensible defaults, make them config.
- Table/column details, migrations tool (plain SQL files are fine).
- How the bundle download reaches the worker (signed Bunny URL vs. server stream).
- How `remotionVersion` is cross-checked against the bundle, if detectable.
- Progress reporting interval, webhook retry schedule, log format.
- CLI ergonomics.
