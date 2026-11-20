const env = process.env;

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
  },
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

export const accountLimits = (account) => ({ ...config.limits, ...(account?.limits || {}) });

export default config;
