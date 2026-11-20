import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import config from './config.js';

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Compare dotted versions; returns -1/0/1. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Validate an entry name and return it normalized (no leading "./"), or throw.
 * Shared rules with the worker's extractor.
 */
export function checkEntryName(name) {
  if (!name || name.includes('\0') || name.includes('\\')) throw new BundleError('bundle_invalid', `Bad entry name: ${JSON.stringify(name)}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new BundleError('bundle_invalid', `Absolute path in archive: ${name}`);
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new BundleError('bundle_invalid', `Path traversal in archive: ${name}`);
  return parts.join('/');
}

const VERSION_RE = /remotion_version\s*=\s*['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/;

/**
 * Stream a .tar.gz bundle without writing it out. Enforces type/name/size rules,
 * finds index.html at the root (or under a single top-level directory),
 * and reads the Remotion version from it.
 */
export async function inspectBundle(file, limits) {
  const extract = tar.extract();
  let totalBytes = 0;
  let fileCount = 0;
  const topDirs = new Set();
  const indexCandidates = new Map(); // normalized path -> html

  extract.on('entry', (header, stream, next) => {
    // The entry stream is destroyed with our error when we reject; never let that be unhandled.
    stream.on('error', () => {});
    try {
      if (header.type !== 'file' && header.type !== 'directory') {
        throw new BundleError('bundle_invalid', `Unsupported entry type "${header.type}" for ${header.name} (links are not allowed)`);
      }
      const name = checkEntryName(header.name);
      if (name) topDirs.add(name.split('/')[0]);
      if (header.type === 'file') {
        fileCount++;
        totalBytes += header.size || 0;
        if (fileCount > limits.bundleMaxFiles) throw new BundleError('bundle_too_large', `Bundle has more than ${limits.bundleMaxFiles} files`);
        if (totalBytes > limits.bundleMaxUnpackedBytes) throw new BundleError('bundle_too_large', `Bundle unpacks to more than ${limits.bundleMaxUnpackedBytes} bytes`);
      }
      const isIndex = header.type === 'file' && (name === 'index.html' || /^[^/]+\/index\.html$/.test(name));
      if (isIndex && header.size <= 1024 * 1024) {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          indexCandidates.set(name, Buffer.concat(chunks).toString('utf8'));
          next();
        });
        stream.on('error', next);
      } else {
        stream.on('end', () => next());
        stream.on('error', next);
        stream.resume();
      }
    } catch (err) {
      stream.resume();
      next(err);
    }
  });

  try {
    await pipeline(createReadStream(file), createGunzip(), extract);
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError('bundle_invalid', `Not a valid .tar.gz archive: ${err.message}`);
  }

  let html = indexCandidates.get('index.html');
  if (html === undefined && topDirs.size === 1) html = indexCandidates.get(`${[...topDirs][0]}/index.html`);
  if (html === undefined) throw new BundleError('bundle_invalid', 'index.html not found at the bundle root — upload the output folder of `npx remotion bundle`');

  const m = VERSION_RE.exec(html);
  if (!m) throw new BundleError('bundle_invalid', 'index.html has no remotion_version — is this a Remotion bundle?');
  const remotionVersion = m[1];
  if (compareVersions(remotionVersion, config.minRemotionVersion) < 0) {
    throw new BundleError('version_unsupported', `Remotion ${remotionVersion} is not supported; minimum is ${config.minRemotionVersion}`);
  }
  return { remotionVersion, totalBytes, fileCount };
}
