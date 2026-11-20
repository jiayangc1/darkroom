// MCP server over Streamable HTTP (stateless): the agent-facing twin of the /v1 REST API.
import express, { Router } from 'express';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import config, { accountLimits } from './config.js';
import { pool } from './db.js';
import { apiKeyAuth, keyRateLimit, HttpError } from './auth.js';
import * as repo from './jobs/repo.js';
import {
  createUpload, parseJobObject, submitFromUpload, getJobFor, listJobsFor, cancelJob,
} from './jobs/service.js';
import { availableMicro } from './billing/ledger.js';
import { priceSheet, usd } from './billing/pricing.js';
import { workerStatus, withLiveStatus } from './status.js';

const p = priceSheet();
const INSTRUCTIONS = `Darkroom renders finished Remotion bundles on a GPU and returns an mp4 URL.
Flow: create_upload → run its commands (bundle, then curl the .tar.gz to uploadUrl) → submit_render with the uploadId → poll get_job about every 10 s until status is done, failed or canceled. The mp4 is at outputUrl and is deleted after ${config.retentionDays} days.
Renders have no internet except ${config.egressAllowlist.join(', ')}. Put every other asset in the bundle with staticFile().
Price: $${p.perMinute} per video-minute at ≤1080p (2× at 1440p, 4× above), minimum ${p.minSeconds} s per job, billed per second; failed and canceled jobs are free. get_balance shows credit and limits.
Errors (error.code): network_blocked (asset host not allowed: bundle it), composition_not_found (check the composition id), limits_exceeded (too long, too large or fps too high for the plan), insufficient_credits (buy credits at ${config.publicBaseUrl}/app/billing), bundle_invalid (tar the *contents* of the bundle folder so index.html is at the root).`;

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (err) => {
  const error = err instanceof HttpError ? { code: err.code, message: err.message } : { code: 'internal', message: 'Internal error' };
  if (!(err instanceof HttpError)) console.error('[mcp]', err);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
};
const run = (fn) => async (args) => {
  try {
    return ok(await fn(args || {}));
  } catch (err) {
    return fail(err);
  }
};

function buildServer(account) {
  const server = new McpServer({ name: 'darkroom', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('create_upload', {
    title: 'Create bundle upload link',
    description:
      'Step 1. Returns a one-time uploadUrl (valid 15 min) and the shell commands to bundle the Remotion project and upload it with curl. ' +
      'The upload needs no API key. Then call submit_render with the uploadId.',
    inputSchema: {},
  }, run(async () => {
    const u = await createUpload(account);
    return {
      ...u,
      steps: [
        'npx remotion bundle <entry, e.g. src/index.ts> --out-dir build',
        'tar -czf bundle.tar.gz -C build .',
        u.curl,
      ],
    };
  }));

  server.registerTool('submit_render', {
    title: 'Render an uploaded bundle',
    description: 'Step 2. Queue a render of an uploaded bundle. Returns the job; poll get_job until it is done.',
    inputSchema: {
      uploadId: z.string().describe('uploadId from create_upload, after the curl upload succeeded'),
      composition: z.string().describe('Remotion composition id to render'),
      inputProps: z.record(z.string(), z.unknown()).optional().describe('Input props passed to the composition'),
      frameRange: z.tuple([z.number().int(), z.number().int()]).optional().describe('[start, end] frames, inclusive'),
      scale: z.number().optional().describe('Output scale, 0.25–4 (default 1)'),
      crf: z.number().int().optional().describe('h264 CRF 0–51 (lower = better quality, bigger file)'),
      webhookUrl: z.string().optional().describe('Public https URL to POST the job to when it finishes'),
    },
  }, run(async (args) => {
    const fields = await parseJobObject(args);
    return repo.toPublic(await submitFromUpload(account, fields));
  }));

  server.registerTool('get_job', {
    title: 'Get render job',
    description: 'Status, progress, cost and (when done) outputUrl of a job. Includes queue position and render-machine status while waiting.',
    inputSchema: { jobId: z.string() },
  }, run(async ({ jobId }) => {
    const job = await getJobFor(account.id, jobId);
    return withLiveStatus(repo.toPublic(job), job);
  }));

  server.registerTool('list_jobs', {
    title: 'List render jobs',
    description: 'Most recent jobs first. Pass `before` (a createdAt) to page back.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
      before: z.string().optional(),
    },
  }, run(async ({ limit, before }) => {
    const jobs = (await listJobsFor(account.id, { limit: limit || 20, before })).map(repo.toPublic);
    return { jobs, next: jobs.length ? jobs[jobs.length - 1].createdAt : null };
  }));

  server.registerTool('cancel_job', {
    title: 'Cancel render job',
    description: 'Cancel a queued or rendering job. Canceled jobs are free.',
    inputSchema: { jobId: z.string() },
  }, run(async ({ jobId }) => repo.toPublic(await cancelJob(account.id, jobId))));

  server.registerTool('get_balance', {
    title: 'Credit balance and limits',
    description: 'Plan, credit balance (USD), available balance after running jobs, limits, prices and render-machine status.',
    inputSchema: {},
  }, run(async () => {
    const acct = await repo.accountRow(account.id);
    const lim = accountLimits(acct);
    return {
      plan: acct.plan,
      balance: usd(acct.balance_micro),
      available: usd(await availableMicro(pool, acct.id)),
      limits: {
        maxDurationSec: lim.maxDurationSec, maxPixels: lim.maxPixels, maxFps: lim.maxFps, maxActiveJobs: lim.maxActiveJobs,
      },
      prices: p,
      worker: await workerStatus(),
      buyCredits: `${config.publicBaseUrl}/app/billing`,
    };
  }));

  return server;
}

const router = Router();
router.use(apiKeyAuth, keyRateLimit, express.json({ limit: '2mb' }));

router.post('/', async (req, res) => {
  const server = buildServer(req.account);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
router.get('/', notAllowed);
router.delete('/', notAllowed);

export default router;
