# Handoff: build the Darkroom paid service

You're picking up a project mid-stream. Read this whole note before doing anything.

## What exists (project 1, done and live)

**Darkroom** is a render-only service for AI agents. An agent that has already written a Remotion
video uploads the finished bundle (a `.tar.gz` of `npx remotion bundle` output). A GPU worker
renders it, and the agent gets back a CDN link to the mp4. The job system and the Mac worker are
built, reviewed, deployed and verified end to end.

- **Repo:** `~/code/darkroom` (public, https://github.com/jiayangc1/darkroom, branch `main`).
  npm workspaces:
  - `server/`: Express 4 + Postgres job queue + BunnyCDN storage + sweeper + webhooks.
  - `worker/`: the macOS render worker.
  - `cli/`: `darkroom submit|status|wait|cancel`.
- **Read first:**
  - `README.md`: API, error codes, webhooks, admin commands, production notes.
  - `docs/superpowers/specs/2026-11-19-render-job-system-design.md`: the design and why.
  - `docs/superpowers/plans/2026-11-19-render-job-system.md`: how it was built.
- **Production API:** `https://darkroom.lsjc.dev`. It runs on Coolify, project "Darkroom":
  - app `darkroom-server` (uuid `tk1ozavijs3roqudnrz4euin`)
  - Postgres `darkroom-postgres` (uuid `ociku4qivcexpz06whimibrz`), on server "US Chicago"
  - deploys from `main` with `server/Dockerfile`
  - Coolify's own health check is off (the image has a Node `HEALTHCHECK`)
- **DNS:** Cloudflare zone `lsjc.dev`. `darkroom` is a CNAME to `a.lsjc.dev`, and it is
  **DNS-only**, because Cloudflare's proxy caps uploads at 100 MB. The owner wants **lsjc.dev
  domains only** for this project, not ch3n.cc.
- **Storage:** Bunny storage zone `darkroom` (host `la.storage.bunnycdn.com`). The pull zone is
  `https://darkroom-files.b-cdn.net`. Objects live at `bundles/<account>/<job>.tar.gz` and
  `outputs/<account>/<job>.mp4`.
- **Worker:** the owner's Mac Studio, an **M4 Max with 36 GB** (not an M3 Ultra), on macOS 26.
  - Reachable as `ssh mac-studio`.
  - Code lives at `~/darkroom` on the Mac, copied over with
    `rsync -az --exclude node_modules --exclude .env --exclude .git ./ mac-studio:darkroom/`.
    There is no git checkout there.
  - Runs as LaunchAgent `com.darkroom.worker` in the owner's login session; restart with
    `launchctl kickstart -k gui/$(id -u)/com.darkroom.worker`.
  - Log: `~/Library/Logs/darkroom-worker/worker.log`.
  - The owner runs local AI models (Ollama, ComfyUI) on this Mac, so **the worker must stay light
    on RAM**. Idle use is about 60–75 MB, and it exits after every job.
- **Secrets:** never commit them, and don't paste them into chat.
  - Bunny key: Coolify env and `server/.env` (gitignored).
  - Worker token: `worker/.env` on the Mac.
  - The owner holds the only API key (`dr_live_…`, account `owner`).
- **Admin commands** run in production through Coolify one-off scheduled tasks
  (`mcp__coolify__scheduled_tasks` action `run_once`, container `darkroom-server`, at most 255
  chars). Coolify masks anything that looks like a token in its logs, so register worker tokens by
  hash with `worker:register`.

### How it works (the parts the paid service builds on)

- **Accounts:** tables `accounts` (id, name, webhook_secret, limits jsonb) and `api_keys`
  (sha256 hashes, prefix `dr_live_`, revocable). Today accounts are created only by admin CLI.
- **Per-account limits** are an `accounts.limits` jsonb that overrides config defaults:
  - `maxActiveJobs` 5
  - `requestsPerMinute` 60
  - `maxDurationSec` 600
  - 3840×2160 output
  - bundle size 500 MB
  - `maxRenderMinutes` 60
- **Usage per job** is already recorded: `render_seconds` (worker wall time), `video_seconds`,
  `video` (width, height, fps, frames). Billing data exists; nothing bills yet.
- **Public API** at `/v1/jobs`: POST (multipart `bundle` plus a `job` JSON field), GET one,
  GET list, DELETE (cancel).
- **Statuses:** `uploading → queued → rendering → uploading_output → done`, plus
  `failed`, `canceled`, `expired`. Outputs are deleted after 7 days.
- **Webhooks** are signed `Darkroom-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`.
- **Security model:** the owner cares about this, so keep it intact.
  - Renders get no internet except an allowlist (Google Fonts, jsDelivr, unpkg, cdnjs).
  - Chrome is forced through a filtering proxy.
  - Node sockets are guarded.
  - ffmpeg and the compositor run under `sandbox-exec` with no network and no home-folder access.
  - Chrome always comes from the worker's `CHROME_REMOTION_VERSION`.

### Known minor issues (deferred from the final review; fix if you touch the area)

1. Frame rate and frame count aren't capped; only `maxRenderMinutes` bounds the work.
2. A Remotion version that doesn't exist on npm burns 3 attempts as `worker_error` instead of
   failing as `version_unsupported`.
3. Bunny `fetch` calls have no timeouts.
4. `countActive` isn't atomic with the insert.
5. A DELETE that races a requeue can lose the cancel.
6. ENOSPC or EACCES while extracting is reported as `bundle_invalid`.
7. `/worker/jobs/:id/progress` doesn't validate the UUID, so a bad id gives a 500 instead of 409.
8. A crashed renderer install leaves `*.tmp-<pid>` directories behind.
9. The child's `failAndExit` doesn't kill Chrome (the launchd startup sweep covers it).
10. A Bunny PUT that stored the object but reported failure leaves an orphan object.
11. The spec says uploads stream straight to Bunny; the code spools to disk first. Update the spec.

## What to build now (project 2): the paid service on top

From earlier conversations, the owner wants to sell this as a service, with a **web app**, a
**server** and an **MCP server**. The sketch so far:

- **Web app:** signup and login, API key management (create, revoke, show once), the job list with
  status, previews and download links, usage, and billing.
- **MCP server** over Streamable HTTP, authenticated with the same accounts/keys. Possible tools:
  `submit_render` (bundle upload or URL), `get_job`, `list_jobs`, `cancel_job`. Agents are the
  customers, so this matters as much as the web app.
- **Payments and metering:** the usage data per job already exists.
- **Rate limits and quotas** per plan, using the existing `accounts.limits`.

**Not decided yet; ask the owner, one question at a time, and don't guess:**

- **Customers:** who signs up? A person who owns agents? A company? An agent with no human
  behind it?
- **Pricing:** per render-second, per output-second, plans or credits? Free tier?
- **Payment provider.**
- **Where the web app lives** (domain on lsjc.dev), and whether it shares the Express server or is
  a separate app.
- **MCP uploads:** how an agent passes a bundle over MCP (a base64 chunk, a URL to fetch, or a
  pre-signed upload).
- **Remotion license:** the owner still needs to check Remotion's license for rendering for paying
  customers. It may shape pricing, so flag it again.

## How the owner works (follow this)

- **Stack** (the owner's global CLAUDE.md has the full list):
  - frontend: React 19, React Router 7, Vite 7, Tailwind 4, lucide-react, Axios
  - backend: Express 4, ES modules, `pg`, JWT access + refresh tokens with bcryptjs
  - security: Helmet, rate limiting, SSRF protection with ipaddr.js
  - linting: ESLint 9
  - the API is same-origin Express serving the Vite SPA
- **Testing:** don't write or run tests (unit, integration or browser) unless the owner asks. This
  overrides any skill that calls for TDD. Verify by linting, booting and running things for real.
- **Commits:** semantic messages (`feat:`, `fix:`, `chore:`, `docs:`), committed as you make
  progress.
- **Process:** start with the brainstorming skill, then write a design doc in
  `docs/superpowers/specs/`, get it approved, then write a plan in `docs/superpowers/plans/`.
  For build style the owner picked "native" last time: build inline, with one fresh reviewer for
  the whole branch at the end.
- **How to talk to them:** they write fast and informally. Keep questions short and give your
  recommendation. They prefer outcomes to process talk.
- **Before you act:** ask before outward-facing actions (new repos, DNS, deploys, emails) unless
  they've already said yes in this session. They have already approved Coolify deploys of Darkroom.
