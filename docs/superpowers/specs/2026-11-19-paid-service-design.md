# Darkroom paid service: design

Date: 2026-11-19
Status: draft, awaiting owner approval

## Intent

Project 1 built the job system and the Mac Studio worker
(`docs/superpowers/specs/2026-11-19-render-job-system-design.md`). Project 2 turns it into a
service people pay for. Developers who run AI agents (Claude Code, Cursor, Codex, their own) sign
up, buy prepaid credits, and give their agents an API key. The agents upload finished Remotion
bundles, over REST or MCP, and get back a CDN link to the mp4.

Agents are the real users, so the MCP server and the agent-facing docs matter as much as the
dashboard. Capacity is one shared Mac (M4 Max, 36 GB), sometimes paused for the owner's own model
work. The launch is therefore gated (waitlist + invite codes), and the service is honest about
queue and pause state.

## Goals

- A person can sign up (email + password or GitHub), get approved or use an invite code, create
  API keys, buy credits, and watch their jobs render. All from a web dashboard.
- An agent can do everything over MCP with only an API key, a shell, and `curl`.
- Each job's price is known before it renders, from the video's length and resolution. It never
  depends on how busy the Mac is.
- The owner can approve waitlist entries, issue invite codes, grant credits, and see accounts,
  from an admin page.
- Customers can see whether the worker is rendering, idle, paused (and until when), or offline,
  and where their job sits in the queue.

## Non-goals (v1)

- Teams or organizations. Accounts are designed so a team layer can be added later.
- OAuth for MCP (needed only for claude.ai / ChatGPT connector directories, whose chat-only
  clients can't build bundles anyway).
- The server fetching bundles from a customer URL.
- Base64 bundles inside MCP tool calls.
- Subscriptions, monthly plans, invoicing, volume discounts.
- Low-balance or job-done emails. Webhooks and Stripe receipts cover this.
- A marketing site beyond a simple landing page.

## Anti-goals (failure even if it works)

- Any weakening of the project 1 security model:
  - the render network allowlist
  - the Chrome filtering proxy
  - the Node socket guard
  - `sandbox-exec` for ffmpeg and the compositor
  - Chrome coming from the worker's pinned version
- A customer is charged for a job that failed or was canceled.
- A customer is charged more than the price shown before rendering.
- Two concurrent jobs both pass the balance check and overdraw the account.
- A paid credit purchase is lost, or credited twice (a webhook retried).
- Card data, Clerk passwords, or API keys in plain text touch Darkroom's database or logs.
- An agent has to put its API key into a shell command to upload a bundle.

## Decisions (made with the owner, 2026-11-19)

| Topic | Decision |
|---|---|
| Customers | Individuals who run agents. One person = one account. |
| Unit | Output video-seconds, scaled by resolution |
| Price | $0.15 per video-minute at ≤1080p, billed per second. ≤1440p 2×, above 1440p (up to 4K) 4×. Minimum 15 s billed per job. |
| Payment | Prepaid credit packs of $10 / $25 / $100, no discount |
| Trial | 10 minutes of 1080p ($1.50), one time, when the account is let in |
| Failed and canceled jobs | Free |
| Payment provider | Stripe Checkout + Stripe Tax. The owner is the seller and registers for tax as thresholds require. |
| Domain | `darkroom.jiayangchen.com` is the main address. `darkroom.lsjc.dev` stays attached to the same app (CLI, worker, existing keys keep working). DNS-only, never Cloudflare-proxied (100 MB upload cap). |
| App layout | One Express app (`darkroom-server`) serves the SPA, `/v1`, `/api`, `/mcp`, and the webhooks |
| Human auth | Clerk (email + password, GitHub), prebuilt components |
| Agent auth | Existing `dr_live_` API keys, as a Bearer header, for both REST and MCP |
| MCP bundle upload | Two steps: an upload link, then a `curl PUT`, then submit |
| Launch | Waitlist + invite codes. Opening signup later is one setting. |
| Remotion license | The owner checks it before launch (see "Open risk"). |

## Approaches considered

**Where the web app runs**
- *Chosen:* same Express server, same origin.
- *Rejected:* a separate dashboard app or subdomain. It means CORS, cross-site cookies, and a
  second deploy, with no load reason to split.

**Human auth**
- *Chosen:* Clerk. It removes our own password storage, verification and reset emails, and the
  GitHub OAuth plumbing. It brings bot protection and disposable-email blocking.
- *Rejected:* JWT + bcryptjs + Resend, the owner's usual stack. Owner preferred Clerk.

**Payments**
- *Chosen:* Stripe.
- *Considered:* a merchant of record (Paddle, Lemon Squeezy), which would handle global tax.
  Owner chose Stripe for lower fees and familiarity.

**Pricing unit**
- *Chosen:* output video-seconds.
- *Rejected:* render-seconds, which vary with how much memory the owner's own models are using,
  so customers couldn't predict them.

**Pricing model**
- *Chosen:* prepaid credits. They avoid surprise bills from agents, and unpaid invoices.
- *Rejected:* monthly plans, which promise capacity one Mac can't guarantee.

**MCP upload**
- *Chosen:* an upload link.
- *Rejected:* base64 in the tool call (a bundle becomes tens of MB of tokens) and server-side
  fetch (not wanted in v1).

**MCP auth**
- *Chosen:* API key header. Claude Code, Cursor, and Codex all support it.
- *Deferred:* OAuth, to a later project if a connector directory listing becomes worth it.

## Design

### Throughput and pricing basis

- Measured on the Mac with 4 tabs: ButtonAd (67 s, 1080×1920, 30 fps, heavy three.js) renders in
  79–106 s. That's about 40 video-minutes per Mac-hour for heavy 3D. 2D content is faster.
- For comparison, Shotstack charges $0.30/min pay-as-you-go and $0.20/min on its $39 plan.
- Prices live in config, not code:
  - `PRICE_MICROUSD_PER_SECOND` = 2500
  - `PRICE_MIN_SECONDS` = 15
  - resolution tiers by output pixel count:
    - ≤ 2,073,600 px (1920×1080, either orientation) → 1×
    - ≤ 3,686,400 px (2560×1440) → 2×
    - above → 4×
- **Job cost** = `max(PRICE_MIN_SECONDS, ceil(renderFrames / fps)) × multiplier × PRICE_MICROUSD_PER_SECOND`.
  - It uses the output size after `scale`.
  - It uses the frames actually rendered (after `frameRange`).
- **Frame rate cap** (fixes deferred issue #1, and required by per-second pricing):
  - New limit `maxFps` = 60 (config + per-account override).
  - Enforced in `video-meta` alongside the existing limits. A 120 fps video would otherwise cost
    the same per second for twice the work.
  - `maxRenderMinutes` still bounds pathologically heavy compositions.

### Money: ledger, balance, holds

All amounts are integer **micro-USD** (`bigint`). $1 = 1,000,000.

**New table `credit_ledger`** (append-only):
- columns: id, account_id, at, `kind`, amount_micro (signed), job_id, stripe_session_id
  (unique where not null), note, created_by
- `kind` values:
  - `purchase` (+)
  - `trial` (+)
  - `grant` (±, admin)
  - `charge` (−, one per done job, unique on job_id where kind = 'charge')
  - `refund` (−, admin records a Stripe refund)

**New columns on `accounts`:**
- `balance_micro bigint` — settled balance. It always equals the ledger sum and is updated in
  the same transaction as each ledger insert.
- `plan` — one of `waitlist`, `trial`, `paid`, `internal`.
- `clerk_user_id` (unique, nullable for the owner and admin-created accounts)
- `email`
- `stripe_customer_id`
- `approved_at`

**New columns on `jobs`:**
- `hold_micro` — the active reservation, null when none
- `cost_micro` — the final charge, set when the job reaches `done`

**Available balance** = `balance_micro − sum(hold_micro of this account's non-terminal jobs)`.

**At submit** (`POST /v1/jobs`, MCP `submit_render`):
- Lock the account row (`SELECT … FOR UPDATE`).
- Re-count active jobs inside that lock. This fixes deferred issue #4.
- Require available ≥ the minimum charge at 1×. Otherwise return 402 `insufficient_credits`
  (new error code).
- Insert the job in the same transaction.

**At `video-meta`** (worker → server, already called before rendering starts):
- Compute the exact cost.
- In one transaction, lock the account, then re-check available (excluding this job's own
  current hold).
- Set `jobs.hold_micro = cost`. Idempotent: a requeued attempt calling `video-meta` again just
  overwrites its own hold.
- If it doesn't fit, fail the job `insufficient_credits` with no charge, the same way
  `limits_exceeded` works today. No worker change is needed for billing.

**At `complete`** (status → `done`):
- In the same transaction:
  - insert a `charge` ledger row of −`hold_micro`
  - decrement `balance_micro`
  - set `cost_micro`
  - clear `hold_micro`

**Any other terminal state** (`failed`, `canceled`, `expired` before done, `worker_lost` via the
sweeper):
- Clear `hold_micro`. Nothing is charged.

**`internal` plan** (the existing `owner` account):
- Never held or charged.
- Its `cost_micro` is still computed, for reporting.

The public job object gains `cost` (USD as a decimal string, e.g. `"0.1675"`), plus `estimatedCost`
while a hold exists.

### Plans and limits

`accountLimits()` becomes: config defaults ← plan defaults ← `accounts.limits` overrides.

| Plan | How you get it | Limits |
|---|---|---|
| `waitlist` | Signed up, not yet let in | Can sign in and see the dashboard. Cannot create keys or submit. |
| `trial` | Approved by admin or redeemed an invite code. Grants the $1.50 trial once. | 1 active job, max 1920×1080 by pixel count, `maxDurationSec` 120, 30 req/min |
| `paid` | First successful purchase (permanent, even at zero balance) | Today's defaults: 5 active jobs, 600 s, 3840×2160, 60 req/min |
| `internal` | The owner's account (migration sets the existing `owner` account) | Defaults, never billed |

### Waitlist and invite codes

**New table `invite_codes`:**
- columns: code (random, human-typable, e.g. `DRK-7Q4M-X2PA`), note, max_uses, uses, expires_at,
  created_at, disabled_at

**Redeeming a code:**
- A `waitlist` user does it on the dashboard ("Have an invite code?").
- In one transaction: plan → `trial`, `approved_at` set, `trial` ledger row added, `uses`
  incremented.
- The trial is granted once per account, ever. Enforced by a unique partial index on
  `credit_ledger(account_id) WHERE kind = 'trial'`.

**Admin approval** does the same as redeeming a code, without a code.

**Config `SIGNUP_MODE`:**
- `waitlist` (default)
- `open` — new accounts start at `trial` directly

### Auth

**Clerk**
- Frontend: `@clerk/react` with React Router 7, current SDK.
- Backend: `@clerk/express`. `clerkMiddleware()` on `/api`, and `getAuth(req)` in a
  `requireUser` middleware.
- Account creation is lazy. The first authenticated `/api` request with an unknown `userId`
  creates the account:
  - plan `waitlist`, or `trial` in open mode
  - name and email from Clerk
- A Clerk webhook (`/webhooks/clerk`, Svix signature verified) handles `user.deleted`:
  - revokes all the account's API keys
  - marks the account disabled (new `disabled_at` column)
  - keeps jobs and ledger rows for records
- Clerk dashboard settings:
  - email + password and GitHub enabled
  - bot protection on sign-up
  - disposable email domains blocked
  - email verification required
- Admin users: env `ADMIN_CLERK_USER_IDS` (comma list). `requireAdmin` checks it.

**API keys**
- Unchanged mechanism: sha256 hash, `dr_live_` prefix, shown once.
- Now creatable and revocable from the dashboard.
- Max 10 active keys per account.
- Disabled accounts (`disabled_at`) fail key auth.
- `waitlist` accounts can't create keys.

**Webhook secret**
- Shown in the dashboard (it is the account's per-account HMAC secret).
- Has a rotate button.

### Upload links (REST and MCP)

**`POST /v1/uploads`** (API key auth)
- Returns:
  ```json
  { "uploadId", "uploadUrl", "expiresAt", "maxBytes", "curl" }
  ```
- `uploadUrl` is `https://darkroom.jiayangchen.com/v1/uploads/<token>`.
- The token:
  - 32 random bytes, base64url
  - stored hashed, single use, valid 15 min
  - bound to the account
- New table `uploads`: id, account_id, token_hash, status (`pending`, `received`, `used`,
  `expired`), bundle_path, bytes, remotion_version, created_at, expires_at.

**`PUT /v1/uploads/:token`**
- Authenticated by the token alone. It sits outside the `apiKeyAuth` router, so the agent's shell
  command never contains the API key.
- Body: the raw `.tar.gz`.
- Reuses the existing streaming spool path:
  - size cap
  - idle and total deadlines
  - per-account in-flight cap
  - `inspectBundle`
  - then Bunny PUT to `bundles/<account>/upload-<id>.tar.gz`
- Marks the upload `received`, with its Remotion version.
- Returns `{ uploadId, bytes, remotionVersion }`.
- Errors use the same codes as today (`bundle_invalid`, `bundle_too_large`, …).

**`POST /v1/jobs` with `Content-Type: application/json`**
- Body: `{ uploadId, composition, inputProps, … }`, the same fields as the multipart `job` part.
- Uses a `received` upload of the same account.
- Marks the upload `used` and creates the job directly as `queued`, with `bundle_path` pointing
  at the upload object.
- Multipart `POST /v1/jobs` keeps working unchanged.

**Sweeper**
- Deletes Bunny objects of `pending` or `received` uploads older than 1 h.
- Marks them `expired`.

The job submit logic (validation, active-job lock, balance check, insert) moves from
`routes/public.js` into a shared service module, `server/src/jobs/service.js`, used by REST and MCP
alike.

### MCP server

- `@modelcontextprotocol/sdk`, Streamable HTTP, **stateless** (a new server and transport per
  request, no sessions), mounted at `/mcp` in the same Express app.
- Auth: the existing `apiKeyAuth` (Bearer `dr_live_…`) plus the same per-key rate limit.
- Tools, each a thin wrapper over the service module:

| Tool | Input | Output |
|---|---|---|
| `create_upload` | none | `uploadId`, `uploadUrl`, `expiresAt`, `maxBytes`, and the exact commands to bundle and upload |
| `submit_render` | `uploadId`, `composition`, optional `inputProps`, `frameRange`, `scale`, `codec`, `crf`, `webhookUrl` | the job |
| `get_job` | `jobId` | the job, plus `queuePosition` and `worker` status |
| `list_jobs` | optional `limit`, `before` | jobs |
| `cancel_job` | `jobId` | the job |
| `get_balance` | none | balance, available, plan, limits, prices, worker status |

- The `create_upload` commands are:
  ```bash
  npx remotion bundle <entry> --out-dir build
  tar -czf bundle.tar.gz -C build .
  curl -fsS -T bundle.tar.gz '<uploadUrl>'
  ```
- Tool descriptions and server `instructions` carry the agent guide:
  - bundle, don't send source
  - the network allowlist and `staticFile()`
  - poll `get_job` every ~10 s or use a webhook
  - what each error code means and how to fix it
- Errors return MCP tool errors carrying the same `{ code, message }` as REST.

### Worker status

The server needs to know when the worker is paused. Today a paused worker simply stops polling.

**Worker change** (small; synced to the Mac with rsync like any worker update):
- While paused, the worker POSTs `/worker/status` every 60 s with `{ state: 'paused', until }`.
  It already computes `p.paused` / `reason` in `worker/src/index.js`.
- `until` is the end of the `PAUSE_SCHEDULE` window, or null for a manual pause.
- Active polling implies `idle` or `rendering`.

**Server side:**
- Store the state on `workers` (new columns `state`, `state_until`).
- Derive the public status:
  - `rendering` — some job is in a `rendering` / `uploading_output` state
  - `idle` — seen in the last 90 s and not rendering
  - `paused` (with `until`)
  - `offline` — no contact for over 2 minutes
- `queuePosition` = the number of `queued` jobs (all accounts) with an earlier `queued_at`, plus 1.

### Stripe

- `POST /api/billing/checkout` with `{ pack: 10 | 25 | 100 }`:
  - Creates a Checkout Session (`mode: payment`, inline `price_data`, `automatic_tax: enabled`).
  - Reuses or creates the account's Stripe customer.
  - `metadata: { accountId, pack }`, success and cancel URLs back to the dashboard.
  - Prices are tax-exclusive: a $10 pack gives $10 of credit, and tax is added at checkout.
  - Returns the URL; the SPA redirects.
- `POST /webhooks/stripe`:
  - Raw body, signature verified with `STRIPE_WEBHOOK_SECRET`.
  - Handles `checkout.session.completed` and `checkout.session.async_payment_succeeded`, only
    when `payment_status = 'paid'`.
  - Inserts a `purchase` ledger row for the pack's **pre-tax** amount. Unique on
    `stripe_session_id`, so retries are harmless.
  - Increments the balance and sets plan `paid` (unless `internal`).
- Refunds and disputes are handled by hand in v1. The owner refunds in Stripe, then records a
  `refund` ledger row from the admin page.
- Receipts come from Stripe.
- Test mode first; live keys only after the owner says so.

### Web app (`web/` workspace)

**Stack:** React 19, React Router 7 (SPA mode), Vite 7, Tailwind 4, lucide-react, Axios with a
Clerk session-token interceptor.

**Build and serve:**
- The server Dockerfile builds `web/`.
- Express serves `web/dist` with an `index.html` fallback for non-API paths.

**Helmet CSP** gets the origins Clerk needs:
- its Frontend API domain
- `img.clerk.com`
- Cloudflare Turnstile for bot protection

Plus the Bunny CDN for `<video>` previews, and Stripe Checkout as a redirect only.

**Pages:**
- **Landing** (`/`): what it is, the price, the waitlist / sign-up button, and a short
  agent-first example (`claude mcp add …`).
- **Get started:**
  - the copy-paste `claude mcp add --transport http darkroom https://darkroom.jiayangchen.com/mcp --header "Authorization: Bearer <key>"`
  - the same for Cursor / Codex
  - curl / REST examples
  - bundling steps, the network allowlist, prices
- **Waiting room** (plan `waitlist`): "you're on the list" plus an invite-code box.
- **Jobs:**
  - list with status, progress, composition, duration, resolution, cost, created
  - detail with error, `<video>` preview, download link, expiry
  - worker status line and queue position on queued jobs
  - live updates by polling `/api/jobs` every 5 s while anything is active
- **API keys:** list (prefix, label, created, last used), create (shown once, copy button),
  revoke.
- **Billing:** balance and available, buy packs, and the ledger with links from charges to jobs.
- **Settings:** webhook secret (reveal, rotate). Account deletion goes through Clerk's
  `<UserProfile/>`.
- **Admin** (`requireAdmin`):
  - waitlist with approve buttons
  - invite codes (create, disable, usage)
  - accounts (plan, balance, jobs, disable)
  - manual ledger entries (grant, refund)
  - recent jobs across accounts

**Dashboard API** (`/api`, Clerk session, `express.json`, rate-limited per user):
- `me`
- `jobs` (list, get, cancel)
- `keys` (list, create, revoke)
- `billing` (balance, ledger, checkout)
- `invite/redeem`
- `webhook-secret` (get, rotate)
- `status`
- `admin/*`

### Deferred issues fixed here (we touch these areas)

- #1 frame-rate cap (above)
- #4 atomic active-job count (above)
- #7 UUID validation on `/worker/jobs/:id/*`, returning 409/404 instead of 500
- #11 update the project 1 spec to say uploads spool to disk first

The others stay deferred.

### Rollout (each outward step confirmed with the owner first)

1. Clerk: create the production instance and add its DNS records on `jiayangchen.com`.
2. Stripe: the owner provides test keys; register the webhook endpoint; enable Stripe Tax.
3. DNS: `darkroom.jiayangchen.com`, DNS-only, pointing at the Coolify host. Add the domain to
   the `darkroom-server` app next to `darkroom.lsjc.dev`.
4. Env vars on Coolify:
   - `CLERK_*`, `STRIPE_*`
   - `ADMIN_CLERK_USER_IDS`, `SIGNUP_MODE`
   - price settings
   - `PUBLIC_BASE_URL` → the new domain
5. Deploy. Migrations run on boot; the existing `owner` account becomes `internal`.
6. Worker update rsynced to the Mac, then a restart of the LaunchAgent.
7. Verify by running it for real:
   - sign up, invite code, key
   - MCP upload and render from Claude Code
   - test-mode purchase
   - an `insufficient_credits` case
   - the paused status shown
8. Switch Stripe to live keys only after the Remotion license is settled.

## Open risk: Remotion license (owner to check before taking money)

Remotion's Company License for automation is listed at $0.01 per render with a $100/month
minimum. The Enterprise tier, described as letting your customers skip their own license,
starts at $500/month. At $0.15/min these break even around 670 and 3,300 customer-minutes per
month. Which tier applies to a render-for-others service, and whether the owner is exempt as an
individual, isn't clear from the docs. This may change prices, or add a "customers need their own
Remotion license" clause to the terms. The build doesn't wait on it; going live does.

## Left to the builder

- Exact table and index definitions and migration file split (plain SQL, continuing `003_…`).
- MCP SDK version and wiring details. Exact tool description wording.
- Dashboard visual design and component structure (follow the owner's stack; lucide icons).
- Invite code format and generation.
- How the Clerk session token reaches Axios (interceptor with `getToken()`).
- Polling intervals, pagination sizes, copy text.
- Config names beyond those given here.
