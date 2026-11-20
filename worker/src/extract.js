import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import tar from 'tar-stream';

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Same rules as server/src/bundle-inspect.js checkEntryName. */
function checkEntryName(name) {
  if (!name || name.includes('\0') || name.includes('\\')) throw new BundleError('bundle_invalid', `Bad entry name: ${JSON.stringify(name)}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new BundleError('bundle_invalid', `Absolute path in archive: ${name}`);
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new BundleError('bundle_invalid', `Path traversal in archive: ${name}`);
  return parts.join('/');
}

/**
 * Extract a bundle .tar.gz into destDir (must exist and be empty). Only regular files and
 * directories; never follows or creates links; never writes outside destDir.
 * Returns the directory containing index.html.
 */
export async function extract(archive, destDir, limits) {
  const root = path.resolve(destDir);
  const ex = tar.extract();
  let files = 0;
  let bytes = 0;

  ex.on('entry', (header, stream, next) => {
    stream.on('error', () => {});
    const done = (err) => {
      if (err) stream.resume();
      next(err);
    };
    (async () => {
      if (header.type !== 'file' && header.type !== 'directory') {
        throw new BundleError('bundle_invalid', `Unsupported entry type "${header.type}" for ${header.name}`);
      }
      const name = checkEntryName(header.name);
      const target = path.resolve(root, name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new BundleError('bundle_invalid', `Path escapes bundle: ${header.name}`);
      if (header.type === 'directory') {
        await mkdir(target, { recursive: true, mode: 0o755 });
        stream.resume();
        return;
      }
      files++;
      bytes += header.size || 0;
      if (files > limits.bundleMaxFiles) throw new BundleError('bundle_too_large', `Bundle has more than ${limits.bundleMaxFiles} files`);
      if (bytes > limits.bundleMaxUnpackedBytes) throw new BundleError('bundle_too_large', 'Bundle unpacks too large');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      // 'wx': fail on duplicates instead of overwriting.
      await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o644 }));
    })().then(() => done(), done);
  });

  try {
    await pipeline(createReadStream(archive), createGunzip(), ex);
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError('bundle_invalid', `Could not extract bundle: ${err.message}`);
  }

  if (existsSync(path.join(root, 'index.html'))) return root;
  const top = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  if (top.length === 1 && existsSync(path.join(root, top[0].name, 'index.html'))) return path.join(root, top[0].name);
  throw new BundleError('bundle_invalid', 'index.html not found at the bundle root');
}
