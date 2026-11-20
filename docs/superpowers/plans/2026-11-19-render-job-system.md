# Render Job System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A control server (Express + Postgres + BunnyCDN) that accepts pre-built Remotion bundles from agents, and a macOS worker that pulls jobs, renders them on the GPU with network isolation and low RAM use, and returns a CDN link.

**Architecture:** npm-workspaces monorepo. `server/` is a public Express API with a Postgres job queue (`FOR UPDATE SKIP LOCKED` + leases) and a periodic sweeper. `worker/` is a tiny long-running Node poller on the Mac that spawns one child process per job; the child runs Remotion with Chrome forced through a filtering proxy, then exits. `cli/` submits jobs from our dev VM.

**Tech Stack:** Node 22 (ES modules), Express 4, pg, busboy, helmet, express-rate-limit, ipaddr.js, tar-stream, @remotion/renderer (installed per version at runtime on the worker), ESLint 9.

**Spec:** `docs/superpowers/specs/2026-11-19-render-job-system-design.md`

## Global Constraints

- Owner rule overrides TDD: **do not write or run tests.** Verification is `npm run lint`, `node --check`, booting the process, and the explicit on-Mac checks in Task 10.
- ES modules everywhere (`"type": "module"`), Node ≥ 22, no TypeScript.
- Semantic commit messages (`feat:`, `fix:`, `chore:`, `docs:`); commit at the end of every task.
- Config only via env vars (`node --env-file`), documented in each package's `.env.example`. `DATABASE_URL` is the Postgres connection.
- Worker never holds Bunny credentials; all storage I/O goes through the server.
- Customer code never runs outside Chrome's sandbox; never pass `--no-sandbox` / `disableWebSecurity`.
- Internet from renders: allowlist only — default `fonts.googleapis.com, fonts.gstatic.com, cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com` (`EGRESS_ALLOWLIST`). Allowed hosts still must resolve to public IPs.
- Defaults (all config): bundle ≤ 500 MB compressed, ≤ 2 GB / 20 000 files uncompressed; video ≤ 10 min, ≤ 3840×2160; lease 60 s; claim long-poll 25 s; max 3 attempts; output retention 7 days; render wall-time cap 60 min; 60 req/min per API key; ≤ 5 active (queued+rendering) jobs per account; Remotion ≥ 4.0.0.
- Worker memory: idle < 100 MB RSS; claim only if free memory ≥ `MIN_FREE_GB` (default 8); tabs = clamp(floor(freeGB / 2), 1, `MAX_TABS` default 8); abort + requeue (no attempt counted) on critical memory pressure.

## Review Focus

1. **Upload dies or exceeds the cap mid-stream** → 413/400, spool file deleted, nothing in Bunny, no job row. (Task 3)
2. **Hostile archive** (symlink, hard link, `../`, absolute path, zip bomb, 100k tiny files) → `bundle_invalid` before anything is written outside the job dir. (Task 2 server-side listing, Task 7 worker-side extraction — both enforce)
3. **Worker killed / Mac sleeps mid-render** → lease expires, job back to `queued`, attempts+1, third loss → `failed: worker_lost`; temp dir removed on next worker start. (Tasks 5, 6)
4. **Cancel while rendering** → the whole child process group (Chrome included) is killed within one heartbeat, temp dir removed, job `canceled`, bundle deleted. (Tasks 4, 6)
5. **Network blip during output upload or `complete`** → worker retries with backoff; `complete` is idempotent (same job + same worker → 200 again); a lease that expired meanwhile makes the server reject with 409 and the worker discards. (Tasks 4, 6)

---

## File Structure

```
package.json                 workspaces: server, worker, cli; scripts lint
eslint.config.js
.gitignore
server/
  package.json  .env.example  Dockerfile
  migrations/001_init.sql
  src/index.js               app boot, sweeper start
  src/config.js              env parsing + defaults
  src/db.js                  pg Pool, tx(fn)
  src/migrate.js             applies migrations/*.sql, tracks schema_migrations
  src/admin.js               CLI: account/key/worker management
  src/auth.js                apiKeyAuth, workerAuth middleware, hashToken
  src/bunny.js               Bunny Storage client
  src/bundle-inspect.js      safe tar.gz listing + version detection
  src/url-guard.js           SSRF validator (public-only URL + resolved IPs)
  src/jobs/repo.js           all SQL for jobs + job_events
  src/routes/public.js       /v1
  src/routes/worker.js       /worker
  src/sweeper.js             leases, deletions, expiry, webhooks
  src/webhooks.js            signing + delivery
worker/
  package.json  .env.example
  src/index.js               poll loop (never imports Remotion)
  src/config.js
  src/api.js                 server client (fetch, retries)
  src/memory.js              vm_stat + pressure level
  src/pause.js               pause file + schedule
  src/extract.js             safe tar.gz extraction
  src/renderers.js           per-version @remotion/renderer cache
  src/run-job.js             spawns child, heartbeats, cancel, cleanup
  src/child/render.js        child entry: browser, selectComposition, renderMedia
  src/child/egress.js        policy: isAllowed(host|ip, port)
  src/child/proxy.js         HTTP/CONNECT filtering proxy
  src/child/node-guard.js    --import preload; guards Node sockets
  src/child/chrome-wrapper.js writes per-job wrapper script
  bin/render-worker.js       CLI: start | pause [--now] | resume | status
  macos/com.renderservice.worker.plist
  macos/setup.sh
cli/
  package.json
  bin/render.js              submit | status | cancel
```

---

### Task 1: Repo scaffold, server config, database, admin CLI

**Files:** Create root `package.json`, `eslint.config.js`, `.gitignore`, `server/package.json`, `server/.env.example`, `server/migrations/001_init.sql`, `server/src/{config,db,migrate,admin,auth}.js`.

**Interfaces — Produces:**
- `config` (default export): `{ port, databaseUrl, publicBaseUrl, bunny: {storageZone, accessKey, region, cdnBase}, limits: {...Global defaults}, egressAllowlist: string[] }`
- `pool`, `tx(async (client) => T): Promise<T>` from `db.js`
- `hashToken(token: string): string` (sha256 hex), `newToken(prefix: 'rk_live_'|'rw_'): string` (prefix + 32 random bytes base64url)
- `apiKeyAuth` → sets `req.account = {id, limits}`; `workerAuth` → sets `req.worker = {id, name}`; both update `last_used_at`/`last_seen_at` at most once a minute.

- [ ] **Step 1:** Root workspaces + ESLint 9 flat config (recommended rules, node globals); `npm run lint` at root.
- [ ] **Step 2:** `001_init.sql` — tables per spec "Data model": `accounts` (+ `webhook_secret text not null`, `limits jsonb not null default '{}'`), `api_keys` (unique `hash`), `workers` (unique `token_hash`), `jobs`, `job_events (id bigserial, job_id, at, type, data jsonb)`, `webhook_deliveries (job_id pk, attempts, next_at, delivered_at, last_error)`. `jobs.status` is a `text` with CHECK in `('uploading','queued','rendering','uploading_output','done','failed','canceled','expired')`. Index `jobs(status, created_at)` and `jobs(account_id, created_at desc)`. `jobs.error` is `jsonb {code, message}`; `jobs.cancel_requested boolean not null default false`.
- [ ] **Step 3:** `migrate.js` runs on server boot and via `npm run migrate`.
- [ ] **Step 4:** `admin.js` commands: `account:create <name>` (prints id + webhook secret), `key:create <accountId> [label]` (prints key once), `key:revoke <keyId>`, `worker:create <name>` (prints token once), `account:limits <id> <json>`.
- [ ] **Step 5:** Verify: `npm run lint` clean; `node --check` on each file.
- [ ] **Step 6:** Commit `feat(server): scaffold, schema, admin CLI and auth`.

### Task 2: Bunny client, bundle inspection, URL guard

**Files:** Create `server/src/bunny.js`, `server/src/bundle-inspect.js`, `server/src/url-guard.js`.

**Interfaces — Produces:**
- `bunny.putFile(path: string, localFile: string): Promise<void>` (PUT with Content-Length, `AccessKey` header, `https://{region}.storage.bunnycdn.com/{zone}/{path}`), `bunny.getStream(path): Promise<ReadableStream>`, `bunny.delete(path): Promise<void>` (404 counts as success), `bunny.cdnUrl(path): string`.
- `inspectBundle(file: string, limits): Promise<{ remotionVersion: string, totalBytes: number, fileCount: number }>` — streams through gunzip + `tar-stream` without writing; throws `BundleError(code, message)` with code `bundle_invalid` | `bundle_too_large` | `version_unsupported`.
- `assertPublicUrl(url: string): Promise<void>` — https only (http allowed only if `ALLOW_HTTP_WEBHOOKS`), resolves all A/AAAA, rejects any non-`unicast` range per `ipaddr.js` `range()`.
- `isPublicIp(ip: string): boolean` (exported for reuse in the worker by copy — the worker package has its own copy in `egress.js`; keep the two range lists identical).

- [ ] **Step 1:** `inspectBundle` rules: reject entry types other than `file`/`directory`; reject names that are absolute, contain `..` segments, or contain `\0`; enforce byte/file caps as entries stream; require root `index.html` (accept a single top-level directory prefix and strip it); read `index.html` and extract `/remotion_version\s*=\s*'([0-9.]+)'/`; missing → `bundle_invalid`; below `4.0.0` → `version_unsupported`.
- [ ] **Step 2:** Implement `bunny.js` and `url-guard.js`.
- [ ] **Step 3:** Verify: lint clean; run `node -e` once against `~/code/55gms-ad/out/button/bundle` tarred (`tar czf`) and confirm it returns version `4.0.542`.
- [ ] **Step 4:** Commit `feat(server): bunny storage client, bundle inspection, SSRF guard`.

### Task 3: Public API `/v1`

**Files:** Create `server/src/jobs/repo.js`, `server/src/routes/public.js`, `server/src/index.js`.

**Interfaces:**
- Consumes: Task 1 auth/db, Task 2 `inspectBundle`, `bunny.putFile`, `assertPublicUrl`.
- Produces (`repo.js`): `createJob(client, fields) → job`, `getJob(id, accountId?)`, `listJobs(accountId, {limit, before})`, `setStatus(client, id, from: string[], to, patch) → job|null` (conditional update; returns null if current status not in `from`), `addEvent(client, jobId, type, data)`, `claimNext(client, workerId, leaseSec) → job|null`, `extendLease(id, workerId, leaseSec) → {canceled: boolean}|null`.
- Job JSON returned to agents: `{ id, status, progress, composition, error, outputUrl, video: {width,height,fps,frames}, createdAt, startedAt, finishedAt, expiresAt }`.

- [ ] **Step 1:** `POST /v1/jobs`: Busboy with `limits.fileSize = bundleMaxBytes + 1`, single file part `bundle`, field `job` (JSON). Spool to `os.tmpdir()/render-uploads/<uuid>.tar.gz`. If `file.truncated` → 413 `bundle_too_large`. Validate `job`: `composition` (string, 1–200 chars), `inputProps` (object, serialized ≤ 1 MB), optional `remotionVersion` (must equal detected, else 400 `bundle_invalid`), `frameRange` (`[a,b]` ints), `scale` (0.25–4), `codec` (`h264` only for now), `crf` (0–51), `webhookUrl` (passes `assertPublicUrl`). Enforce active-job cap → 429 `too_many_active_jobs`. Insert job as `uploading`, `putFile` to `bundles/<account>/<job>.tar.gz`, set `queued`. **Always** unlink the spool file in `finally`; on Bunny failure mark job `failed: storage_error`. Respond 202 with job JSON.
- [ ] **Step 2:** `GET /v1/jobs/:id` (404 for other accounts' jobs), `GET /v1/jobs?limit=&before=` (cursor = createdAt of last row), `DELETE /v1/jobs/:id` → from `queued|uploading` straight to `canceled`; from `rendering|uploading_output` set `cancel_requested = true` and let the worker stop.
- [ ] **Step 3:** `index.js`: helmet, `express-rate-limit` keyed by API key hash (fallback IP), JSON 404/error handler returning `{error:{code,message}}`, `GET /healthz`, runs migrate on boot.
- [ ] **Step 4:** Verify: lint; boot locally against a Postgres (`docker run postgres`) and confirm `/healthz` returns 200.
- [ ] **Step 5:** Commit `feat(server): public jobs API with streaming bundle upload`.

### Task 4: Worker API `/worker`

**Files:** Create `server/src/routes/worker.js`; modify `server/src/index.js` to mount it.

**Interfaces — Produces (HTTP, worker-token auth):**
- `POST /worker/claim` body `{ freeMemoryGb }` → long-poll up to 25 s (re-check every 1 s; release the pg client between checks) → 200 `{ job: {id, composition, inputProps, renderOptions, remotionVersion, limits}, leaseSec }` or 204.
- `GET /worker/jobs/:id/bundle` → streams `bunny.getStream` (only for the job's current worker).
- `POST /worker/jobs/:id/progress` `{ progress: 0..1, stage }` → extends lease → `{ cancel: boolean }`; 409 if this worker no longer holds the job.
- `POST /worker/jobs/:id/video-meta` `{ width, height, fps, frames }` → stored; server re-checks limits and answers `{ ok:false, error }` if exceeded.
- `PUT /worker/jobs/:id/output` (raw body mp4, Content-Length required, ≤ 4 GB) → spools to disk then `bunny.putFile('outputs/<account>/<job>.mp4')`; status `uploading_output`.
- `POST /worker/jobs/:id/complete` `{ renderSeconds }` → `done`, `outputUrl`, `expiresAt = now + retention`, `video_seconds = frames/fps`. Idempotent for the same worker.
- `POST /worker/jobs/:id/fail` `{ code, message, retryable: boolean }` → retryable and attempts < 3 → `queued`; else `failed`.
- `POST /worker/jobs/:id/requeue` `{ reason }` → `queued` without incrementing attempts (memory pressure / pause --now).

- [ ] **Step 1:** `claimNext` SQL: `UPDATE jobs SET status='rendering', worker_id=$1, lease_expires_at=now()+$2*interval '1 second', started_at=coalesce(started_at, now()), attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. Every transition writes a `job_events` row.
- [ ] **Step 2:** Implement the routes above; every route checks `job.worker_id = req.worker.id` and an allowed current status, else 409.
- [ ] **Step 3:** Verify: lint; boot; `curl` a claim with a worker token created via `admin.js` returns 204 after ~25 s.
- [ ] **Step 4:** Commit `feat(server): worker claim/lease/progress/output API`.

### Task 5: Sweeper and webhooks; server deploy

**Files:** Create `server/src/sweeper.js`, `server/src/webhooks.js`, `server/Dockerfile`; modify `server/src/index.js`.

**Interfaces — Produces:** `startSweeper(): () => void` (stop fn), runs every 15 s, each pass guarded by `pg_try_advisory_lock(4242)` so multiple server instances don't double-run.

- [ ] **Step 1:** Sweep steps: (a) `rendering|uploading_output` with `lease_expires_at < now()` → `queued` if attempts < 3 else `failed: worker_lost`; (b) terminal jobs with a bundle path → `bunny.delete`, null the path; (c) `done` with `expires_at < now()` → delete output, status `expired`; (d) enqueue a `webhook_deliveries` row when a job with `webhook_url` becomes terminal; deliver due rows.
- [ ] **Step 2:** `webhooks.js`: body = job JSON + `event: 'job.done'|'job.failed'|'job.canceled'`; header `Render-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>`; re-run `assertPublicUrl` before each send; 10 s timeout; no redirects followed; retries at 1, 5, 30, 120 min then give up.
- [ ] **Step 3:** Dockerfile (node:22-slim, `npm ci --omit=dev -w server`, `CMD node src/index.js`), `.env.example` complete.
- [ ] **Step 4:** Verify: lint; `docker build` succeeds.
- [ ] **Step 5:** Commit `feat(server): sweeper, signed webhooks, Dockerfile`.
- [ ] **Step 6:** Deploy on Coolify (app from repo, `server/Dockerfile`, Postgres resource, env vars, domain). Ask the owner for the domain and Bunny storage zone/keys before this step. Verify `https://<domain>/healthz` → 200. Create an account + key + worker token with `admin.js` in the container.

### Task 6: Worker process (poller, memory, pause, job runner)

**Files:** Create `worker/package.json`, `worker/.env.example`, `worker/src/{index,config,api,memory,pause,run-job}.js`, `worker/bin/render-worker.js`.

**Interfaces:**
- Consumes: Task 4 HTTP API.
- Produces:
  - `memory.freeGb(): Promise<number>` — parse `vm_stat`: (free + inactive + purgeable + speculative pages) × page size.
  - `memory.pressureLevel(): Promise<'normal'|'warn'|'critical'>` — `sysctl -n kern.memorystatus_vm_pressure_level` (1/2/4).
  - `pause.state(): {paused: boolean, now: boolean, reason}` — reads `~/Library/Application Support/render-worker/pause.json` and `PAUSE_SCHEDULE` (e.g. `09:00-18:00` local, comma-separated ranges).
  - `runJob(job, {tabs}): Promise<void>` — full lifecycle, below.
  - Child IPC messages: child→parent `{type:'progress', progress, stage}`, `{type:'meta', width,height,fps,frames}`, `{type:'done', file}`, `{type:'error', code, message, retryable}`; parent→child `{type:'meta-ok'}` | `{type:'meta-reject', error}`.

- [ ] **Step 1:** `index.js` loop: on start, delete everything under `WORK_DIR` (leftover job dirs). Loop: if paused → sleep 30 s; if `freeGb() < MIN_FREE_GB` or pressure ≠ normal → sleep 30 s; else `claim`. Must not import anything from `child/` or Remotion (keeps idle RSS low).
- [ ] **Step 2:** `run-job.js`: mkdir `WORK_DIR/<jobId>`; download bundle; `extract` (Task 7); `ensureRenderer(version)` (Task 7); spawn `node --import <node-guard.js> child/render.js` with `detached: true`, `serialization: 'advanced'`, env carrying job JSON path, renderer dir, tabs. Every 2 s: send progress (cancel → kill), check `pressureLevel()` (critical → kill, `requeue`), check pause `now` (→ kill, `requeue`), check 60-min cap (→ kill, `fail timeout` non-retryable). Kill = `process.kill(-child.pid, 'SIGKILL')`. On `done`: `PUT output` with retries (3, backoff 2/10/30 s), then `complete`. On 409 from any call: kill and discard. `finally`: `rm -rf` the job dir.
- [ ] **Step 3:** `api.js`: fetch with `Authorization: Bearer <WORKER_TOKEN>`, retries with backoff on network errors/5xx for idempotent calls (claim, progress, complete, fail, requeue).
- [ ] **Step 4:** `bin/render-worker.js`: `start` (runs index), `pause [--now] [--reason]`, `resume`, `status` (prints pause state, free memory, pressure, current job from a `status.json` the loop writes).
- [ ] **Step 5:** Verify: lint; on this VM, `node --check` all files.
- [ ] **Step 6:** Commit `feat(worker): poll loop, memory gate, pause control, job runner`.

### Task 7: Safe extraction and per-version renderer cache

**Files:** Create `worker/src/extract.js`, `worker/src/renderers.js`.

**Interfaces — Produces:**
- `extract(archive: string, destDir: string, limits): Promise<string>` → returns bundle root dir (the dir containing `index.html`). Same rules as server `inspectBundle` (types, `..`, absolute, caps), plus: resolve each target with `path.resolve(destDir, name)` and require it to stay inside `destDir`; create files with mode `0o644`, dirs `0o755`, ignore archive modes/owners.
- `ensureRenderer(version: string): Promise<string>` → dir containing `node_modules/@remotion/renderer`. Cache at `RENDERER_CACHE` (default `~/Library/Application Support/render-worker/remotion/<version>`); install with `npm install --no-save --ignore-scripts --no-audit --no-fund @remotion/renderer@<version> remotion@<version>` into a temp dir then rename (atomic); a per-version lock file prevents two concurrent installs. Version must match `/^\d+\.\d+\.\d+$/` before it touches a command line.

- [ ] **Step 1:** Implement both.
- [ ] **Step 2:** Verify: lint; on this VM extract the 55gms-ad button bundle tarball and confirm root contains `index.html`; craft a tar with a `../x` entry and a symlink and confirm both throw `bundle_invalid`.
- [ ] **Step 3:** Commit `feat(worker): safe bundle extraction and renderer cache`.

### Task 8: Render child with network isolation

**Files:** Create `worker/src/child/{render,egress,proxy,node-guard,chrome-wrapper}.js`.

**Interfaces:**
- `egress.isAllowed({host, ip, port}): boolean` — loopback allowed only for ports in `ALLOWED_LOOPBACK_PORTS` (env set by `render.js`: serve port, devtools port, proxy port); otherwise host must be in `EGRESS_ALLOWLIST` (exact or subdomain) **and** `ip` public. IP literals that aren't loopback are always denied.
- `startProxy({ allow: isAllowed }): Promise<{port, close, blocked: string[]}>` — HTTP proxy + CONNECT; resolve hostname itself, check, connect to the **resolved IP**; denied → 403 and record host in `blocked`.
- `node-guard.js` (preload): wraps `net.Socket.prototype.connect` — for host options, perform lookup, check every candidate with `isAllowed`, connect to the checked IP; for IP options, check directly; denied → emit `ECONNREFUSED`-style error and record host (sent to parent as part of the error).
- `writeChromeWrapper({ realChrome, proxyPort, debugPort, dir }): string` → path to an executable `sh` script that drops incoming args matching `--no-proxy-server`, `--proxy-server=*`, `--proxy-bypass-list=*`, `--remote-debugging-port=*`, then `exec "$realChrome" "$@" --proxy-server=http://127.0.0.1:<proxyPort> --proxy-bypass-list='<-loopback>' --remote-debugging-port=<debugPort> --force-webrtc-ip-handling-policy=disable_non_proxied_udp --webrtc-ip-handling-policy=disable_non_proxied_udp`.

- [ ] **Step 1:** `render.js` flow: import `@remotion/renderer` from the renderer dir via `createRequire`; pick free ports (serve, debug); start proxy; `ensureBrowser()` and locate the real headless-shell path (from its return value or the renderer's download dir — builder resolves; fail hard if not found); write wrapper; `openBrowser('chrome', { browserExecutable: wrapper, chromiumOptions: { gl: 'angle' } })`; `selectComposition({ serveUrl: bundleRoot, id, inputProps, puppeteerInstance, port: servePort })`; send `meta`, wait for `meta-ok`; `renderMedia({ ..., puppeteerInstance, port: servePort, concurrency: tabs, codec, crf, scale, frameRange, outputLocation: <jobDir>/out.mp4, onProgress })` throttled to 1 msg/s; send `done`; exit 0.
- [ ] **Step 2:** Error mapping: composition id missing → `composition_not_found` (non-retryable); any blocked host recorded → `network_blocked` with message naming the first host and the rule "bundle assets with staticFile(); only <allowlist> may be fetched" (non-retryable); browser crash / target closed → `render_error` retryable; other JS errors from the composition → `render_error` non-retryable.
- [ ] **Step 3:** Verify: lint; `node --check`.
- [ ] **Step 4:** Commit `feat(worker): isolated render child with egress proxy and node guard`.

### Task 9: macOS install, launchd, CLI client

**Files:** Create `worker/macos/com.renderservice.worker.plist`, `worker/macos/setup.sh`, `cli/package.json`, `cli/bin/render.js`, root `README.md`.

**Interfaces — Produces:** `render submit <bundleDir> --composition <id> [--props file.json] [--out video.mp4] [--scale n] [--frames a-b]` (tars the dir to a temp file, POSTs, polls every 3 s printing progress, downloads to `--out`); `render status <id>`; `render cancel <id>`. Env: `RENDER_API_URL`, `RENDER_API_KEY`.

- [ ] **Step 1:** plist: user LaunchAgent (`~/Library/LaunchAgents`), `RunAtLoad`, `KeepAlive`, `ProcessType` = `Background` is **not** used (it may deprioritize GPU) — use `Standard`; stdout/stderr to `~/Library/Logs/render-worker/worker.log`; worker rotates the log itself at 20 MB keeping 3 files.
- [ ] **Step 2:** `setup.sh`: checks Node ≥ 22, `npm ci -w worker`, copies `.env` template if missing, installs/reloads plist with `launchctl bootout/bootstrap gui/$UID`, runs `sudo pmset -c sleep 0 disksleep 0` (display sleep untouched), prints `render-worker status`.
- [ ] **Step 3:** README: architecture, env vars for both packages, API reference (request/response/error codes, webhook signature verification snippet, the allowlist rule), admin commands, Mac setup.
- [ ] **Step 4:** Verify: lint; `plutil -lint` on the Mac (Task 10).
- [ ] **Step 5:** Commit `feat: macOS launchd setup, CLI client, README`.

### Task 10: On-Mac bring-up and isolation check (needs the owner's Mac)

Not automated tests — one-time manual checks the spec requires. Needs either SSH access to the Mac or the owner running the commands.

- [ ] **Step 1: GPU check.** On the Mac, render 150 frames of the 55gms-ad `ButtonAd` bundle through the worker as launched by `launchd`; record seconds/frame. Pass: clearly faster than the VM's ~7 s/frame and `chrome://gpu`-equivalent log shows ANGLE Metal, not SwiftShader. If GPU isn't used under launchd, stop and report to the owner.
- [ ] **Step 2: Hostile bundle.** Build a small Remotion bundle whose composition, via `fetch`, `<Img>`, `<OffthreadVideo>`, WebSocket and WebRTC, tries: `http://192.168.1.1`, `http://10.0.0.1`, `http://127.0.0.1:11434` (Ollama), `http://localhost:<servePort+1>`, `http://169.254.169.254`, a public non-allowlisted host, and a DNS name resolving to a private IP. Pass: the job fails `network_blocked` and the proxy/guard logs show every attempt denied; a control bundle loading Google Fonts renders fine.
- [ ] **Step 3: Memory check.** `ps -o rss` of the idle worker < 100 MB; during a render the child is the only large process; after it finishes, RSS returns to idle and no Chrome processes remain. With `MIN_FREE_GB` set above current free memory, the worker does not claim.
- [ ] **Step 4: Recovery check.** `kill -9` the worker mid-render → job returns to `queued` after the lease, re-renders on restart; leftover job dir is removed at startup.
- [ ] **Step 5: End to end.** From this VM: `render submit ~/code/55gms-ad/out/button/bundle --composition ButtonAd --out out.mp4` → mp4 downloads; audio is muxed by us afterwards as today.
- [ ] **Step 6:** Commit any fixes as `fix(worker): …`; note measured timings in README.
