# Darkroom Paid Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner chose native
> execution: build inline, one fresh reviewer for the whole branch at the end). Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Turn the Darkroom job system into a paid service: Clerk accounts behind a waitlist,
prepaid Stripe credits with exact per-job holds and charges, upload links, a stateless MCP server,
worker status, and a React dashboard with an admin page, all served by the one `darkroom-server`.

**Architecture:**
- New server modules sit beside the existing ones:
  - `billing/` (pricing, ledger, Stripe)
  - `jobs/service.js` (submit, cancel, uploads, shared by REST, MCP and dashboard)
  - `status.js`
  - `mcp.js`
  - `routes/dashboard.js`
  - `routes/inbound-webhooks.js`
- A new `web/` workspace (Vite SPA) is built in the Dockerfile and served by Express.
- Money lives in an append-only ledger plus a cached `accounts.balance_micro`. Holds live on
  `jobs.hold_micro` and count only while the job is active.

**Tech Stack:**
- Server: Node 22 ESM, Express 4, pg, `@clerk/express`, `stripe`, `@modelcontextprotocol/sdk` +
  `zod`.
- Web: React 19, React Router 7, Vite 7, Tailwind 4, lucide-react, Axios, `@clerk/react`.

**Spec:** `docs/superpowers/specs/2026-11-19-paid-service-design.md`. Read it first; this plan
argues from it.

## Global Constraints

- **No tests.** Don't write or run unit, integration or browser tests (owner rule). Every
  "verify" step is lint + boot + real requests.
- **ES modules only.** Express 4. `pg` with plain SQL migrations in `server/migrations/` (next is
  `003_paid_service.sql`).
- **Money is integer micro-USD** (`bigint`, $1 = 1,000,000). pg returns bigint as a string;
  convert with `Number()` (safe below 2^53).
- **Prices, from config:**
  - `PRICE_MICROUSD_PER_SECOND` = 2500
  - `PRICE_MIN_SECONDS` = 15
  - tiers by output pixels:
    - ≤ 2,073,600 → 1×
    - ≤ 3,686,400 → 2×
    - above → 4×
  - trial = 1,500,000 µ$ (`TRIAL_MICROUSD`)
  - packs: $10, $25, $100
- **Job cost** = `max(minSeconds, ceil(frames / fps)) × multiplier × microPerSecond`.
  - `frames` = frames actually rendered.
  - Size is after `scale`, which is the existing `video` jsonb computed in `video-meta`.
- **Plans:** `waitlist`, `trial`, `paid`, `internal`. Existing accounts become `internal`.
- **Domains:** main `https://darkroom.jiayangchen.com`, alias `darkroom.lsjc.dev`. DNS-only. No
  ch3n.cc.
- **Security model untouched.** No changes to the worker's render child, proxy, node guard,
  sandbox or Chrome selection. The only worker change is the pause status report (Task 4).
- **Secrets:** never committed, never pasted into chat. New env vars go in `server/.env.example`
  with empty values.
- **Commits:** semantic (`feat:`, `fix:`, `chore:`, `docs:`), one or more per task, as progress is
  made.
- **Outward actions:** ask the owner before each one (DNS, Clerk/Stripe dashboards, Coolify env,
  deploys, rsync to the Mac). Deploys of Darkroom to Coolify were approved in project 1, but the
  domain, env and auth changes here are new, so confirm them.
- **Error shape** stays `{ error: { code, message } }`. New codes:
  - `insufficient_credits` (402)
  - `not_approved` (403)
  - `upload_invalid` (400)
  - `forbidden` (403)

## Local verification setup (used by every task)

```bash
docker run -d --name darkroom-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=darkroom -p 5433:5432 postgres:17
cd ~/code/darkroom
DATABASE_URL=postgres://postgres:dev@localhost:5433/darkroom npm run dev -w server   # migrations run on boot
npm run lint
```

`server/.env` already holds the Bunny settings; the env var above overrides only the database.

**Rendering end to end locally** (as in project 1):
1. Register a local worker by hash with `worker:register`.
2. On the Mac: `node worker/bin/darkroom-worker.js pause --now` for the LaunchAgent worker.
3. Open `ssh -R 3900:localhost:3000 mac-studio`.
4. Run the worker by hand on the Mac with `SERVER_URL=http://127.0.0.1:3900` and the local token.
5. `resume` afterwards.

Clerk dev keys and Stripe test keys come from the owner (Tasks 6–7). Ask when you reach them.

## Review Focus

1. **Concurrent submits.** Two jobs submitted at once from an account with money for only one
   must not both reach `rendering`. The account-row lock in `reserveJob` and `placeHold` decides
   this. Verify with two parallel curl submits on a $0.04 balance: expect one 402.
2. **Requeued jobs** (memory pressure, worker lost) call `video-meta` again. The hold must be
   overwritten, never doubled, and the account charged exactly once at `done`. Verify by
   requeueing a job with `requeue` and checking the ledger.
3. **Stripe retries.** A duplicate `checkout.session.completed` must not credit twice; this is
   the unique `stripe_session_id`. Credit the pack amount, not `amount_total`, which includes
   tax. Verify by replaying the event with `stripe events resend`, or by POSTing the same signed
   payload twice.
4. **Vertical video.** 1080×1920 must be tier 1× and allowed on trial. That needs the
   orientation-agnostic size check in Task 1. Verify with the ButtonAd bundle on a trial account.
5. **Upload link races.**
   - Two simultaneous PUTs to one token: one must get 409.
   - A PUT after expiry, or after `used`: 404.
   - A failed PUT must leave the token usable again before expiry.

---

### Task 1: Schema, config, pricing, plan limits

**Files:**
- Create: `server/migrations/003_paid_service.sql`, `server/src/billing/pricing.js`
- Modify:
  - `server/src/config.js`
  - `server/src/auth.js` (`apiKeyAuth` query)
  - `server/src/routes/worker.js` (`claimPayload`, `video-meta` checks, progress UUID check)
  - `server/src/admin.js` (`account:create` sets plan `internal`; new `account:plan <id> <plan>`)
  - `server/.env.example`

**Interfaces:**
- Produces:
  - `config.pricing = { microPerSecond, minSeconds, tiers: [{ maxPixels, multiplier }] }`
  - `config.packs = [10, 25, 100]`
  - `config.trialMicro`
  - `config.signupMode` (`'waitlist'|'open'`)
  - `config.adminClerkUserIds: string[]`. Parse it case-preserving; don't use `list()`, which
    lowercases.
  - `config.clerk = { publishableKey, secretKey, webhookSecret }`
  - `config.stripe = { secretKey, webhookSecret }`
  - `config.webDist` (default `path.join(serverDir, '../web/dist')`)
  - `config.planLimits`
  - `config.limits.maxFps` (60), `config.limits.maxPixels` (3840×2160)
- Produces: `accountLimits(account: { plan, limits }) → limits`, merged as config defaults ←
  `planLimits[plan]` ← `account.limits`.
- Produces from `billing/pricing.js`:
  - `tierMultiplier(pixels: number) → 1|2|4`
  - `jobCostMicro(video: { width, height, fps, frames }) → number`
  - `minCostMicro() → number` (min seconds at 1×)
  - `usd(micro: number|string|null) → string|null` (`(n / 1e6).toFixed(4)`)
- Produces: `req.account` from `apiKeyAuth` is `{ id, plan, limits, keyId, disabled }`. Disabled
  accounts (`disabled_at` not null) get 401.

**Migration 003:**
- `accounts` add:
  - `plan text NOT NULL DEFAULT 'waitlist' CHECK (plan IN ('waitlist','trial','paid','internal'))`
  - `clerk_user_id text UNIQUE`
  - `email text`
  - `stripe_customer_id text`
  - `approved_at timestamptz`
  - `disabled_at timestamptz`
  - `balance_micro bigint NOT NULL DEFAULT 0`
  - Then `UPDATE accounts SET plan = 'internal'`. Every pre-existing account is admin-made.
- `jobs` add: `hold_micro bigint`, `cost_micro bigint`, `upload_id uuid`.
- `credit_ledger`:
  - columns: `id bigserial PK`, `account_id uuid NOT NULL REFERENCES accounts`,
    `at timestamptz NOT NULL DEFAULT now()`,
    `kind text NOT NULL CHECK (kind IN ('purchase','trial','grant','charge','refund'))`,
    `amount_micro bigint NOT NULL`, `job_id uuid`, `stripe_session_id text`, `note text`,
    `created_by text`
  - unique partial indexes:
    - `(stripe_session_id) WHERE stripe_session_id IS NOT NULL`
    - `(job_id) WHERE kind = 'charge'`
    - `(account_id) WHERE kind = 'trial'`
  - index `(account_id, id DESC)`
- `invite_codes`:
  - columns: `code text PK`, `note text`, `max_uses int NOT NULL DEFAULT 1`,
    `uses int NOT NULL DEFAULT 0`, `expires_at timestamptz`,
    `created_at timestamptz NOT NULL DEFAULT now()`, `disabled_at timestamptz`
- `uploads`:
  - columns: `id uuid PK`, `account_id uuid NOT NULL REFERENCES accounts`,
    `token_hash text NOT NULL UNIQUE`,
    `status text NOT NULL CHECK (status IN ('pending','receiving','received','used','expired'))`,
    `bundle_path text`, `bytes bigint`, `remotion_version text`,
    `created_at timestamptz NOT NULL DEFAULT now()`, `expires_at timestamptz NOT NULL`
  - index `(status, created_at)`
- `workers` add: `state text`, `state_until timestamptz`, `state_at timestamptz`.

**Plan limits:**
- `waitlist`: `{ maxActiveJobs: 0 }`
- `trial`: `{ maxActiveJobs: 1, maxPixels: 2_073_600, maxDurationSec: 120, requestsPerMinute: 30 }`
- `paid`: `{}`
- `internal`: `{}`

- [ ] **Step 1:** Write migration 003 as specified above.
- [ ] **Step 2:** Update `config.js` and `.env.example` with the new keys:
  - `PRICE_MICROUSD_PER_SECOND`, `PRICE_MIN_SECONDS`, `TRIAL_MICROUSD`
  - `SIGNUP_MODE`, `ADMIN_CLERK_USER_IDS`
  - `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - `LIMIT_MAX_FPS`, `LIMIT_MAX_PIXELS`, `WEB_DIST`
- [ ] **Step 3:** Write `billing/pricing.js`.
- [ ] **Step 4:** Update `apiKeyAuth`. Select `a.plan, a.disabled_at`, and reject disabled
  accounts.
- [ ] **Step 5:** Update `worker.js`:
  - `claimPayload` selects `plan, limits` and passes both to `accountLimits`.
  - Add `maxFps` and `maxPixels` to the worker `limits` payload.
  - In `video-meta`, replace the width/height check with an orientation-agnostic one:
    - `max(w,h) ≤ max(maxWidth,maxHeight)`
    - `min(w,h) ≤ min(maxWidth,maxHeight)`
    - `w×h ≤ maxPixels`
  - Add `fps > maxFps` → `limits_exceeded` with the message
    `Frame rate ${fps} exceeds ${maxFps} fps`.
  - Add the `UUID_RE` check to `POST /jobs/:id/progress` (deferred issue #7).
- [ ] **Step 6:** Update `admin.js`: `account:create` inserts `plan='internal'`; add
  `account:plan`.
- [ ] **Step 7: Verify.** `npm run lint` is clean. Boot against the local Postgres; the log shows
  `[migrate] applied 003_paid_service.sql`. In `psql`, `\d accounts` shows the new columns. Then:
  ```bash
  node -e "import('./server/src/billing/pricing.js').then(p=>console.log(p.jobCostMicro({width:1080,height:1920,fps:30,frames:2010}), p.jobCostMicro({width:3840,height:2160,fps:30,frames:30})))"
  ```
  Expected: `167500 150000`. That's 67 s × 1 × 2500, and 15 s min × 4 × 2500.
- [ ] **Step 8: Commit** `feat(server): paid-service schema, plan limits, pricing, fps/pixel caps`

### Task 2: Ledger, job service, holds and charges

**Files:**
- Create: `server/src/billing/ledger.js`, `server/src/jobs/service.js`
- Modify:
  - `server/src/jobs/repo.js` (`createJob` accepts `status` and `bundlePath`; add `hold_micro`,
    `cost_micro`, `upload_id` to `COLUMNS`; `toPublic` adds `cost`, `estimatedCost`)
  - `server/src/routes/public.js` (POST and DELETE use the service)
  - `server/src/routes/worker.js` (`video-meta` places the hold; `complete` charges)
  - `server/src/index.js` (`STATUS_BY_CODE.insufficient_credits = 402`)

**Interfaces:**
- Produces from `billing/ledger.js`:
  - `lockAccount(c, accountId) → accountRow` (`SELECT … FOR UPDATE`)
  - `availableMicro(c, accountId, { excludeJobId } = {}) → number`. This is `balance_micro` minus
    `sum(hold_micro)` over the account's jobs with `status = ANY(ACTIVE)`, excluding
    `excludeJobId`. Holds on terminal jobs simply stop counting, so no code path has to clear
    them.
  - `addEntry(c, { accountId, kind, amountMicro, jobId, stripeSessionId, note, createdBy }) → entry|null`.
    Uses `INSERT … ON CONFLICT DO NOTHING`. Only if a row was inserted does it run
    `UPDATE accounts SET balance_micro = balance_micro + amount`. Returns null on conflict.
  - `approveAccount(c, accountId, { by }) → account`. If plan is `waitlist`: set `trial` and
    `approved_at`, then `addEntry(kind 'trial', config.trialMicro)`. Idempotent.
  - `listLedger(accountId, { limit = 100 }) → rows`
- Produces from `jobs/service.js` (all throw `HttpError`):
  - `reserveJob(c, account, fields, { status, bundlePath, bundleBytes, remotionVersion, uploadId }) → jobRow`:
    1. `lockAccount`
    2. `countActive(c)` ≥ `maxActiveJobs` → 429 `too_many_active_jobs`. For `maxActiveJobs` 0,
       use 403 `not_approved` instead.
    3. Unless plan is `internal`, `availableMicro < minCostMicro()` → 402 `insufficient_credits`
       with the message `Balance $X available; a job needs at least $0.0375. Buy credits at <publicBaseUrl>/app/billing`.
    4. `createJob` with `hold_micro = minCostMicro()`. Use null for `internal`.
  - `cancelJob(accountId, jobId) → jobRow`. The existing DELETE logic moves here unchanged.
  - `getJobFor(accountId, jobId)` and `listJobsFor(accountId, opts)`. These are thin wrappers;
    a non-UUID id gives 404.
- Hold, in `video-meta` after the limits pass, in one `tx`:
  1. `lockAccount`.
  2. `cost = jobCostMicro(video)`.
  3. If the plan isn't `internal` and `availableMicro(c, acct, { excludeJobId }) < cost`, fail
     the job `insufficient_credits` with
     `This ${secs} s video costs $${usd(cost)}; available balance is $${usd(avail)}`. Respond
     `{ ok: false, error }`, the same path as `limits_exceeded`.
  4. Else set `hold_micro = cost`. For `internal`, set `hold_micro = null` and
     `cost_micro = cost`.
- Charge, in `complete`: in the same `tx` as `setStatus(... 'done')`:
  - If the account isn't `internal` and `hold_micro` is not null:
    `addEntry({ kind: 'charge', amountMicro: -hold, jobId })` and `cost_micro = hold_micro`.
  - The idempotent "already done" early return stays.

- [ ] **Step 1:** Write `ledger.js`.
- [ ] **Step 2:** Write `service.js`. Move the DELETE logic in. Refactor `parseJob(text)` into
  `parseJobObject(obj)` plus a thin `parseJob(text)` wrapper, and export `parseJobObject` from
  `service.js` (Task 3 needs it).
- [ ] **Step 3:** Rewire multipart `POST /v1/jobs`:
  - Replace `countActive` and `createJob` with `tx(c => reserveJob(c, req.account, fields, { status: 'uploading', bundleBytes, remotionVersion }))`.
  - This fixes deferred issue #4: the count happens under the account lock.
  - The rest (Bunny put, then queued) is unchanged.
- [ ] **Step 4:** Update `video-meta` (hold) and `complete` (charge). Update `toPublic`:
  - `cost: usd(cost_micro)`
  - `estimatedCost: ACTIVE.includes(status) ? usd(hold_micro) : null`
- [ ] **Step 5: Verify.**
  - Lint.
  - With the local admin CLI, create a `trial` account by hand:
    - `account:create`, then `account:plan <id> trial`
    - a `psql` insert of a `grant` ledger row of 40000 plus a matching balance
    - `key:create`
  - Submit a small bundle twice in parallel (`curl … & curl …`). Expect one 202 and one 402
    `insufficient_credits`. With 1 active job max on trial, a 429 is also acceptable; to test
    the money path, set `account:limits <id> '{"maxActiveJobs":5}'` first.
  - With the local worker render (see setup), the ButtonAd bundle (1080×1920, so it's allowed
    on trial at 1×) ends `done`. `credit_ledger` has one `charge` equal to `jobs.cost_micro`
    (167500 for the full 67 s). `GET /v1/jobs/:id` shows `cost`.
  - Requeue check: while a job renders, `pause --now` on the Mac (hands it back), then
    `resume`. After `done` there is still exactly one `charge` row, and `hold_micro` equals the
    cost (not doubled).
- [ ] **Step 6: Commit** `feat(server): credit ledger, holds at video-meta, charge on done`

### Task 3: Upload links

**Files:**
- Create: `server/src/upload-spool.js`
- Modify:
  - `server/src/routes/public.js` (move `receiveUpload` and the in-flight map out; add
    `POST /v1/uploads`; `POST /v1/jobs` accepts JSON)
  - `server/src/jobs/service.js`
  - `server/src/index.js` (mount the token PUT before `/v1`)
  - `server/src/sweeper.js`

**Interfaces:**
- Produces from `upload-spool.js`:
  - `receiveMultipart(req, maxBytes) → { spool, bytes, jobField }`. This is the moved
    `receiveUpload`, unchanged.
  - `receiveRaw(req, maxBytes) → { spool, bytes }`. Same idle and total deadlines, the same
    `darkroomCloseAfterResponse` behavior, a `Content-Length` > maxBytes pre-check, and a
    streamed size cap.
  - `withUploadSlot(accountId, fn)`. Per-account in-flight cap of 2, throwing 429
    `too_many_uploads`.
- Produces from `service.js`:
  - `createUpload(account) → { uploadId, uploadUrl, expiresAt, maxBytes, curl }`:
    - The token is `newToken('dru_')`; store `hashToken(token)`.
    - `expires_at = now() + 15 min`.
    - `uploadUrl = ${config.publicBaseUrl}/v1/uploads/${token}`.
    - `curl = "curl -fsS -T bundle.tar.gz '<uploadUrl>'"`.
    - A `waitlist` account gets 403 `not_approved`.
  - `receiveUploadByToken(req, token) → { uploadId, bytes, remotionVersion }`:
    1. Atomically `UPDATE uploads SET status='receiving' WHERE token_hash=$1 AND status='pending' AND expires_at > now() RETURNING *`.
    2. If no row: look the token up again. `receiving` → 409 `upload_in_progress`; anything else
       → 404 `not_found`.
    3. Load the account and limits, then `withUploadSlot` → `receiveRaw` → `inspectBundle` →
       `bunny.putFile('bundles/<account>/upload-<id>.tar.gz')`.
    4. Set `received`, with `bundle_path`, `bytes` and `remotion_version`.
    5. On any error, set the status back to `pending` (if still `receiving`), unlink the spool,
       and rethrow.
  - `submitFromUpload(account, fields) → jobRow`. `fields.uploadId` is required and must be a
    UUID. In one `tx`:
    1. `SELECT … FOR UPDATE` the upload, by id and account, with status `received`. Otherwise
       400 `upload_invalid` (`Upload not found, not finished, or already used`).
    2. If given, check `remotionVersion` against the upload's version.
    3. `reserveJob(c, account, fields, { status: 'queued', bundlePath, bundleBytes, remotionVersion, uploadId })`.
    4. Set the upload to `used`.
- Routes:
  - `POST /v1/uploads` (API key).
  - `PUT /v1/uploads/:token`, mounted as `app.put('/v1/uploads/:token', ipRateLimit(30/min), handler)`
    **before** `app.use('/v1', publicRoutes)`, so `apiKeyAuth` never runs. The token must match
    `/^dru_[A-Za-z0-9_-]{43}$/`, else 404.
  - `POST /v1/jobs`: if `req.is('application/json')`, parse with `express.json({ limit: '2mb' })`,
    then `parseJobObject` + `submitFromUpload`. Otherwise it's the existing multipart path.
- Sweeper step `expireUploads(c)`: uploads with status `pending`, `receiving` or `received` and
  `created_at < now() - 1 hour`: `bunny.remove(bundle_path)` if set, then status `expired`.

- [ ] **Step 1:** Extract `upload-spool.js`; multipart behavior stays identical.
- [ ] **Step 2:** Add the service functions and routes.
- [ ] **Step 3:** Add the sweeper step.
- [ ] **Step 4: Verify.** Lint, then:
  - `POST /v1/uploads` returns a `curl`.
  - Running it returns `{ uploadId, bytes, remotionVersion }`.
  - `POST /v1/jobs` with JSON `{ uploadId, composition }` returns 202 `queued`.
  - Reusing the same uploadId → 400 `upload_invalid`.
  - Two PUTs at once on a fresh token → one 409.
  - An expired token (set `expires_at` in the past with psql) → 404.
  - The multipart `darkroom submit` CLI still works.
- [ ] **Step 5: Commit** `feat(server): upload links (create, PUT by token, submit by uploadId)`

### Task 4: Worker status and queue position

**Files:**
- Create: `server/src/status.js`
- Modify:
  - `server/src/routes/worker.js` (new `POST /worker/status`; `/claim` records the polling
    state)
  - `server/src/routes/public.js` (`GET /v1/jobs/:id` adds `queuePosition`, `worker`)
  - `worker/src/pause.js`, `worker/src/index.js`, `worker/src/api.js`

**Interfaces:**
- Worker:
  - `pause.js` `state()` also returns `until: string|null`. That's the ISO time the current
    `PAUSE_SCHEDULE` range ends (next occurrence of `r.to`, handling ranges that wrap past
    midnight), or null for a manual pause.
  - `api.reportStatus(body)` is `call('POST', '/worker/status', body, { retries: 0, timeoutMs: 10_000 })`.
  - In the paused branch of `index.js`, report `{ state: 'paused', until, reason }` at most once
    every 60 s. Ignore errors.
- Server:
  - `POST /worker/status` sets `workers.state = 'paused'`, `state_until`, `state_at = now()`.
    Validate `until` as an ISO date or null.
  - `/claim` sets `state = 'polling', state_at = now()` alongside the existing capabilities
    update.
- Produces from `status.js`:
  - `workerStatus() → { state: 'rendering'|'idle'|'paused'|'offline', until: string|null }`:
    1. any job `rendering`/`uploading_output` → `rendering`
    2. else any worker with `state='polling'` and `last_seen_at > now()-90s` → `idle`
    3. else any worker with `state='paused'` and `state_at > now()-120s` → `paused`, with the
       earliest `until`
    4. else `offline`
  - `queuePosition(job) → number|null`. For `queued` jobs:
    `1 + count(queued jobs with queued_at < job.queued_at)`. Otherwise null.

- [ ] **Step 1:** Make the worker changes (three files).
- [ ] **Step 2:** Make the server changes.
- [ ] **Step 3: Verify.** Lint, then:
  - With the local server and the tunnel worker running, `GET /v1/jobs/:id` on a queued job
    shows `queuePosition: 1`, `worker.state: 'idle'`.
  - `pause` on the Mac → within 60 s it shows `paused`. With
    `PAUSE_SCHEDULE` set to a range covering now, `until` is that range's end.
  - Stop the worker → `offline` after 2 min.
- [ ] **Step 4: Commit** `feat: worker pause status and queue position`

The Mac rsync happens in Task 11 (rollout), with the owner's OK.

### Task 5: MCP server

**Files:**
- Create: `server/src/mcp.js`
- Modify: `server/src/index.js` (`app.use('/mcp', mcpRouter)`), `server/package.json`
  (`@modelcontextprotocol/sdk`, `zod`)

**Interfaces:**
- Consumes:
  - `apiKeyAuth`
  - the per-key `rateLimit` config. Export it from `public.js` as `keyRateLimit`, or move it to
    `auth.js`.
  - service functions from Tasks 2–3
  - `workerStatus`, `queuePosition` (Task 4)
  - `listLedger` / `availableMicro` (Task 2)
- Produces: `mcpRouter`.
  - `POST /` builds a new `McpServer({ name: 'darkroom', version }, { instructions })` and a
    `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request.
  - `GET` and `DELETE` → 405 JSON.
  - `express.json({ limit: '2mb' })`.
- Tools (`registerTool`, zod input schemas, results as `structuredContent` plus a JSON text
  block; `HttpError` → `isError: true` with `{ error: { code, message } }`):

| Tool | Input | Output |
|---|---|---|
| `create_upload` | none | `createUpload` result, plus `steps` (below) |
| `submit_render` | `uploadId`, `composition`, optional `inputProps`, `frameRange`, `scale`, `crf`, `webhookUrl` | `toPublic(job)` |
| `get_job` | `jobId` | `toPublic(job)` + `queuePosition` + `worker` |
| `list_jobs` | optional `limit` (≤ 50), `before` | jobs |
| `cancel_job` | `jobId` | `toPublic(job)` |
| `get_balance` | none | `{ plan, balance, available, limits, prices, worker }` |

  - `create_upload` `steps` are:
    ```bash
    npx remotion bundle <entry> --out-dir build
    tar -czf bundle.tar.gz -C build .
    <curl>
    ```
  - `get_balance` limits are `maxDurationSec`, `maxPixels`, `maxFps`, `maxActiveJobs`. Prices
    come from config, formatted in USD.
- `instructions` (exact copy, keep it short):
  > Darkroom renders finished Remotion bundles on a GPU and returns an mp4 URL. Flow:
  > `create_upload` → run its commands (bundle, then curl the .tar.gz to uploadUrl) →
  > `submit_render` with the uploadId → poll `get_job` about every 10 s until status is done,
  > failed or canceled. Renders have no internet except Google Fonts, jsDelivr, unpkg and cdnjs.
  > Put every other asset in the bundle with `staticFile()`. Price: $0.15 per video-minute at
  > ≤1080p (2× at 1440p, 4× at 4K), minimum 15 s per job; failed jobs are free. Errors: see
  > `error.code` — `network_blocked` (asset host not allowed), `composition_not_found`,
  > `limits_exceeded`, `insufficient_credits` (buy at /app/billing), `bundle_invalid` (tar the
  > *contents* of the bundle folder, index.html at the root).

  Build the price numbers in this text from config at startup, not as literals.

- [ ] **Step 1:** Install the dependencies and write `mcp.js`.
- [ ] **Step 2: Verify.** Lint, then:
  ```bash
  npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --header "Authorization: Bearer <key>" --method tools/list
  ```
  It lists 6 tools. Then `claude mcp add --transport http darkroom-local http://localhost:3000/mcp --header "Authorization: Bearer <key>"`
  and have Claude Code render the ButtonAd bundle through it: upload, submit, poll to `done`.
- [ ] **Step 3: Commit** `feat(server): MCP server over Streamable HTTP`

### Task 6: Clerk auth, dashboard API, admin API, Clerk webhook

**Files:**
- Create:
  - `server/src/accounts.js`
  - `server/src/routes/dashboard.js`
  - `server/src/routes/admin-api.js`
  - `server/src/routes/inbound-webhooks.js`
- Modify:
  - `server/src/index.js`
  - `server/src/admin.js` (use `createAccount`)
  - `server/package.json` (`@clerk/express`)

**Interfaces:**
- Produces from `accounts.js`:
  - `createAccount(c, { name, email, clerkUserId, plan }) → row`. Generates the id and
    `whsec_` secret as `admin.js` does today.
  - `accountForClerkUser(userId) → row`. Lazy-create, race-safe: insert with
    `ON CONFLICT (clerk_user_id) DO NOTHING`, then select. Name and email come from
    `clerkClient.users.getUser` only on first creation. Plan is `trial` (with
    `approveAccount`) if `config.signupMode === 'open'`, else `waitlist`.
  - `revokeAllKeys(c, accountId)`.
- Middleware in `dashboard.js`:
  - `clerkMiddleware()`
  - `requireUser`: `getAuth(req).userId`, else 401 `unauthorized`. Disabled accounts get 403
    `forbidden`. Sets `req.account` with the same shape as `apiKeyAuth` plus `email`, and
    `req.isAdmin`.
  - `requireApproved`: plan ≠ `waitlist`, else 403 `not_approved`.
  - Rate limit: 120/min per user.
- Routes:
  - `GET /api/public-config`, no auth, mounted before Clerk middleware:
    `{ clerkPublishableKey, signupMode, prices: { perMinuteUsd, minSeconds, tiers }, packs }`
  - `GET /api/me`: `{ account: { id, name, email, plan, balance, available, approvedAt }, limits, isAdmin }`
  - `GET /api/jobs`, `GET /api/jobs/:id` (adds `queuePosition`, `worker`), `DELETE /api/jobs/:id`
  - Keys:
    - `GET /api/keys`: prefix, label, created, last used, revoked
    - `POST /api/keys {label}` (`requireApproved`, max 10 active, else 409 `too_many_keys`):
      `{ id, key, prefix, label }`
    - `DELETE /api/keys/:id`
  - Webhook secret: `GET /api/webhook-secret`, `POST /api/webhook-secret/rotate`
  - `POST /api/invite/redeem {code}`. In a `tx`:
    1. Lock the code row.
    2. It must be valid: not disabled, not expired, `uses < max_uses`. Otherwise 400
       `invite_invalid`.
    3. `approveAccount`, then `uses + 1`.
    4. If the account isn't `waitlist`, return 409 `already_approved` without consuming a use.
  - `GET /api/billing`: `{ balance, available, ledger }`
  - `GET /api/status`: `workerStatus()` + `{ queued: count }`
- `admin-api.js`, mounted at `/api/admin`, behind `requireUser` + `requireAdmin` (403
  `forbidden`):
  - `GET /waitlist`
  - `POST /accounts/:id/approve`
  - `GET /accounts`: plan, balance, job count, created, email
  - `POST /accounts/:id/disable`: `disabled_at`, revoke keys
  - `POST /accounts/:id/ledger {kind: 'grant'|'refund', amountUsd, note}`:
    - `grant` takes a signed amount; `refund` is stored negative.
    - `created_by` is the admin's Clerk id.
  - `GET /invites`
  - `POST /invites {note, maxUses, expiresInDays}` generates `DRK-XXXX-XXXX`. Use the alphabet
    `ABCDEFGHJKMNPQRSTUVWXYZ23456789` and `crypto.randomInt`.
  - `POST /invites/:code/disable`
  - `GET /jobs`: latest 100 across accounts, with account email
- `inbound-webhooks.js` exports `clerkWebhook`, mounted as
  `app.post('/webhooks/clerk', express.raw({ type: 'application/json' }), clerkWebhook)`:
  - Verify with `verifyWebhook(req, { signingSecret })` from `@clerk/express/webhooks`.
  - On `user.deleted`: set `disabled_at` and revoke keys.
  - Respond 200 for other events.
- `index.js` order:
  1. helmet
  2. webhooks (raw)
  3. `/v1/uploads/:token` PUT
  4. `/v1`
  5. `/mcp`
  6. `/worker`
  7. `/api/public-config`
  8. `/api` (Clerk)
  9. static SPA (Task 8)
  10. 404
  11. error handler

- [ ] **Step 1:** Ask the owner to create a Clerk **development** instance and enable email +
  password and GitHub, plus bot protection and the disposable email block. Have them put
  `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `server/.env` themselves.
- [ ] **Step 2:** Write `accounts.js`, `dashboard.js`, `admin-api.js` and the Clerk webhook.
- [ ] **Step 3: Verify.** Lint and boot. `curl /api/public-config` returns the publishable key.
  `curl /api/me` without a session → 401. The authenticated paths are verified through the web
  app in Task 9.
- [ ] **Step 4: Commit** `feat(server): Clerk-backed dashboard and admin API`

### Task 7: Stripe credit packs

**Files:**
- Create: `server/src/billing/stripe.js`
- Modify:
  - `server/src/routes/dashboard.js` (`POST /api/billing/checkout`)
  - `server/src/routes/inbound-webhooks.js` (`stripeWebhook`)
  - `server/src/index.js`
  - `server/package.json` (`stripe`)

**Interfaces:**
- Produces from `stripe.js`:
  - `createCheckout(account, pack: 10|25|100) → url`:
    - Create the Stripe customer if missing (email, `metadata.accountId`) and store
      `stripe_customer_id`.
    - Session:
      - `mode: 'payment'`
      - `customer`, `customer_update: { address: 'auto' }`
      - `automatic_tax: { enabled: true }`
      - one line item: `price_data { currency: 'usd', unit_amount: pack * 100, tax_behavior: 'exclusive', product_data: { name: 'Darkroom credits — $<pack>' } }`
      - `metadata: { accountId, pack }`
      - `success_url: <publicBaseUrl>/app/billing?paid=1`
      - `cancel_url: <publicBaseUrl>/app/billing`
    - Waitlist accounts get 403 `not_approved`. A pack not in `config.packs` gets 400.
  - `handleStripeEvent(event)`. For `checkout.session.completed` and
    `checkout.session.async_payment_succeeded` with `payment_status === 'paid'`, in a `tx`:
    1. `lockAccount`.
    2. `addEntry({ kind: 'purchase', amountMicro: pack * 1e6, stripeSessionId: session.id })`.
    3. If inserted and plan is `waitlist` or `trial` → `paid`. Waitlist can't reach checkout,
       so this is defensive.
- `stripeWebhook`, mounted as
  `app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhook)`:
  - `stripe.webhooks.constructEvent(req.body, sig, secret)`. A bad signature → 400.
  - Handler errors → 500, so Stripe retries.

- [ ] **Step 1:** Ask the owner for Stripe **test** keys in `server/.env`, and to enable Stripe
  Tax in test mode, with an origin address.
- [ ] **Step 2:** Write `stripe.js` and the routes.
- [ ] **Step 3: Verify.**
  - `stripe listen --forward-to localhost:3000/webhooks/stripe`, if the Stripe CLI is
    installed. If not, ask the owner whether to install it; otherwise verify after deploy.
  - Check out the $10 pack with card `4242 4242 4242 4242` (done through the web app in
    Task 9, or by `curl` with a session token).
  - The ledger gains +10,000,000, and the plan becomes `paid`.
  - `stripe events resend <evt>` adds nothing.
- [ ] **Step 4: Commit** `feat(server): Stripe Checkout credit packs`

### Task 8: Web app scaffold, served by Express, Docker build

**Files:**
- Create:
  - `web/package.json`, `web/vite.config.js`, `web/index.html`
  - `web/src/main.jsx`, `web/src/App.jsx` (routes)
  - `web/src/api.js`
  - `web/src/index.css` (Tailwind 4 `@import "tailwindcss"`)
  - `web/src/components/Layout.jsx`
- Modify:
  - root `package.json` (workspaces add `web`)
  - `eslint.config.js` (`web/**/*.{js,jsx}`: browser globals, `eslint-plugin-react-hooks`,
    `eslint-plugin-react-refresh`, JSX parsing)
  - `server/src/index.js` (static + SPA fallback + CSP)
  - `server/Dockerfile`
  - `.dockerignore` (`web/dist`)

**Interfaces:**
- `main.jsx`:
  - Fetch `/api/public-config`, then render
    `<ClerkProvider publishableKey={…}><RouterProvider/></ClerkProvider>`.
  - The publishable key is read at runtime, so no Vite build-time env and no Coolify build args.
- `api.js`:
  - An Axios instance at `/api`.
  - `setTokenGetter(fn)`; a request interceptor adds `Authorization: Bearer ${await fn()}`.
  - `Layout` calls `setTokenGetter(getToken)` from `useAuth()`.
- Routes:
  - Public: `/` (Landing), `/sign-in/*`, `/sign-up/*` (Clerk `<SignIn/>` / `<SignUp/>` with
    `routing="path"`).
  - `/app/*` is protected (redirect to sign-in when signed out) and uses `Layout`, a sidebar
    with:
    - Jobs `/app`
    - Get started `/app/start`
    - API keys `/app/keys`
    - Billing `/app/billing`
    - Settings `/app/settings`
    - Admin `/app/admin` (only if `isAdmin`)
- `Layout` loads `/api/me` and shows the worker status line from `/api/status`. If the plan is
  `waitlist`, it renders the WaitingRoom (Task 9) instead of any page except `/app/start`.
- Express:
  - `express.static(config.webDist, { index: false })`. `/assets/*` gets
    `Cache-Control: public, max-age=31536000, immutable`.
  - Then `GET` on any path not starting with `/v1`, `/api`, `/mcp`, `/worker`, `/webhooks` or
    `/healthz` → `index.html`.
  - If `web/dist` is missing (dev), skip both.
- Helmet CSP directives. `clerkFapi` is decoded from the publishable key:
  `Buffer.from(pk.split('_')[2], 'base64').toString().replace(/\$$/, '')`.
  - `script-src 'self' https://${clerkFapi} https://challenges.cloudflare.com`
  - `connect-src 'self' https://${clerkFapi}`
  - `img-src 'self' data: https://img.clerk.com`
  - `frame-src https://challenges.cloudflare.com`
  - `worker-src 'self' blob:`
  - `style-src 'self' 'unsafe-inline'`
  - `media-src 'self' ${config.bunny.cdnBase}`
- Dockerfile:
  - Add a `web` build stage: `node:22-slim`; copy the root and all workspace `package.json`s
    plus the lockfile; `npm ci -w web --include-workspace-root=false`; copy `web/`;
    `npm run build -w web`.
  - The final stage does `COPY --from=web /app/web/dist /app/web/dist`. The existing server
    install is unchanged.
- `vite.config.js`: React plugin, `@tailwindcss/vite`, dev proxy for `/api`, `/v1`, `/mcp` →
  `http://localhost:3000`.

- [ ] **Step 1:** Scaffold `web/` and install. The versions per Global Constraints are React 19,
  React Router 7, Vite 7, Tailwind 4, lucide-react, axios, `@clerk/react`. `npm install` at the
  root updates the lockfile.
- [ ] **Step 2:** Update ESLint, Express static/CSP and the Dockerfile.
- [ ] **Step 3: Verify.**
  - `npm run lint`
  - `npm run build -w web`
  - Boot the server. `http://localhost:3000/` serves the SPA; `/app` redirects to sign-in;
    sign up with the Clerk dev instance and land on the WaitingRoom placeholder.
  - The browser console shows no CSP errors.
  - `docker build -f server/Dockerfile .` succeeds.
- [ ] **Step 4: Commit** `feat(web): SPA scaffold with Clerk, served by Express`

### Task 9: Dashboard pages

Before building UI, invoke the `frontend-design` skill. The visual direction is "darkroom":
near-black surfaces, a single safelight-red accent, monospace for ids, keys and costs. Use
lucide icons.

**Files:**
- Create `web/src/pages/`:
  - `Landing.jsx`
  - `WaitingRoom.jsx`
  - `GetStarted.jsx`
  - `Jobs.jsx`
  - `JobDetail.jsx`
  - `Keys.jsx`
  - `Billing.jsx`
  - `Settings.jsx`
- Create `web/src/components/`:
  - `StatusLine.jsx`
  - `CopyButton.jsx`
  - `JobStatusBadge.jsx`

**Interfaces:**
- Consumes: the `/api` routes from Tasks 6–7 and `/api/public-config`.

**Page contents** (copy and prices come from `public-config`, never hard-coded):
- **Landing:**
  - one-line pitch
  - price table (per minute, tiers, min 15 s, failed free)
  - "Join the waitlist" / "Sign in"
  - the `claude mcp add` snippet
  - the network allowlist note
- **WaitingRoom:** "You're on the list", plus an invite code input → `POST /api/invite/redeem`.
  On success, refetch `/api/me`.
- **GetStarted:**
  - `claude mcp add --transport http darkroom <origin>/mcp --header "Authorization: Bearer <key>"`
    (with `<key>` as a placeholder and a link to Keys)
  - the Cursor `mcp.json` and Codex `config.toml` equivalents
  - REST curl for the upload link + submit, and for multipart
  - the bundling commands
  - the allowlist
  - the error code table (from the README)
- **Jobs:** a table with status badge, composition, duration (`video.frames / video.fps`),
  resolution, cost (or estimated), created. It polls every 5 s while any job is active, and
  pages with `before`.
- **JobDetail:**
  - fields, error message
  - `<video controls src={outputUrl}>` + download link + expiry
  - queue position and worker status when queued
  - a Cancel button when active
- **Keys:** list, a create dialog (label) showing the key once with `CopyButton` and a
  "you won't see this again" note, revoke with confirm.
- **Billing:**
  - balance and available
  - three pack buttons → `POST /api/billing/checkout` → `window.location = url`
  - a `?paid=1` banner, refetched after 2 s
  - the ledger table (kind, amount, job link, date)
- **Settings:**
  - webhook secret (reveal, copy, rotate with confirm)
  - Clerk `<UserProfile/>` for email, password, GitHub and deletion
- **StatusLine** reads `/api/status`:
  - "Renderer idle", "Rendering — N queued", "Paused until 18:00 (your time)", or "Offline".
  - Format `until` in local time.

- [ ] **Step 1:** Build the pages.
- [ ] **Step 2: Verify.** Lint and build, then use a real browser at `localhost:3000`:
  1. Sign up (dev Clerk) → WaitingRoom.
  2. Create an invite with psql, or the admin API once Task 10 lands, and redeem it → trial
     with $1.50.
  3. Create a key, then render through MCP with it. The Jobs page shows progress, then the
     preview plays.
  4. Buy $10 with the test card → balance $11.50 minus usage, and the plan is `paid`.
  5. Pause the Mac worker → the status line says paused.
- [ ] **Step 3: Commit** `feat(web): dashboard pages`, splitting into several commits as pages
  land.

### Task 10: Admin page

**Files:**
- Create: `web/src/pages/admin/Admin.jsx`, with tabs Waitlist, Invites, Accounts, Jobs.

**Interfaces:**
- Consumes: the `/api/admin/*` routes from Task 6.

**Tabs:**
- **Waitlist:** email, signed up, Approve.
- **Invites:** create (note, max uses, expires in days) shows the code with copy; a list with
  uses; disable.
- **Accounts:** email, plan, balance, jobs, created, plus row actions:
  - Grant or Refund: amount in USD and a note
  - Disable, with confirm
- **Jobs:** the latest 100 across accounts, with account email, status, cost, error code.

- [ ] **Step 1:** Build it.
- [ ] **Step 2: Verify.** Put your own dev Clerk user id in `ADMIN_CLERK_USER_IDS`; the Admin
  link appears only for you. Then:
  - Approve a second test signup → it gets trial.
  - Grant $1 → the ledger and balance update.
  - Disable it → its key gets 401 on `/v1/jobs`.
- [ ] **Step 3: Commit** `feat(web): admin page`

### Task 11: Docs, then rollout (each outward step asked first)

**Files:**
- Modify:
  - `README.md`: new domain, pricing, plans, upload-link API, `/mcp` with the `claude mcp add`
    example, the new error codes, `account:plan`, new env vars
  - `docs/superpowers/specs/2026-11-19-render-job-system-design.md`: uploads spool to disk
    before Bunny (deferred issue #11)
  - `server/.env.example`

- [ ] **Step 1:** Update the docs. Commit `docs: paid service — API, MCP, billing, deploy notes`.
- [ ] **Step 2:** Run `superpowers:requesting-code-review`: one fresh reviewer for the whole
  branch, on the most capable model. Fix what it finds, with `fix:` commits.
- [ ] **Step 3: Ask the owner, then do.** Clerk **production** instance for
  `darkroom.jiayangchen.com`, with its DNS records added in Cloudflare (DNS-only, per Clerk's
  list). Settings as in Task 6, step 1.
- [ ] **Step 4: Ask, then do.** Cloudflare: `darkroom.jiayangchen.com` CNAME to `a.lsjc.dev`,
  **DNS-only**. In Coolify, add the domain to `darkroom-server` next to `darkroom.lsjc.dev`.
- [ ] **Step 5: Ask, then do.** Coolify env:
  - `PUBLIC_BASE_URL=https://darkroom.jiayangchen.com`
  - `CLERK_*`, `STRIPE_*` (test keys first)
  - `ADMIN_CLERK_USER_IDS` (the owner's prod user id, after their first sign-in)
  - `SIGNUP_MODE=waitlist`
  - Register the Clerk webhook (`/webhooks/clerk`, `user.deleted`) and the Stripe webhook
    (`/webhooks/stripe`, the two checkout events).
- [ ] **Step 6: Ask, then do.** Deploy. `/healthz` is ok; the logs show migration 003; the
  existing owner key still renders via the CLI on `darkroom.lsjc.dev`.
- [ ] **Step 7: Ask, then do.** rsync the worker to the Mac:
  ```bash
  rsync -az --exclude node_modules --exclude .env --exclude .git ./ mac-studio:darkroom/
  ```
  Then `launchctl kickstart -k gui/$(id -u)/com.darkroom.worker`. Confirm the log shows a
  normal start, and that `/api/status` reflects the worker's pause state.
- [ ] **Step 8: Verify for real on production (Stripe test mode).**
  1. The owner signs up and is set as admin.
  2. A second account signs up → waitlist → approved.
  3. A key, then an MCP render from Claude Code.
  4. A test purchase.
  5. An `insufficient_credits` case: a trial account rendering more than $1.50, or a 4K video.
  6. Paused status shown.
- [ ] **Step 9:** Report to the owner. Stripe live keys wait until the Remotion license is
  settled, which is the owner's call. Update the memory note about Darkroom with the new domain
  and status.
