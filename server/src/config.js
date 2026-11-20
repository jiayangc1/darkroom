import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (name, def) => {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number`);
  return n;
};

const list = (name, def) =>
  (env[name] ?? def)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Comma list that keeps case (Clerk user ids are case-sensitive). */
const rawList = (name) =>
  (env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const config = {
  port: int('PORT', 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://localhost/darkroom',
  publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  trustProxy: int('TRUST_PROXY', 1),
  uploadDir: env.UPLOAD_DIR || '/tmp/darkroom-uploads',
  allowHttpWebhooks: env.ALLOW_HTTP_WEBHOOKS === '1',
  bunny: {
    storageZone: env.BUNNY_STORAGE_ZONE || '',
    accessKey: env.BUNNY_STORAGE_KEY || '',
    // e.g. "la.storage.bunnycdn.com" (regional) or "storage.bunnycdn.com" (Falkenstein)
    storageHost: env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com',
    cdnBase: (env.BUNNY_CDN_BASE || '').replace(/\/$/, ''),
  },
  // Defaults; an account's `limits` jsonb overrides individual keys.
  limits: {
    bundleMaxBytes: int('LIMIT_BUNDLE_MAX_BYTES', 500 * 1024 ** 2),
    bundleMaxUnpackedBytes: int('LIMIT_BUNDLE_MAX_UNPACKED_BYTES', 2 * 1024 ** 3),
    bundleMaxFiles: int('LIMIT_BUNDLE_MAX_FILES', 20_000),
    maxDurationSec: int('LIMIT_MAX_DURATION_SEC', 600),
    maxWidth: int('LIMIT_MAX_WIDTH', 3840),
    maxHeight: int('LIMIT_MAX_HEIGHT', 2160),
    maxActiveJobs: int('LIMIT_MAX_ACTIVE_JOBS', 5),
    requestsPerMinute: int('LIMIT_REQUESTS_PER_MINUTE', 60),
    maxRenderMinutes: int('LIMIT_MAX_RENDER_MINUTES', 60),
    maxFps: int('LIMIT_MAX_FPS', 60),
    maxPixels: int('LIMIT_MAX_PIXELS', 3840 * 2160),
  },
  // Per-plan overrides of `limits`; an account's own `limits` jsonb still wins.
  planLimits: {
    waitlist: { maxActiveJobs: 0 },
    trial: { maxActiveJobs: 1, maxPixels: 1920 * 1080, maxDurationSec: 120, requestsPerMinute: 30 },
    paid: {},
    internal: {},
  },
  // Money is integer micro-USD ($1 = 1_000_000).
  pricing: {
    microPerSecond: int('PRICE_MICROUSD_PER_SECOND', 2500),
    minSeconds: int('PRICE_MIN_SECONDS', 15),
    tiers: [
      { maxPixels: 1920 * 1080, multiplier: 1 },
      { maxPixels: 2560 * 1440, multiplier: 2 },
      { maxPixels: Infinity, multiplier: 4 },
    ],
  },
  packs: [10, 25, 100],
  trialMicro: int('TRIAL_MICROUSD', 1_500_000),
  signupMode: env.SIGNUP_MODE === 'open' ? 'open' : 'waitlist',
  adminClerkUserIds: rawList('ADMIN_CLERK_USER_IDS'),
  clerk: {
    publishableKey: env.CLERK_PUBLISHABLE_KEY || '',
    secretKey: env.CLERK_SECRET_KEY || '',
    webhookSecret: env.CLERK_WEBHOOK_SIGNING_SECRET || '',
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  webDist: env.WEB_DIST || path.join(serverDir, '..', 'web', 'dist'),
  outputMaxBytes: int('OUTPUT_MAX_BYTES', 4 * 1024 ** 3),
  leaseSec: int('LEASE_SEC', 60),
  claimWaitSec: int('CLAIM_WAIT_SEC', 25),
  maxAttempts: int('MAX_ATTEMPTS', 3),
  retentionDays: int('OUTPUT_RETENTION_DAYS', 7),
  minRemotionVersion: env.MIN_REMOTION_VERSION || '4.0.0',
  egressAllowlist: list(
    'EGRESS_ALLOWLIST',
    'fonts.googleapis.com,fonts.gstatic.com,cdn.jsdelivr.net,unpkg.com,cdnjs.cloudflare.com',
  ),
};

export const accountLimits = (account) => ({
  ...config.limits,
  ...(config.planLimits[account?.plan] || {}),
  ...(account?.limits || {}),
});

export default config;
