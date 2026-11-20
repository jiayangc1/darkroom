import config from '../config.js';

const { pricing } = config;

/** Price multiplier for an output size, by pixel count (orientation doesn't matter). */
export function tierMultiplier(pixels) {
  return pricing.tiers.find((t) => pixels <= t.maxPixels).multiplier;
}

/** Billed seconds for a video: whole seconds, at least the minimum. */
export const billedSeconds = (video) => Math.max(pricing.minSeconds, Math.ceil(video.frames / video.fps));

/** Exact cost of a render in micro-USD. `video` is the output size (after scale) and rendered frames. */
export function jobCostMicro(video) {
  return billedSeconds(video) * tierMultiplier(video.width * video.height) * pricing.microPerSecond;
}

/** The smallest possible charge: the minimum seconds at 1×. */
export const minCostMicro = () => pricing.minSeconds * pricing.microPerSecond;

/** Micro-USD → "0.1675" (USD, 4 decimals), or null. */
export function usd(micro) {
  if (micro === null || micro === undefined) return null;
  return (Number(micro) / 1e6).toFixed(4);
}

/** Public price sheet, used by the dashboard, MCP and docs. */
export function priceSheet() {
  return {
    currency: 'USD',
    perMinute: usd(pricing.microPerSecond * 60),
    minSeconds: pricing.minSeconds,
    tiers: pricing.tiers.map((t) => ({
      maxPixels: Number.isFinite(t.maxPixels) ? t.maxPixels : null,
      multiplier: t.multiplier,
    })),
    packs: config.packs,
  };
}
